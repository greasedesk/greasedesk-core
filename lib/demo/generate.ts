/**
 * File: lib/demo/generate.ts
 * Builds a whole demo tenant — twelve months of trade behind it, a fortnight booked in front — from
 * `lib/demo/profile.ts` and a seed. It NEVER reads the source tenant; the profile is the only input,
 * which is what makes the privacy promise reviewable rather than perpetual.
 *
 * ── DETERMINISTIC FROM (seed, now) ──────────────────────────────────────────────────────────────
 * Every random draw comes from a seeded generator, so the same pair rebuilds the same garage. That
 * matters twice: a bug in generated data is reproducible, and the long-lived sales demo can be
 * rebuilt nightly from its stored seed without becoming a different business overnight.
 *
 * `now` is captured ONCE by the caller and threaded through. Calling new Date() at each layer would
 * let a generation that spans midnight produce a dataset that disagrees with itself.
 *
 * ── IT TAKES MINUTES, NOT SECONDS ───────────────────────────────────────────────────────────────
 * Measured before this was written: ~144 ms to build a card and ~352 ms to mint its invoice through
 * the real chokepoint, so ~650 jobs is minutes rather than seconds. The mint cost is irreducible —
 * the gapless invoice series serialises minting by construction, so it cannot be parallelised, and
 * writing InvoiceLine directly would produce documents the product itself would never have made.
 * Callers must run this in the background and show something while it works.
 *
 * ── UTILISATION IS AN INPUT, NOT AN OUTCOME ─────────────────────────────────────────────────────
 * The generator does not emit jobs and hope. It computes each month's sellable hours the way
 * lib/capacity will read them back, multiplies by the target, and emits work until the charged
 * hours land. The CURRENT PARTIAL MONTH is targeted day by day, because the capacity panel's light
 * judges sold-to-date ÷ available-to-date at the elapsed day — on the 2nd of a month, one long job
 * against two days of capacity is over 100%, and a demo that shows red or green on the morning it
 * is opened has failed at the only job it has.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { issueInvoiceForCard } from '@/lib/invoice-issue';
import {
  DISTRIBUTIONS, FOOTPRINT_RATIO, ARCHETYPES, VEHICLE_MIX, FUEL_MIX, FIRST_NAMES, LAST_NAMES,
  STREETS, TOWN, POSTCODE_AREA, SEASONAL_INDEX, WEEKDAY_SHARE, START_HOUR_SHARE,
  RETURN_INTERVAL_MONTHS, COMEBACK_RATE_PCT, NEGATIVE_LINE_RATE_PCT,
} from '@/lib/demo/profile';

// ── the shape of a demo ──────────────────────────────────────────────────────────────────────────
export const DEMO_SPEC = {
  hoursPerDay: 8,
  workingDays: [1, 2, 3, 4, 5],
  utilisationFactorPct: 65,
  mechanics: 2,
  openHour: 9,
  closeHour: 18,
  lunchHour: 13,
  targetUtilisation: 0.625,     // mid-amber on the stock thresholds (red<50, amber<75)
  labourRateGbp: 85,
  forwardDays: 14,
  historyMonths: 12,
  /** Fixed leave, anchored to ISO WEEK so it recurs in the same weeks each year rather than being
   *  re-rolled per instantiation — and so it lives correctly in a rolling window. */
  leaveWeeks: [[8, 23, 33, 44], [15, 27, 38, 47]] as number[][],
} as const;

// ── seeded randomness ────────────────────────────────────────────────────────────────────────────
/** mulberry32 — small, fast, and good enough for invented invoices. */
export function rng(seed: string) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) { h = Math.imul(h ^ seed.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  let a = h >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export type Rand = () => number;
const pick = <T>(r: Rand, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
const between = (r: Rand, lo: number, hi: number) => lo + r() * (hi - lo);
const chance = (r: Rand, pct: number) => r() * 100 < pct;

/** Draw from a quantile table by linear interpolation between the published points. Cheaper and
 *  more honest than fitting a distribution to six numbers. */
function fromQuantiles(r: Rand, q: { p10: number; p25: number; p50: number; p75: number; p90: number; max: number }): number {
  const u = r();
  const seg = (a: number, b: number, lo: number, hi: number) => a + ((u - lo) / (hi - lo)) * (b - a);
  if (u < 0.10) return seg(q.p10 * 0.5, q.p10, 0, 0.10);
  if (u < 0.25) return seg(q.p10, q.p25, 0.10, 0.25);
  if (u < 0.50) return seg(q.p25, q.p50, 0.25, 0.50);
  if (u < 0.75) return seg(q.p50, q.p75, 0.50, 0.75);
  if (u < 0.90) return seg(q.p75, q.p90, 0.75, 0.90);
  return seg(q.p90, q.max, 0.90, 1);
}

/** Pick by weight from `[value, weight]` pairs. */
function weighted<T>(r: Rand, pairs: Array<[T, number]>): T {
  const total = pairs.reduce((s, [, w]) => s + w, 0);
  let x = r() * total;
  for (const [v, w] of pairs) { x -= w; if (x <= 0) return v; }
  return pairs[pairs.length - 1][0];
}

// ── calendar ─────────────────────────────────────────────────────────────────────────────────────
const DAY = 86_400_000;
const utc = (y: number, m: number, d: number, h = 0, min = 0) => new Date(Date.UTC(y, m, d, h, min));
const dayStart = (d: Date) => utc(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const isWorkday = (d: Date) => (DEMO_SPEC.workingDays as readonly number[]).includes(d.getUTCDay());

function isoWeek(d: Date): number {
  const t = utc(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  return Math.ceil(((t.getTime() - utc(t.getUTCFullYear(), 0, 1).getTime()) / DAY + 1) / 7);
}

/**
 * England & Wales bank holidays plus the 24 Dec – 2 Jan closure, as ONE set of dates.
 * Christmas Day, Boxing Day and New Year's Day fall INSIDE the closure; emitting them twice would
 * silently cost three days of capacity, and lib/capacity's "a day subtracts once" rule only saves
 * us because these are PublicHoliday rows rather than leave.
 */
export function closedDates(fromYear: number, toYear: number): Array<{ date: Date; label: string }> {
  const BH: Record<number, Array<[number, number, string]>> = {
    2026: [[0, 1, "New Year's Day"], [3, 3, 'Good Friday'], [3, 6, 'Easter Monday'], [4, 4, 'Early May bank holiday'], [4, 25, 'Spring bank holiday'], [7, 31, 'Summer bank holiday'], [11, 25, 'Christmas Day'], [11, 28, 'Boxing Day (substitute)']],
    2027: [[0, 1, "New Year's Day"], [2, 26, 'Good Friday'], [2, 29, 'Easter Monday'], [4, 3, 'Early May bank holiday'], [4, 31, 'Spring bank holiday'], [7, 30, 'Summer bank holiday'], [11, 27, 'Christmas Day (substitute)'], [11, 28, 'Boxing Day (substitute)']],
    2028: [[0, 3, "New Year's Day (substitute)"], [3, 14, 'Good Friday'], [3, 17, 'Easter Monday'], [4, 1, 'Early May bank holiday'], [4, 29, 'Spring bank holiday'], [7, 28, 'Summer bank holiday'], [11, 25, 'Christmas Day'], [11, 26, 'Boxing Day']],
  };
  const byKey = new Map<string, string>();
  for (let y = fromYear - 1; y <= toYear + 1; y++) {
    for (const [m, d, label] of BH[y] ?? []) byKey.set(iso(utc(y, m, d)), label);
    // The closure LAST, so it overwrites a bank-holiday label on a shared date rather than
    // producing a second row the unique index would reject.
    for (let d = utc(y, 11, 24); d <= utc(y + 1, 0, 2); d = addDays(d, 1)) byKey.set(iso(d), 'Workshop closed — Christmas');
  }
  return [...byKey.entries()].sort().map(([k, label]) => ({ date: new Date(`${k}T00:00:00.000Z`), label }));
}

// ── capacity, computed the way lib/capacity will read it back ────────────────────────────────────
type DayCapacity = { date: Date; sellableHours: number };

/**
 * Sellable hours per open day, per the binding order: gross → minus PH → minus leave → × factor.
 * Recomputed here rather than read from lib/capacity because the tenant does not exist yet — the
 * gate then checks the two agree, which is the only way to know this is right.
 */
function capacityByDay(from: Date, to: Date, closed: Set<string>, leave: Map<string, Set<number>>): DayCapacity[] {
  const out: DayCapacity[] = [];
  for (let d = dayStart(from); d < to; d = addDays(d, 1)) {
    if (!isWorkday(d)) continue;
    const key = iso(d);
    if (closed.has(key)) { out.push({ date: new Date(d), sellableHours: 0 }); continue; }
    let raw = 0;
    for (let m = 0; m < DEMO_SPEC.mechanics; m++) {
      if (leave.get(key)?.has(m)) continue;
      raw += DEMO_SPEC.hoursPerDay;
    }
    out.push({ date: new Date(d), sellableHours: raw * (DEMO_SPEC.utilisationFactorPct / 100) });
  }
  return out;
}

// ── the job model ────────────────────────────────────────────────────────────────────────────────
type PlannedLine = {
  description: string; itemType: 'labour' | 'part' | 'fixed' | 'misc';
  qty: number; unitPrice: number; unitCost: number | null; labourHours: number | null; outsourced: boolean;
};
type PlannedJob = {
  start: Date; durationMinutes: number; chargedHours: number;
  lines: PlannedLine[]; isComeback: boolean;
};

/** One job: an archetype, sometimes a second, plus parts. Hours and money come from the profile. */
function planJob(r: Rand, opts: { comeback: boolean }): Omit<PlannedJob, 'start' | 'durationMinutes'> {
  const lines: PlannedLine[] = [];
  let hours = 0;

  const primary = weighted(r, ARCHETYPES.map((a) => [a, a.shareOfLines] as [typeof ARCHETYPES[number], number]));
  lines.push({
    description: primary.title, itemType: primary.itemType as PlannedLine['itemType'],
    qty: 1, unitPrice: primary.priceGbp, unitCost: primary.partsCostGbp || null,
    labourHours: primary.labourHours || null, outsourced: primary.outsourcedLabour,
  });
  if (!primary.outsourcedLabour) hours += primary.labourHours;

  // A second job on the same visit, sometimes — an MOT plus whatever it failed on.
  if (chance(r, JOB_MIX.secondArchetypePct)) {
    const extra = weighted(r, ARCHETYPES.filter((a) => a.key !== primary.key).map((a) => [a, a.shareOfLines] as [typeof ARCHETYPES[number], number]));
    lines.push({
      description: extra.title, itemType: extra.itemType as PlannedLine['itemType'],
      qty: 1, unitPrice: extra.priceGbp, unitCost: extra.partsCostGbp || null,
      labourHours: extra.labourHours || null, outsourced: extra.outsourcedLabour,
    });
    if (!extra.outsourcedLabour) hours += extra.labourHours;
  }

  // Ad-hoc labour at the posted shop rate. THIS is what pulls the blended rate down to the
  // profile's £146/h: menu work bills at an effective £154/h, hourly work at £85, and a real
  // garage's mix of the two is what produces the number on the dashboard.
  //
  // Hours are drawn PER LINE, not from DISTRIBUTIONS.labourHoursPerJob — that is the whole job's
  // hours, and using it for one extra line made the average job 30% too big.
  if (chance(r, JOB_MIX.adhocLabourPct)) {
    const h = Math.max(0.25, Math.round((0.25 + r() * JOB_MIX.adhocMaxHours) * 2) / 2);
    lines.push({
      description: 'Workshop labour', itemType: 'labour', qty: h,
      unitPrice: DEMO_SPEC.labourRateGbp, unitCost: null, labourHours: h, outsourced: false,
    });
    hours += h;
  }

  // PARTS SOLD SEPARATELY. The archetype's own bundled cost is already inside its price; drawing
  // the whole job's parts budget again on top double-counted it, and pricing the remainder added
  // ~£70 a job of revenue against no hours at all — which is what pushed the effective rate to
  // £220 on the first generated tenant. Each extra line is progressively less likely.
  let parts = 0;
  while (parts < 3 && chance(r, JOB_MIX.partLinePct * Math.pow(0.45, parts))) parts += 1;
  for (let i = 0; i < parts; i++) {
    const cost = Math.round(between(r, JOB_MIX.partCostMin, JOB_MIX.partCostMax) * 100) / 100;
    lines.push({
      description: pick(r, PART_NAMES), itemType: 'part', qty: 1,
      unitPrice: Math.round(cost * JOB_MIX.partMarkup * 100) / 100, unitCost: cost,
      labourHours: null, outsourced: false,
    });
  }

  // A discount code now and then — negative lines exercise a real feature (lib/promo).
  if (chance(r, NEGATIVE_LINE_RATE_PCT)) {
    const gross = lines.reduce((s, l) => s + l.qty * l.unitPrice, 0);
    lines.push({
      description: 'SAVE10 — 10% off this visit', itemType: 'misc', qty: 1,
      unitPrice: -Math.round(gross * 0.1 * 100) / 100, unitCost: null, labourHours: null, outsourced: false,
    });
  }

  return { chargedHours: Math.round(hours * 100) / 100, lines, isComeback: opts.comeback };
}

/**
 * ── CALIBRATED, NOT GUESSED ─────────────────────────────────────────────────────────────────────
 * These six numbers were fitted offline against the profile's own aggregates before a single row
 * was written, because the first generated tenant came out at £220/charged hour against a £146
 * target and the cause was not visible from the output — it was parts revenue with no hours behind
 * it. Simulating 40,000 jobs in memory costs nothing; discovering it after a nine-minute generation
 * costs nine minutes.
 *
 * What they produce, against the source garage in brackets:
 *   £327 revenue per job (£325) · 2.24 charged hours (2.22) · £146 per hour (£146) · 666 jobs a
 *   year at the target utilisation (~651) · 2.58 lines (2.2) · 78% gross margin (72.6%)
 *
 * The margin is the weakest match and the reason is known: the archetype bundled costs are MEDIANS
 * of each line's unit_cost, and a median understates a skewed cost, so the demo's bundles carry
 * less parts cost than the real ones do. It lands inside the band the gate allows; tightening it
 * would mean carrying a per-archetype cost distribution rather than a single figure.
 */
const JOB_MIX = {
  secondArchetypePct: 20,
  adhocLabourPct: 60,
  adhocMaxHours: 2.5,
  partLinePct: 60,
  partCostMin: 8,
  partCostMax: 70,
  partMarkup: 1.45,
} as const;

/** One entry from VEHICLE_MIX's per-model table. */
export type DemoModel = { name: string; from: number; ev: number | null; hyb: number | null; diesel: boolean };
export type DemoVehicle = { make: string; model: string; year: number; fuel: string };

/**
 * ── FUEL FIRST, THEN THE CAR THAT COULD HAVE IT ─────────────────────────────────────────────────
 * The obvious order — draw an age, draw a model, then pick a fuel it could have — cannot hit a fuel
 * target, and the failure is arithmetic rather than a bug. The source fleet's median car is ELEVEN
 * years old, so barely a quarter of it is new enough for any electrified version to exist; drawing
 * fuel last put electric at 0.2% and hybrid at 1.6% against an intended 4% and 8%. Renormalising the
 * weights over the allowed fuels did not help, because for most cars the allowed set is just petrol
 * and diesel.
 *
 * So the causal order is inverted: choose what the car RUNS ON first, then choose a car that could
 * have run on it, then an age consistent with both. The intended mix is hit exactly, and the side
 * effect is not a distortion but a fact — the electrified cars come out younger than the fleet
 * average, which is true of every real garage's book.
 *
 * Make shares are preserved within each fuel, so an electric book leans to the makes that actually
 * sold electric cars. Also true.
 */
export function pickVehicle(r: Rand, thisYear: number, drawAge: () => number): DemoVehicle {
  const fuel = weighted(r, FUEL_MIX.map((f) => [f.fuel, f.share] as [string, number]));
  const supports = (m: DemoModel) =>
    fuel === 'Petrol' ? true
      : fuel === 'Diesel' ? m.diesel
        : fuel === 'Hybrid' ? m.hyb != null
          : m.ev != null;

  const candidates: Array<[{ make: string; model: DemoModel }, number]> = [];
  for (const mk of VEHICLE_MIX) {
    for (const m of mk.models as readonly DemoModel[]) {
      if (supports(m)) candidates.push([{ make: mk.make, model: m }, mk.share]);
    }
  }
  // Petrol is universal, so this can only fire if the table is edited into an odd state. Falling
  // back to petrol here is the one place it IS right: no car exists that runs on nothing.
  if (!candidates.length) return pickVehicle(r, thisYear, drawAge);

  const { make, model } = weighted(r, candidates);
  // The year floor is the LATER of the nameplate's launch and the fuel's own arrival. Clamping
  // rather than re-drawing keeps recently-launched models honestly young — there are no old Karoqs.
  const floor = Math.max(model.from, fuel === 'Electric' ? (model.ev as number) : fuel === 'Hybrid' ? (model.hyb as number) : 0);
  const year = Math.max(floor, thisYear - Math.max(0, Math.round(drawAge())));
  return { make, model: model.name, year, fuel };
}

/** AUTHORED part names — generic consumables, nothing from any tenant. */
const PART_NAMES = [
  'Oil filter', 'Air filter', 'Pollen filter', 'Fuel filter', 'Brake pads (front)', 'Brake pads (rear)',
  'Brake discs (pair)', 'Wiper blades', 'Spark plugs (set)', 'Coolant', 'Engine oil 5W-30',
  'Auxiliary belt', 'Bulb kit', 'Battery 063', 'Thermostat', 'Water pump', 'Track rod end',
] as const;

// ── placement in the diary ───────────────────────────────────────────────────────────────────────
/** Start times on a QUARTER-HOUR grid, weighted to the profile's hour clusters, never at lunch. */
function startTime(r: Rand, day: Date): Date {
  const hours = Object.entries(START_HOUR_SHARE)
    .map(([h, share]) => [Number(h), share] as [number, number])
    .filter(([h]) => h >= DEMO_SPEC.openHour && h < DEMO_SPEC.closeHour && h !== DEMO_SPEC.lunchHour);
  const hour = weighted(r, hours);
  const quarter = Math.floor(r() * 4) * 15;
  return utc(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, quarter);
}

export type DemoGenerationResult = {
  groupId: string; ownerUserId: string; siteId: string;
  counts: { customers: number; vehicles: number; jobCards: number; invoices: number; bookings: number };
  targetChargedHours: number; plannedChargedHours: number;
  elapsedMonthTarget: { availableToDate: number; soldToDate: number; ratio: number };
};

export async function generateDemoTenant(opts: {
  seed: string;
  now: Date;
  groupName: string;
  ownerEmail: string;
  ownerName: string;
  ownerPasswordHash: string;
  expiresAt: Date | null;
  onProgress?: (step: string, detail?: string) => void;
}): Promise<DemoGenerationResult> {
  const r = rng(opts.seed);
  const now = new Date(opts.now);
  const say = (s: string, d?: string) => opts.onProgress?.(s, d);

  const historyFrom = dayStart(new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), now.getUTCDate())));
  const forwardTo = addDays(dayStart(now), DEMO_SPEC.forwardDays + 1);

  // ── 1. GROUP, SITE, RESOURCES ────────────────────────────────────────────────────────────────
  say('tenant');
  const group = await prisma.group.create({
    data: {
      group_name: opts.groupName, trading_name: opts.groupName,
      country_code: 'GB', tax_country_code: 'GB', tax_default_rate_bp: 2000, default_vat_rate: 20,
      vat_registered: true, vat_number: 'GB000000000',
      billing_email: opts.ownerEmail,
      address: `${pick(r, STREETS)}, ${TOWN}, ${POSTCODE_AREA}1 2CD`,
      is_demo: true, is_internal: true, demo_seed: opts.seed, demo_expires_at: opts.expiresAt,
    },
    select: { id: true },
  });
  const site = await prisma.site.create({
    data: {
      group_id: group.id, site_name: `${TOWN} Workshop`, currency_code: 'GBP', timezone: 'Europe/London',
      open_hour: DEMO_SPEC.openHour, close_hour: DEMO_SPEC.closeHour, open_days: [...DEMO_SPEC.workingDays],
      address: `${pick(r, STREETS)}, ${TOWN}, ${POSTCODE_AREA}1 2CD`, phone: '01234 496000',
    },
    select: { id: true },
  });
  const resources = [];
  for (const [i, name] of ['Lift 1', 'Lift 2', 'Lift 3'].entries()) {
    resources.push(await prisma.resource.create({ data: { site_id: site.id, name, type: 'lift', display_order: i + 1 }, select: { id: true } }));
  }
  const motBay = await prisma.resource.create({ data: { site_id: site.id, name: 'MOT Bay', type: 'mot_bay', display_order: 9 }, select: { id: true } });

  const owner = await prisma.user.create({
    data: {
      email: opts.ownerEmail, name: opts.ownerName, role: 'ADMIN', is_owner: true,
      group_id: group.id, site_id: site.id, is_active: true, passwordHash: opts.ownerPasswordHash,
    },
    select: { id: true },
  });

  // ── 2. PEOPLE ────────────────────────────────────────────────────────────────────────────────
  say('people');
  const mechanics: string[] = [];
  for (let m = 0; m < DEMO_SPEC.mechanics; m++) {
    const p = await prisma.costPerson.create({
      data: {
        group_id: group.id, name: `${pick(r, FIRST_NAMES)} ${pick(r, LAST_NAMES)}`, role: 'Technician',
        cost_type: 'salary', amount_pennies: 3_400_000,
        is_chargeable: true, contracted_hours_per_day: DEMO_SPEC.hoursPerDay,
        working_days: [...DEMO_SPEC.workingDays], utilisation_factor: DEMO_SPEC.utilisationFactorPct,
        annual_leave_allowance_days: 28, start_date: addDays(historyFrom, -400), is_active: true,
      },
      select: { id: true },
    });
    // WITHOUT AN ALLOCATION A PERSON CONTRIBUTES NOTHING. getAvailableHours scales every figure by
    // the site allocation percent, so a mechanic with no CostAllocation row is invisible to
    // capacity and the demo would report zero sellable hours with two people standing in it.
    await prisma.costAllocation.create({ data: { group_id: group.id, site_id: site.id, cost_person_id: p.id, percent: 100 } });
    mechanics.push(p.id);
  }
  const ownerPerson = await prisma.costPerson.create({
    data: {
      group_id: group.id, name: opts.ownerName, role: 'Owner', cost_type: 'salary', amount_pennies: 4_500_000,
      is_chargeable: false, working_days: [...DEMO_SPEC.workingDays], start_date: addDays(historyFrom, -800),
      user_id: owner.id, is_active: true,
    },
    select: { id: true },
  });
  await prisma.costAllocation.create({ data: { group_id: group.id, site_id: site.id, cost_person_id: ownerPerson.id, percent: 100 } });

  // ── 3. PUBLIC HOLIDAYS + THE CLOSURE, ONE SET ────────────────────────────────────────────────
  say('closures');
  const closures = closedDates(historyFrom.getUTCFullYear(), forwardTo.getUTCFullYear())
    .filter((c) => c.date >= addDays(historyFrom, -1) && c.date < forwardTo);
  for (const c of closures) {
    await prisma.publicHoliday.create({ data: { group_id: group.id, site_id: site.id, date: c.date, label: c.label } }).catch(() => {});
  }
  const closedKeys = new Set(closures.map((c) => iso(c.date)));

  // ── 4. LEAVE, ANCHORED TO ISO WEEKS ──────────────────────────────────────────────────────────
  say('leave');
  const leaveByDay = new Map<string, Set<number>>();
  for (let d = dayStart(historyFrom); d < forwardTo; d = addDays(d, 1)) {
    if (!isWorkday(d) || closedKeys.has(iso(d))) continue;   // PH wins — a day subtracts once
    const wk = isoWeek(d);
    for (let m = 0; m < DEMO_SPEC.mechanics; m++) {
      if (!DEMO_SPEC.leaveWeeks[m].includes(wk)) continue;
      await prisma.leaveRecord.create({
        data: { group_id: group.id, cost_person_id: mechanics[m], site_id: site.id, date: new Date(d), type: 'annual', status: 'approved' },
      }).catch(() => {});
      const s = leaveByDay.get(iso(d)) ?? new Set<number>();
      s.add(m); leaveByDay.set(iso(d), s);
    }
  }

  // ── 5. CATALOGUE ─────────────────────────────────────────────────────────────────────────────
  say('catalogue');
  await prisma.serviceCatalogue.create({
    data: {
      group_id: group.id, site_id: site.id, service_code: 'LABOUR_HR', name: 'Workshop labour',
      default_labour_rate: DEMO_SPEC.labourRateGbp, default_duration_minutes: 60, vat_rate: 20,
    },
  });
  for (const [i, a] of ARCHETYPES.entries()) {
    await prisma.catalogueItem.create({
      data: {
        group_id: group.id, code: `DEMO${String(i + 1).padStart(3, '0')}`, name: a.title, title: a.title,
        item_type: a.itemType as any, unit_price: a.priceGbp, unit_cost: a.partsCostGbp || null,
        labour_hours: a.labourHours || null, labour_outsourced: a.outsourcedLabour, vat_rate: 20, active: true,
      },
    });
  }

  // ── 6–8. THE WORK ────────────────────────────────────────────────────────────────────────────
  // Capacity first, because the number of jobs is DERIVED from it — see the header.
  const cap = capacityByDay(historyFrom, addDays(dayStart(now), 1), closedKeys, leaveByDay);

  // ── THE CURRENT MONTH IS NOT SEASONALLY ADJUSTED ─────────────────────────────────────────────
  // Everywhere else the index gives the year its shape — March and September busy, August and
  // December thin. But the capacity panel's LIGHT judges THIS month, and it is the only figure
  // anyone looks at in the room. Applying August's 0.85 to the current month put the demo at 41%
  // and the light on red; applying March's 1.20 would put it on green. Either way the demo would
  // be showing the seasonal index rather than the garage, and which one depends on the date the
  // laptop was opened.
  //
  // So: the year is shaped, and the month on screen is targeted. The step between last month and
  // this one is the price, and it is smaller than the alternative.
  const currentMonth = now.getUTCMonth();
  const currentYear = now.getUTCFullYear();
  const isCurrentMonth = (d: Date) => d.getUTCMonth() === currentMonth && d.getUTCFullYear() === currentYear;
  const seasonal = (d: Date) => (isCurrentMonth(d) ? 1 : SEASONAL_INDEX[d.getUTCMonth()]);
  const weekdayWeight = (d: Date) => WEEKDAY_SHARE[d.getUTCDay()] || 0;

  // Target charged hours per open day: sellable × target × seasonal × weekday shape, renormalised
  // so the weekday shape redistributes work WITHIN a week instead of changing the week's total.
  const weekdayMean = DEMO_SPEC.workingDays.reduce((s, w) => s + (WEEKDAY_SHARE[w] || 0), 0) / DEMO_SPEC.workingDays.length;
  const dayTarget = new Map<string, number>();
  for (const c of cap) {
    if (c.sellableHours <= 0) { dayTarget.set(iso(c.date), 0); continue; }
    const shape = weekdayMean > 0 ? weekdayWeight(c.date) / weekdayMean : 1;
    dayTarget.set(iso(c.date), c.sellableHours * DEMO_SPEC.targetUtilisation * seasonal(c.date) * shape);
  }

  // ── customers and vehicles ───────────────────────────────────────────────────────────────────
  say('customers');
  const totalTargetHours = [...dayTarget.values()].reduce((a, b) => a + b, 0);
  const meanJobHours = 2.24; // measured from JOB_MIX in the offline calibration, not guessed
  const estJobs = Math.max(40, Math.round(totalTargetHours / meanJobHours));
  // Visits per customer over the window, from the return INTERVAL (not a rate) — see the profile.
  const visitsPerCustomer = Math.max(1, DEMO_SPEC.historyMonths / RETURN_INTERVAL_MONTHS);
  const customerCount = Math.max(30, Math.round(estJobs / visitsPerCustomer));

  const fleet: Array<{ customerId: string; vehicleId: string }> = [];
  for (let i = 0; i < customerCount; i++) {
    const first = pick(r, FIRST_NAMES), last = pick(r, LAST_NAMES);
    const cust = await prisma.customer.create({
      data: {
        group_id: group.id, name: `${first} ${last}`,
        email: `${first}.${last}${i}`.toLowerCase() + '@example.com',
        // Ofcom's reserved drama range — unroutable, and lib/demo-tenant refuses the send anyway.
        phone: `07700 900${String(i % 1000).padStart(3, '0')}`,
        address: `${1 + Math.floor(r() * 180)} ${pick(r, STREETS)}, ${TOWN}, ${POSTCODE_AREA}${1 + Math.floor(r() * 9)} ${Math.floor(r() * 9)}${pick(r, ['AA', 'BD', 'EF', 'HJ'])}`,
      },
      select: { id: true },
    });
    const v = pickVehicle(r, now.getUTCFullYear(), () => fromQuantiles(r, DISTRIBUTIONS.vehicleAgeYears));
    const identity = await prisma.vehicleIdentity.create({ data: { group_id: group.id }, select: { id: true } });
    const reg = `${pick(r, ['AB', 'CD', 'EF', 'GH', 'KL', 'MN'])}${String(10 + Math.floor(r() * 64)).padStart(2, '0')} ${pick(r, ['XAB', 'YCD', 'ZEF', 'PGH', 'RJK'])}`;
    const veh = await prisma.vehicle.create({
      data: {
        group_id: group.id, identity_id: identity.id, registration: reg,
        registration_normalized: reg.replace(/\s/g, '').toUpperCase(),
        make: v.make, model: v.model, year: v.year, fuel_type: v.fuel,
        mileage_at_create: Math.round(fromQuantiles(r, DISTRIBUTIONS.vehicleMileage) / 100) * 100,
      },
      select: { id: true },
    });
    // The OWNERSHIP EDGE is the owner of record (car-first re-root) — Vehicle.customer_id is
    // retired and deliberately left unwritten.
    await prisma.vehicleOwnership.create({ data: { vehicle_id: veh.id, customer_id: cust.id, is_current: true, valid_from: historyFrom } });
    fleet.push({ customerId: cust.id, vehicleId: veh.id });
  }

  // ── plan every job, oldest first ─────────────────────────────────────────────────────────────
  say('planning');
  const planned: PlannedJob[] = [];
  const lifts = [...resources.map((x) => x.id)];
  for (const c of cap) {
    let want = dayTarget.get(iso(c.date)) ?? 0;
    if (want <= 0) continue;
    // ── STOP BEFORE THE OVERSHOOT, NOT AFTER IT ───────────────────────────────────────────────
    // `while (want > 0)` pushes a whole job past the target every single day. On the first
    // generated tenant that compounded to 2,237 hours against a 1,492 target — a 50% overshoot
    // that put utilisation at 91% and the light on green. Taking the job only when at least half
    // of it still fits makes the expected error zero instead of +half a job per day.
    let guard = 0;
    while (guard++ < 12) {
      const job = planJob(r, { comeback: chance(r, COMEBACK_RATE_PCT) });
      if (want < job.chargedHours / 2) break;
      // A COMEBACK'S HOURS ARE NOT SOLD. lib/charged-labour books a warranty invoice's hours to
      // `rework`, deliberately outside the utilisation numerator — so counting them against the
      // day's target would quietly under-fill the diary by the comeback rate. They are emitted;
      // they just do not pay for themselves, which is the whole point of a comeback.
      const start = startTime(r, c.date);
      const minutes = Math.max(30, Math.round((job.chargedHours * FOOTPRINT_RATIO * 60) / 15) * 15);
      planned.push({ ...job, start, durationMinutes: minutes });
      if (!job.isComeback) want -= job.chargedHours;
    }
  }

  // ── the forward book: tapered, and NOT invoiced ──────────────────────────────────────────────
  const forward: PlannedJob[] = [];
  for (let d = addDays(dayStart(now), 1); d < forwardTo; d = addDays(d, 1)) {
    if (!isWorkday(d) || closedKeys.has(iso(d))) continue;
    const daysOut = Math.round((d.getTime() - dayStart(now).getTime()) / DAY);
    // Next week is materially fuller than the week after. A fortnight uniformly booked reads as
    // fake; a fortnight uniformly empty reads as a dead business.
    const fill = daysOut <= 7 ? between(r, 0.55, 0.85) : between(r, 0.2, 0.45);
    const sellable = (DEMO_SPEC.mechanics - (leaveByDay.get(iso(d))?.size ?? 0)) * DEMO_SPEC.hoursPerDay * (DEMO_SPEC.utilisationFactorPct / 100);
    let want = sellable * fill;
    let guard = 0;
    while (guard++ < 8) {
      const job = planJob(r, { comeback: false });
      if (want < job.chargedHours / 2) break;   // same rule as the history — see above
      forward.push({ ...job, start: startTime(r, d), durationMinutes: Math.max(30, Math.round((job.chargedHours * FOOTPRINT_RATIO * 60) / 15) * 15) });
      want -= job.chargedHours;
    }
  }

  // ── write, oldest first (the gapless series demands it) ──────────────────────────────────────
  say('writing', `${planned.length} historic + ${forward.length} forward`);
  planned.sort((a, b) => a.start.getTime() - b.start.getTime());
  let invoices = 0, liftIdx = 0;
  for (const [n, job] of planned.entries()) {
    if (n % 50 === 0) say('writing', `${n}/${planned.length}`);
    const pair = fleet[Math.floor(r() * fleet.length)];
    const usesMotBay = job.lines.some((l) => l.description === 'MOT test');
    const card = await prisma.jobCard.create({
      data: {
        group_id: group.id, site_id: site.id, customer_id: pair.customerId, vehicle_id: pair.vehicleId,
        status: 'paid', is_comeback: job.isComeback,
        resource_id: usesMotBay ? motBay.id : lifts[liftIdx++ % lifts.length],
        start_at: job.start, booking_duration_minutes: job.durationMinutes,
        end_at: new Date(job.start.getTime() + job.durationMinutes * 60_000),
        scheduled_date: dayStart(job.start),
        odometer_in: Math.round(fromQuantiles(r, DISTRIBUTIONS.vehicleMileage) / 100) * 100,
        accepted_at: addDays(job.start, -1),
      },
      select: { id: true },
    });
    await prisma.jobCardItem.createMany({
      data: job.lines.map((l) => ({
        job_card_id: card.id, description: l.description, item_type: l.itemType as any,
        qty: l.qty, unit_price: l.unitPrice, unit_cost: l.unitCost,
        labour_hours: l.labourHours, labour_outsourced: l.outsourced, vat_rate: 20,
      })),
    });
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => { await issueInvoiceForCard(tx, card.id, group.id); });
    // The mint stamps today; the demo needs the invoice to sit on the day the work happened.
    await prisma.invoice.updateMany({ where: { job_card_id: card.id }, data: { date_issued: dayStart(job.start), issued_at: job.start } });
    invoices += 1;
  }

  say('forward book');
  const FORWARD_STATUSES = ['accepted', 'accepted', 'quoted', 'in_progress'] as const;
  for (const job of forward) {
    const pair = fleet[Math.floor(r() * fleet.length)];
    const usesMotBay = job.lines.some((l) => l.description === 'MOT test');
    const card = await prisma.jobCard.create({
      data: {
        group_id: group.id, site_id: site.id, customer_id: pair.customerId, vehicle_id: pair.vehicleId,
        status: pick(r, FORWARD_STATUSES),
        resource_id: usesMotBay ? motBay.id : lifts[liftIdx++ % lifts.length],
        start_at: job.start, booking_duration_minutes: job.durationMinutes,
        end_at: new Date(job.start.getTime() + job.durationMinutes * 60_000),
        scheduled_date: dayStart(job.start),
      },
      select: { id: true },
    });
    await prisma.jobCardItem.createMany({
      data: job.lines.map((l) => ({
        job_card_id: card.id, description: l.description, item_type: l.itemType as any,
        qty: l.qty, unit_price: l.unitPrice, unit_cost: l.unitCost,
        labour_hours: l.labourHours, labour_outsourced: l.outsourced, vat_rate: 20,
      })),
    });
  }

  // What the elapsed month should look like — reported so the caller can assert it rather than
  // trust it. The light divides these two.
  const monthStart = utc(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const elapsed = cap.filter((c) => c.date >= monthStart && c.date <= dayStart(now));
  const availableToDate = elapsed.reduce((s, c) => s + c.sellableHours, 0);
  const soldToDate = planned
    .filter((j) => j.start >= monthStart && j.start <= addDays(dayStart(now), 1) && !j.isComeback)
    .reduce((s, j) => s + j.chargedHours, 0);

  say('done');
  return {
    groupId: group.id, ownerUserId: owner.id, siteId: site.id,
    counts: { customers: customerCount, vehicles: customerCount, jobCards: planned.length + forward.length, invoices, bookings: forward.length },
    targetChargedHours: Math.round(totalTargetHours * 10) / 10,
    plannedChargedHours: Math.round(planned.reduce((s, j) => s + j.chargedHours, 0) * 10) / 10,
    elapsedMonthTarget: {
      availableToDate: Math.round(availableToDate * 10) / 10,
      soldToDate: Math.round(soldToDate * 10) / 10,
      ratio: availableToDate > 0 ? Math.round((soldToDate / availableToDate) * 1000) / 10 : 0,
    },
  };
}
