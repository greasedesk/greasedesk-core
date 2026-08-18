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
import { toE164Digits } from '@/lib/contact-routes';
import { issueInvoiceForCard, issueWarrantyInvoiceForCard } from '@/lib/invoice-issue';
import { tServer } from '@/lib/server-i18n';
import { computeQuoteTotals, penniesToPounds } from '@/lib/quote-totals';
import { freezeQuoteVersion } from '@/lib/quote-version';
import { acceptQuote } from '@/lib/quote-acceptance';
import { dueDateFor } from '@/lib/account-terms';
import { MAGIC_LINK_DAYS } from '@/lib/magic-link';
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

/**
 * ── THE QUOTE BOOK ──────────────────────────────────────────────────────────────────────────────
 * A demo with no quotes reads "0 issued, 0 accepted" on the conversion tile, which is the one place
 * an owner looks to judge whether the product would tell them anything.
 *
 * 62% conversion: high enough to look like a business run properly, low enough that the tile is
 * worth opening. The lost work is split between an outright NO and the silence that is actually
 * more common — a quote nobody ever answers, which expires with its magic link.
 *
 * DECLINES SKEW EXPENSIVE. A timing chain gets turned down; an MOT does not. Weighting the decline
 * draw toward the big-ticket archetypes is what makes average declined value sit ABOVE average
 * accepted — the true and slightly uncomfortable shape of a garage's lost work.
 */
const QUOTE_MIX = {
  declinedPct: 14,
  expiredPct: 24,
  /**
   * OPEN IS A PIPELINE, NOT A SHARE OF THE YEAR. Sizing it as 8% of annual volume put 78 quotes
   * live at once — a garage turning fourteen jobs a week does not have seventy-eight unanswered
   * quotes, and it wrecked the dashboard: the conversion tile is period-scoped, so a current month
   * stuffed with unresolved cohort read 58 issued / 19 accepted / 32.8% against an annual 62%.
   *
   * A live quote is a few days old at most; anything older has been answered or has gone quiet.
   */
  openPipelineDays: 5,
  openPerDay: 2,
  /** …the remaining 62% are accepted and became the jobs the history already holds. */
  /**
   * ── HOW A GARAGE ACTUALLY GETS PAID ───────────────────────────────────────────────────────────
   * It does not release the car until the bill is settled, so retail work is paid ON COLLECTION and
   * there is no retail receivable. The old model was a taper on invoice age — 98% paid after three
   * weeks, 55% inside the first — which produced 27 open invoices across 27 DIFFERENT customers.
   * No customer owed twice. That is not a debtor ledger, it is a random draw, and read literally it
   * meant 27 cars sitting in the yard uncollected.
   *
   * A real debtor book has a shape: a handful of trade accounts on terms carrying nearly all of the
   * balance, and one or two cars invoiced yesterday that nobody has picked up yet.
   */
  /** Taxi firms, small van fleets, a local dealer — the ones who get an account. */
  accountCustomers: 4,
  /** Terms they are on. 30 days is the default in the trade; one gets 14 so it is not uniform. */
  accountTermsDays: [30, 30, 30, 14],
  /** Jobs a year each, versus ~1.1 for a retail customer. They must LOOK like the biggest names. */
  accountJobsPerYear: [46, 34, 27, 21],
  /** Cars invoiced in the last day or two and not yet collected. The only retail debt there is. */
  uncollectedCars: 2,
  /** A decline that gets a revised quote — the "let me sharpen my pencil" conversation. */
  supersedeAfterDeclinePct: 20,
  /**
   * AGREED BUT NOT IN THE DIARY — "yes, ring me to book it in". The quotes screen has a whole tab
   * for this and it read (0), which wastes the one thing that tab exists to catch: lib/quotes-list
   * calls it "the gap nothing else in the product catches — an accepted job with no lift and no
   * date is invisible on the diary and finished on the quotes list, so it can sit indefinitely".
   * A demo showing that queue empty teaches an owner the feature does nothing.
   */
  acceptedUnbooked: 4,
  /** Cheap routine work is accepted almost always; the decline draw avoids it. */
  rarelyDeclined: ['mot', 'service_minor', 'brake_fluid', 'valet'] as string[],
} as const;

// ── the job model ────────────────────────────────────────────────────────────────────────────────
type PlannedLine = {
  description: string; itemType: 'labour' | 'part' | 'fixed' | 'misc';
  qty: number; unitPrice: number; unitCost: number | null; labourHours: number | null; outsourced: boolean;
  /** The catalogue item this line came off, when it came off one. NOT decoration: lib/charged-labour
   *  treats a catalogue-linked line as costed by construction ("cost is known/inherited"), which is
   *  what lets a genuine £0 mean £0. An unlinked line with no cost is indistinguishable from one
   *  nobody has costed yet, and the P&L is right to flag it. */
  archetypeKey?: string;
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
    // THE REAL COST, ZERO INCLUDED. `|| null` was fixed in the catalogue last round and left here:
    // 275 invoice lines (243 diagnostics, 32 valets) went out with a null cost and 100% margin.
    qty: 1, unitPrice: primary.priceGbp, unitCost: primary.partsCostGbp,
    labourHours: primary.labourHours || null, outsourced: primary.outsourcedLabour,
    archetypeKey: primary.key,
  });
  if (!primary.outsourcedLabour) hours += primary.labourHours;

  // A second job on the same visit, sometimes — an MOT plus whatever it failed on.
  if (chance(r, JOB_MIX.secondArchetypePct)) {
    const extra = weighted(r, ARCHETYPES.filter((a) => a.key !== primary.key).map((a) => [a, a.shareOfLines] as [typeof ARCHETYPES[number], number]));
    lines.push({
      description: extra.title, itemType: extra.itemType as PlannedLine['itemType'],
      qty: 1, unitPrice: extra.priceGbp, unitCost: extra.partsCostGbp,
      labourHours: extra.labourHours || null, outsourced: extra.outsourcedLabour,
      archetypeKey: extra.key,
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
  counts: {
    customers: number; vehicles: number; jobCards: number; invoices: number; bookings: number;
    quotesAccepted: number; quotesDeclined: number; quotesExpired: number; quotesOpen: number;
    quotesUnbooked: number; quotesSuperseded: number;
  };
  targetChargedHours: number; plannedChargedHours: number;
  elapsedMonthTarget: { availableToDate: number; soldToDate: number; ratio: number };
};

/**
 * Prisma's 5s transaction default is sized for a request handler next to its database. This is a
 * bulk writer talking to a remote pooler for minutes at a stretch, and a slow patch on Neon killed
 * a run at card 550 of 810 with P2028 — nothing wrong with the work, just no patience for a stall.
 * The transactions themselves are unchanged: one acceptQuote, or one mint.
 */
const DEMO_TX = { maxWait: 30_000, timeout: 60_000 };

/**
 * A five-minute write against a serverless Postgres will meet a stall. Three consecutive runs died
 * mid-history — P1001 twice, P2028 once — while a 60-shot soak of the same endpoint came back clean
 * both pooled and direct, so these are transient drops on a long-lived connection rather than an
 * outage. Losing 550 cards of work to one of them is not a real failure mode, it is impatience.
 *
 * ONLY connection-class codes are retried, and only those:
 *   P1001 unreachable · P1002 timed out · P1017 server closed it · P2024 pool timeout · P2028 tx gone
 * A constraint violation, a gate refusal or a bad write is NOT retried — those are the generator
 * being wrong, and repeating them would just hide it.
 *
 * Callers pass an `already` probe where a repeat could duplicate. A mint that committed and then
 * lost its answer looks identical to one that never landed; the probe is what tells them apart, and
 * Invoice.job_card_id is @unique so the constraint catches anything the probe misses.
 */
const TRANSIENT = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2028']);

async function resilient<T>(
  what: string,
  fn: () => Promise<T>,
  opts: { already?: () => Promise<boolean>; tries?: number } = {},
): Promise<T | null> {
  const tries = opts.tries ?? 6;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      if (!TRANSIENT.has(e?.code) || attempt >= tries) throw e;
      // Did it actually land? If so this is a lost answer, not lost work.
      if (opts.already) {
        try { if (await opts.already()) return null; } catch { /* the probe is best-effort */ }
      }
      const backoff = Math.min(8_000, 400 * 2 ** (attempt - 1));
      console.log(`   … ${what}: ${e.code} on attempt ${attempt}, retrying in ${backoff}ms`);
      await new Promise((res) => setTimeout(res, backoff));
    }
  }
}

/** One demo customer's number: Ofcom's reserved mobile drama range, stable for a given index. */
const demoPhone = (i: number): string => `07700 900${String(i % 1000).padStart(3, '0')}`;

export async function generateDemoTenant(opts: {
  seed: string;
  now: Date;
  groupName: string;
  ownerEmail: string;
  ownerName: string;
  ownerPasswordHash: string;
  expiresAt: Date | null;
  /**
   * `is_demo` on the created tenant. DEFAULTS TRUE — the safety flag that makes sendNotification
   * refuse, keeps the tenant out of counts and commission, and puts it in the lifecycle sweep.
   *
   * FALSE is for a SALES DEMO that must actually send: demoSendDecision blocks every send from an
   * is_demo tenant, and its only exception compares the recipient to the owner's EMAIL — so an SMS,
   * whose recipient is a phone number, can never match. A demo that shows a text arriving cannot be
   * is_demo. That is safe here only because the generator seeds Ofcom's reserved drama range for
   * every customer number, so the data is unroutable independently of the flag.
   *
   * `is_internal` stays TRUE either way — it is what keeps the tenant out of tenant counts,
   * forecasts and commission, and those exclusions must not depend on the sending decision.
   */
  isDemo?: boolean;
  /** The tenant's own phone. Reps read it aloud: the SMS suffix says "To reply, call <this>". */
  groupPhone?: string;
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
      vat_registered: true, vat_number: 'GB482910733', company_number: '09461820',
      billing_email: opts.ownerEmail,
      address: `${pick(r, STREETS)}, ${TOWN}, ${POSTCODE_AREA}1 2CD`,
      is_demo: opts.isDemo ?? true, is_internal: true, demo_seed: opts.seed, demo_expires_at: opts.expiresAt,
      phone: opts.groupPhone ?? null,
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
  const catalogueIdByKey = new Map<string, string>();
  for (const [i, a] of ARCHETYPES.entries()) {
    const ci = await prisma.catalogueItem.create({
      data: {
        group_id: group.id, code: `DEMO${String(i + 1).padStart(3, '0')}`, name: a.title, title: a.title,
        item_type: a.itemType as any,
        unit_price: a.priceGbp,
        // A FIXED item's price is base_price_ex_vat — unit_price is not what the products screen
        // reads for it. Leaving it unset showed every service at "Base price £0.00 · Margin −£65".
        base_price_ex_vat: a.priceGbp,
        // ZERO, NOT NULL. `|| null` turned a legitimately-free cost into "uncosted", which is a
        // DATA-QUALITY WARNING with its own banner — two services tripped it. A £0 cost is a fact
        // (nothing is consumed doing a diagnostic); an absent cost is a gap somebody must fill.
        unit_cost: a.partsCostGbp,
        labour_hours: a.labourHours || null, labour_outsourced: a.outsourcedLabour, vat_rate: 20, active: true,
      },
      select: { id: true },
    });
    catalogueIdByKey.set(a.key, ci.id);
  }

  // ── OVERHEADS. A setup signal, and the P&L is thin without them. ─────────────────────────────
  for (const [name, pennies, period] of [
    ['Workshop rent', 2_200_00, 'monthly'], ['Business rates', 480_00, 'monthly'],
    ['Insurance', 310_00, 'monthly'], ['Utilities', 265_00, 'monthly'],
    ['Software & subscriptions', 145_00, 'monthly'], ['Waste disposal', 90_00, 'monthly'],
  ] as Array<[string, number, string]>) {
    const o = await prisma.overhead.create({
      data: { group_id: group.id, name, ex_vat_amount_pennies: pennies, vat_rate: 20, period: period as any, is_active: true },
      select: { id: true },
    });
    await prisma.costAllocation.create({ data: { group_id: group.id, site_id: site.id, overhead_id: o.id, percent: 100 } });
  }

  // ── PAYMENT METHODS, so a paid invoice can say HOW. ──────────────────────────────────────────
  const methods: Array<{ id: string; name: string; weight: number; instant: boolean }> = [];
  for (const [name, behaviour, weight, position] of [
    ['Card', 'instant', 65, 1], ['Cash', 'instant', 20, 2], ['Bank transfer', 'windowed', 15, 3],
  ] as Array<[string, string, number, number]>) {
    const pm = await prisma.paymentMethod.create({
      data: { group_id: group.id, name, behaviour: behaviour as any, position, active: true },
      select: { id: true },
    });
    methods.push({ id: pm.id, name, weight, instant: behaviour === 'instant' });
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
  // Generic trade names, same rule as the vehicle mix and the catalogue: the SHAPE is real, the
  // particulars are invented.
  const TRADE_NAMES = ['Northgate', 'Riverside', 'Kingsway', 'Fairlop', 'Bramley', 'Colwyn', 'Hartfield'];
  const TRADE_SUFFIXES = ['Taxis', 'Couriers', 'Plant Hire', 'Motors', 'Logistics', 'Contracts'];
  const totalTargetHours = [...dayTarget.values()].reduce((a, b) => a + b, 0);
  const meanJobHours = 2.24; // measured from JOB_MIX in the offline calibration, not guessed
  const estJobs = Math.max(40, Math.round(totalTargetHours / meanJobHours));
  // Visits per customer over the window, from the return INTERVAL (not a rate) — see the profile.
  const visitsPerCustomer = Math.max(1, DEMO_SPEC.historyMonths / RETURN_INTERVAL_MONTHS);
  const customerCount = Math.max(30, Math.round(estJobs / visitsPerCustomer));

  const fleet: Array<{ customerId: string; vehicleId: string; accountIdx: number | null }> = [];
  for (let i = 0; i < customerCount; i++) {
    // The first few are TRADE ACCOUNTS. Named as businesses, on terms, and given far more work
    // below — so on the customer list they read as the garage's biggest names rather than as
    // unusually loyal individuals who happen to pay late.
    const accountIdx = i < QUOTE_MIX.accountCustomers ? i : null;
    const first = pick(r, FIRST_NAMES), last = pick(r, LAST_NAMES);
    const tradingName = accountIdx !== null ? `${pick(r, TRADE_NAMES)} ${pick(r, TRADE_SUFFIXES)}` : null;
    const cust = await prisma.customer.create({
      data: {
        group_id: group.id, name: tradingName ?? `${first} ${last}`,
        ...(accountIdx !== null ? {
          account_terms_days: QUOTE_MIX.accountTermsDays[accountIdx % QUOTE_MIX.accountTermsDays.length],
          account_name: tradingName,
        } : {}),
        email: `${first}.${last}${i}`.toLowerCase() + '@example.com',
        // Ofcom's reserved drama range — unroutable by construction, so a demo tenant can never
        // text a real person even when it is is_demo = false and its sends are not blocked.
        //
        // BOTH COLUMNS. Writing only the raw `phone` made every demo customer UNREACHABLE by SMS:
        // reachabilityForJobCard resolves an SMS recipient from `phone_e164` ALONE, so quote-send's
        // `if (recipient)` skipped the send entirely and the screen said "the text couldn't be
        // sent" — with no NotificationLog row, because sendNotification was never called. Twilio was
        // never contacted. Derived through the same chokepoint the API write uses (toE164Digits),
        // never hand-formatted here.
        phone: demoPhone(i),
        phone_e164: toE164Digits(demoPhone(i), 'GB'),
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
    fleet.push({ customerId: cust.id, vehicleId: veh.id, accountIdx });
  }

  /**
   * WHO IS THIS JOB FOR? Retail customers come back about once a year; an account comes in most
   * weeks. Picking uniformly gave the busiest customer in the whole garage 8 jobs, which is not a
   * fleet — so accounts carry an explicit weight taken from their annual volume, and everyone else
   * shares what is left. The weights are relative, so this holds at any total job count.
   */
  const accountWeight = (idx: number) =>
    QUOTE_MIX.accountJobsPerYear[idx % QUOTE_MIX.accountJobsPerYear.length] * (DEMO_SPEC.historyMonths / 12);
  const fleetWeights = fleet.map((f) => (f.accountIdx === null ? 1 : accountWeight(f.accountIdx)));
  const weightTotal = fleetWeights.reduce((a, b) => a + b, 0);
  function pickOwner() {
    let x = r() * weightTotal;
    for (let i = 0; i < fleet.length; i++) { x -= fleetWeights[i]; if (x <= 0) return fleet[i]; }
    return fleet[fleet.length - 1];
  }

  // Consumed by the payment model below: the only retail invoices left open are the last couple of
  // cars nobody has collected yet. A count, not a probability — see the note at the payment model.
  let uncollectedLeft = QUOTE_MIX.uncollectedCars;

  // ── plan every job, oldest first ─────────────────────────────────────────────────────────────

  /** Write a card's lines AND persist the totals the product persists. */
  const writeLines = async (cardId: string, job: PlannedJob) => {
    await prisma.jobCardItem.createMany({
      data: job.lines.map((l) => ({
        job_card_id: cardId, description: l.description, item_type: l.itemType as any,
        qty: l.qty, unit_price: l.unitPrice, unit_cost: l.unitCost,
        vat_amount: Math.round(l.qty * l.unitPrice * 0.2 * 100) / 100,
        labour_hours: l.labourHours, labour_outsourced: l.outsourced, vat_rate: 20,
        catalogue_item_id: l.archetypeKey ? catalogueIdByKey.get(l.archetypeKey) ?? null : null,
      })),
    });
    // ── THE WIP TILE READS THE PERSISTED TOTALS, NOT THE LINES ────────────────────────────────
    // lib/wip values an open card from its LINES (lib/wip::wipLineValuesPennies), which the product
    // writes from computeQuoteTotals on every save. The generator wrote the lines and never those
    // columns, so 13 open cards carrying real estimates showed as £0.00 of work in progress.
    // Computed through the SAME chokepoint rather than summed here — the whole point of those
    // columns is that they ARE the quote chokepoint's answer.
    // FIELD NAMES MATTER MORE THAN THE CAST. The first version passed camelCase (itemType,
    // unitPrice, unitCost) into a chokepoint that takes item_type / unit_price_pennies /
    // unit_cost_pennies, and an `as any` swallowed it: every field arrived undefined, every total
    // came back zero, and 19 open cards carrying real estimates showed £0.00 of work in progress.
    // No cast here — if the shape drifts, the compiler says so.
    const totals = computeQuoteTotals(
      job.lines.map((l) => ({
        item_type: l.itemType,
        qty: l.qty,
        unit_price_pennies: Math.round(l.unitPrice * 100),
        unit_cost_pennies: l.unitCost == null ? null : Math.round(l.unitCost * 100),
        vatable: true,
      })),
      20, { vatRegistered: true },
    );
    await prisma.jobCard.update({
      where: { id: cardId },
      data: {
        vat_rate: new Prisma.Decimal(totals.vat_rate),
      },
    });
    return totals;
  };

  say('planning');
  const planned: PlannedJob[] = [];
  const lifts = [...resources.map((x) => x.id)];

  // ── THE CURRENT MONTH IS TARGETED CUMULATIVELY, NOT DAY BY DAY ───────────────────────────────
  // Per-day targeting has zero expected error and real variance, which is fine over 250 days and
  // useless over six. The light judges sold-to-date ÷ available-to-date at the elapsed day, so on
  // the 10th of a month it is dividing by six days: a run of generous roundings put the reference
  // tenant at 78.7% and the light on GREEN, in a month whose per-day targets all said 62.5%.
  //
  // Inside the current month the target therefore CORRECTS: each day asks for whatever brings the
  // running total back to the intended share of capacity so far, so the drift cannot accumulate.
  // Outside it, per-day is right — nobody looks at the ratio on 14 March last year.
  let monthSold = 0;
  let monthAvailable = 0;
  const monthStartForTarget = utc(now.getUTCFullYear(), now.getUTCMonth(), 1);

  for (const c of cap) {
    let want = dayTarget.get(iso(c.date)) ?? 0;
    if (c.date >= monthStartForTarget) {
      monthAvailable += c.sellableHours;
      const shouldHave = monthAvailable * DEMO_SPEC.targetUtilisation;
      want = Math.max(0, shouldHave - monthSold);
    }
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
      if (!job.isComeback) {
        want -= job.chargedHours;
        if (c.date >= monthStartForTarget) monthSold += job.chargedHours;
      }
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
    const pair = pickOwner();
    const usesMotBay = job.lines.some((l) => l.description === 'MOT test');
    const card = await prisma.jobCard.create({
      data: {
        group_id: group.id, site_id: site.id, customer_id: pair.customerId, vehicle_id: pair.vehicleId,
        // Starts at `quoted` so acceptQuote has a legal transition to make — the status table is
        // the authority and it will not invent a route the product does not allow. Advanced to
        // `paid` below, after the acceptance and the invoice.
        status: 'quoted', is_comeback: job.isComeback,
        resource_id: usesMotBay ? motBay.id : lifts[liftIdx++ % lifts.length],
        start_at: job.start, booking_duration_minutes: job.durationMinutes,
        end_at: new Date(job.start.getTime() + job.durationMinutes * 60_000),
        scheduled_date: dayStart(job.start),
        odometer_in: Math.round(fromQuantiles(r, DISTRIBUTIONS.vehicleMileage) / 100) * 100,
      },
      select: { id: true },
    });
    await writeLines(card.id, job);

    // ── QUOTE → ACCEPT, THROUGH THE REAL CHOKEPOINTS ──────────────────────────────────────────
    // Every job in the history was quoted before it was worked. Freezing a version and then calling
    // acceptQuote (rather than stamping accepted_at by hand) is what makes the conversion tile,
    // the acceptance date and the audit trail all agree — the tile reads a cohort of SENT versions
    // and the acceptances resolve through the same precedence the live tenant uses.
    const quotedAt = addDays(job.start, -(1 + Math.floor(r() * 3)));
    await freezeQuoteVersion({ groupId: group.id, jobCardId: card.id, vatRegistered: true, taxLabel: 'VAT' });
    await prisma.quoteVersion.updateMany({ where: { job_card_id: card.id }, data: { sent_at: quotedAt } });
    await resilient('accept', () => prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await acceptQuote(tx, {
        groupId: group.id, jobCardId: card.id, via: 'counter',
        actorUserId: owner.id, attested: null, at: quotedAt,
      });
    }, DEMO_TX), {
      already: async () => !!(await prisma.jobCard.findUnique({ where: { id: card.id }, select: { accepted_at: true } }))?.accepted_at,
    });
    // ── A COMEBACK MINTS A WARRANTY INVOICE, NOT A BILL ───────────────────────────────────────
    // The generator called the chargeable mint for every card, so 29 comebacks went out at full
    // retail — the exact opposite of the model (£0 revenue, parts cost still lands, hours booked
    // to rework and never sold). The two mints are separate functions and the CALLER chooses; this
    // one was not choosing. Texts resolved the same way jobcard-status resolves them.
    await resilient('mint', () => prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      if (job.isComeback) {
        await issueWarrantyInvoiceForCard(tx, card.id, group.id, {
          goodwill: tServer('en-GB', 'invoice', 'warrantyGoodwill'),
          noCharge: tServer('en-GB', 'invoice', 'warrantyLine'),
        });
      } else {
        await issueInvoiceForCard(tx, card.id, group.id);
      }
    }, DEMO_TX), {
      // The one place a blind retry could mint twice. One invoice per card, so its existence is the
      // whole answer — and the @unique on job_card_id backstops the probe.
      already: async () => (await prisma.invoice.count({ where: { job_card_id: card.id } })) > 0,
    });
    // The mint stamps today; the demo needs the invoice to sit on the day the work happened.
    //
    // AND THE DUE DATE MOVES WITH IT. due_date froze correctly at the mint — today plus the terms —
    // but a year of history that all falls due next month is not a debtor book, and nothing in it
    // could ever be late. Backdating the document date without re-deriving the date that hangs off
    // it left every account invoice due in September; the gate caught it as zero overdue.
    // Re-derived through the SAME function the product uses, so the relationship the product
    // guarantees still holds on every row the demo writes.
    const backdated = dayStart(job.start);
    await prisma.invoice.updateMany({
      where: { job_card_id: card.id },
      data: {
        date_issued: backdated, issued_at: job.start,
        ...(pair.accountIdx !== null
          ? { due_date: dueDateFor({ account_terms_days: QUOTE_MIX.accountTermsDays[pair.accountIdx % QUOTE_MIX.accountTermsDays.length] }, backdated) }
          : {}),
      },
    });

    await prisma.jobCard.update({ where: { id: card.id }, data: { status: 'paid' } });

    // ── AND THEN IT GETS PAID, because a workshop takes the money when the car goes ────────────
    // Every invoice left at `issued` is a debtor. Minting 800 and paying none put £229,835 of
    // receivables on a garage with a full diary, which is not a business anyone recognises.
    //
    // Warranty invoices are SKIPPED: the mint lands them at `settled` — £0, closed, never AR — and
    // marking one paid would contradict the goodwill model.
    const inv = await prisma.invoice.findFirst({
      where: { job_card_id: card.id }, select: { id: true, series: true, status: true },
    });
    if (inv && inv.series !== 'warranty') {
      const ageDays = Math.round((dayStart(now).getTime() - dayStart(job.start).getTime()) / DAY);
      const onAccount = pair.accountIdx !== null;
      const terms = onAccount
        ? QUOTE_MIX.accountTermsDays[pair.accountIdx! % QUOTE_MIX.accountTermsDays.length]
        : null;

      /**
       * ── PAID ON COLLECTION, OR ON TERMS. THERE IS NO THIRD KIND. ─────────────────────────────
       * RETAIL: the car is not released until the bill is settled, so payment lands the SAME DAY,
       * full stop. The only retail exception is a car invoiced in the last day or two that nobody
       * has picked up yet — which is why `uncollectedCars` is a small count of recent jobs and not
       * a probability sprinkled across the year. An old unpaid retail invoice would mean a car
       * abandoned in the yard since March.
       *
       * ACCOUNT: pays on terms, so anything invoiced within the terms window is still legitimately
       * open. Most settle a few days either side of the due date; one in six runs late, because a
       * debtor book with nobody late in it is not a debtor book.
       */
      let paidOn: Date | null = null;
      let late = false;
      if (onAccount) {
        // Days from invoice to payment: usually around the terms, sometimes over.
        late = chance(r, 17);
        const lag = late ? terms! + 5 + Math.floor(r() * 25) : Math.max(2, terms! - 6 + Math.floor(r() * 10));
        if (lag <= ageDays) paidOn = addDays(dayStart(job.start), lag);
        // lag > ageDays → still within terms, still open. That IS the debtor book.
      } else {
        // Retail: same day, unless this is one of the last few cars still on the forecourt.
        const uncollected = ageDays <= 2 && uncollectedLeft > 0;
        if (uncollected) { uncollectedLeft -= 1; } else { paidOn = dayStart(job.start); }
      }

      if (paidOn) {
        // An account settles by transfer; a retail customer hands over cash or a card at the desk.
        const pool = onAccount ? methods.filter((x) => !x.instant) : methods.filter((x) => x.instant);
        const usable = pool.length ? pool : methods;
        const m = weighted(r, usable.map((x) => [x, x.weight] as [typeof methods[number], number]));
        // Never in the future, or the demo shows a payment that has not happened yet.
        if (paidOn.getTime() > dayStart(now).getTime()) paidOn = dayStart(now);
        await prisma.invoice.update({
          where: { id: inv.id },
          data: {
            status: 'paid', paid_at: paidOn, date_paid: paidOn,
            payment_method_id: m.id, payment_method_snapshot: m.name,
          },
        });
      }
    }
    invoices += 1;
  }

  // ── THE LOST WORK ────────────────────────────────────────────────────────────────────────────
  // Quotes that never became jobs: the declines, and the larger pile nobody ever answered. Sized
  // against the accepted history so the conversion rate is a consequence of the mix rather than a
  // number written on the tile.
  say('quotes');
  const acceptedCount = planned.length;
  const lostTarget = Math.round(acceptedCount * (QUOTE_MIX.declinedPct + QUOTE_MIX.expiredPct) / 62)
    + QUOTE_MIX.openPipelineDays * QUOTE_MIX.openPerDay;
  const declinedTarget = Math.round(acceptedCount * QUOTE_MIX.declinedPct / 62);
  const expiredTarget = Math.round(acceptedCount * QUOTE_MIX.expiredPct / 62);
  let declinedMade = 0, expiredMade = 0, openMade = 0, supersededMade = 0;

  for (let n = 0; n < lostTarget; n++) {
    const outcome = n < declinedTarget ? 'declined' : n < declinedTarget + expiredTarget ? 'expired' : 'open';
    // An OPEN quote is DAYS old, not months. Anything older has been answered or has gone quiet,
    // and the quotes screen's own framing agrees: awaiting is "the chase list".
    // AN EXPIRED QUOTE HAS TO BE PAST ITS LINK. Expiry is derived from sent_at + MAGIC_LINK_DAYS,
    // so dating one 3 days ago does not make it expired — it makes it awaiting, and 12 of them
    // quietly inflated the chase list past what a garage this size would ever hold. The floor is
    // the link lifetime itself, read from lib/magic-link rather than typed as 14 here.
    const daysBack = outcome === 'open'
      ? Math.floor(r() * QUOTE_MIX.openPipelineDays)
      : outcome === 'expired'
        ? MAGIC_LINK_DAYS + 1 + Math.floor(r() * 330)
        : 1 + Math.floor(r() * 350);
    let quotedAt = addDays(dayStart(now), -daysBack);
    while (!isWorkday(quotedAt) || closedKeys.has(iso(quotedAt))) quotedAt = addDays(quotedAt, -1);

    // Declines skew expensive: draw until we get something worth turning down.
    let job = planJob(r, { comeback: false });
    if (outcome === 'declined') {
      for (let attempt = 0; attempt < 6; attempt++) {
        if (!job.lines.some((l) => l.archetypeKey && QUOTE_MIX.rarelyDeclined.includes(l.archetypeKey))) break;
        job = planJob(r, { comeback: false });
      }
    }

    const pair = pickOwner();
    const card = await prisma.jobCard.create({
      data: {
        group_id: group.id, site_id: site.id, customer_id: pair.customerId, vehicle_id: pair.vehicleId,
        status: 'quoted', created_at: quotedAt,
      },
      select: { id: true },
    });
    const full: PlannedJob = { ...job, start: quotedAt, durationMinutes: 60 };
    await writeLines(card.id, full);
    await freezeQuoteVersion({ groupId: group.id, jobCardId: card.id, vatRegistered: true, taxLabel: 'VAT' });

    if (outcome === 'declined') {
      // ONE IN FIVE DECLINES GETS A SECOND GO — the "let me sharpen my pencil" conversation, which
      // is also the only thing in the demo that exercises supersession. Freezing again mints v2 and
      // marks v1 superseded through the chokepoint's own rule, rather than writing the status here.
      if (chance(r, QUOTE_MIX.supersedeAfterDeclinePct)) {
        await prisma.jobCardItem.updateMany({
          where: { job_card_id: card.id, item_type: 'labour' },
          data: { unit_price: Math.round(DEMO_SPEC.labourRateGbp * 0.9 * 100) / 100 },
        });
        await freezeQuoteVersion({ groupId: group.id, jobCardId: card.id, vatRegistered: true, taxLabel: 'VAT' });
        supersededMade += 1;
      }
      const live = await prisma.quoteVersion.findFirst({
        where: { job_card_id: card.id }, orderBy: { version: 'desc' }, select: { id: true },
      });
      await prisma.quoteVersion.update({
        where: { id: live!.id },
        data: { status: 'declined', responded_at: addDays(quotedAt, 1 + Math.floor(r() * 5)) },
      });
      // THE CARD STAYS `quoted`. Cancelling it is a different act — the garage withdrawing the
      // offer — and it is in QUOTE_CLOSED_CARD_STATUSES, so it removed all 173 declines from the
      // Declined tab. lib/quotes-list is explicit that a decline "stays visible (a follow-up
      // opportunity, not a dead record)"; closing the card contradicts that.
      declinedMade += 1;
    } else {
      // EXPIRED IS DERIVED, NOT STORED. lib/quotes-list computes it from sent_at + the magic-link
      // lifetime, so an expired quote is simply an old `sent` one — writing a status would put a
      // second definition of expiry in the database.
      if (outcome === 'expired') expiredMade += 1; else openMade += 1;
    }
    // The version's own sent date is the quote date, not the moment the generator ran.
    await prisma.quoteVersion.updateMany({ where: { job_card_id: card.id }, data: { sent_at: quotedAt } });
  }
  // ── AGREED, NOT YET BOOKED ───────────────────────────────────────────────────────────────────
  // Deliberately NO resource_id, start_at or end_at: isBookedCard needs all three, and their
  // absence is the entire point — this is work the garage has won and not yet put on a lift.
  let unbookedMade = 0;
  for (let n = 0; n < QUOTE_MIX.acceptedUnbooked; n++) {
    const pair = pickOwner();
    const job = planJob(r, { comeback: false });
    let quotedAt = addDays(dayStart(now), -(2 + Math.floor(r() * 12)));
    while (!isWorkday(quotedAt) || closedKeys.has(iso(quotedAt))) quotedAt = addDays(quotedAt, -1);
    const card = await prisma.jobCard.create({
      data: {
        group_id: group.id, site_id: site.id, customer_id: pair.customerId, vehicle_id: pair.vehicleId,
        status: 'quoted', created_at: quotedAt,
      },
      select: { id: true },
    });
    await writeLines(card.id, { ...job, start: quotedAt, durationMinutes: 60 });
    await freezeQuoteVersion({ groupId: group.id, jobCardId: card.id, vatRegistered: true, taxLabel: 'VAT' });
    await prisma.quoteVersion.updateMany({ where: { job_card_id: card.id }, data: { sent_at: quotedAt } });
    await resilient('accept-unbooked', () => prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await acceptQuote(tx, {
        groupId: group.id, jobCardId: card.id, via: 'counter',
        actorUserId: owner.id, attested: null, at: addDays(quotedAt, 1),
      });
    }, DEMO_TX), {
      already: async () => !!(await prisma.jobCard.findUnique({ where: { id: card.id }, select: { accepted_at: true } }))?.accepted_at,
    });
    unbookedMade += 1;
  }

  say('quotes', `${acceptedCount} accepted, ${declinedMade} declined, ${expiredMade} expired, ${openMade} open, ${unbookedMade} agreed-unbooked, ${supersededMade} superseded`);

  say('forward book');
  const FORWARD_STATUSES = ['accepted', 'accepted', 'quoted', 'in_progress'] as const;
  for (const job of forward) {
    const pair = pickOwner();
    const usesMotBay = job.lines.some((l) => l.description === 'MOT test');
    // Chosen BEFORE the create so the acceptance below knows what it is building. The card always
    // starts `quoted` — acceptQuote needs a legal transition and the status table is the authority.
    const status = pick(r, FORWARD_STATUSES);
    const card = await prisma.jobCard.create({
      data: {
        group_id: group.id, site_id: site.id, customer_id: pair.customerId, vehicle_id: pair.vehicleId,
        status: 'quoted',
        resource_id: usesMotBay ? motBay.id : lifts[liftIdx++ % lifts.length],
        start_at: job.start, booking_duration_minutes: job.durationMinutes,
        end_at: new Date(job.start.getTime() + job.durationMinutes * 60_000),
        scheduled_date: dayStart(job.start),
      },
      select: { id: true },
    });
    await writeLines(card.id, job);

    // ── THE FORWARD BOOK IS AGREED WORK, AND HAS TO LOOK LIKE IT ──────────────────────────────
    // Without a quote version these cards are invisible to the quotes screen, so "Accepted &
    // booked (0)" sat next to a diary with a fortnight in it. The ones that are accepted or under
    // way get a frozen version and a real acceptance; the ones still `quoted` stay in the chase
    // list, which is where a quote awaiting an answer belongs.
    await freezeQuoteVersion({ groupId: group.id, jobCardId: card.id, vatRegistered: true, taxLabel: 'VAT' });
    const sentAt = addDays(dayStart(now), -(1 + Math.floor(r() * 6)));
    await prisma.quoteVersion.updateMany({ where: { job_card_id: card.id }, data: { sent_at: sentAt } });
    if (status !== 'quoted') {
      await resilient('accept-forward', () => prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await acceptQuote(tx, {
          groupId: group.id, jobCardId: card.id, via: 'booked',
          actorUserId: owner.id, attested: null, at: sentAt,
        });
      }, DEMO_TX), {
        already: async () => !!(await prisma.jobCard.findUnique({ where: { id: card.id }, select: { accepted_at: true } }))?.accepted_at,
      });
      if (status === 'in_progress') {
        await prisma.jobCard.update({ where: { id: card.id }, data: { status: 'in_progress' } });
      }
    }
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
    counts: { customers: customerCount, vehicles: customerCount, jobCards: planned.length + forward.length, invoices, bookings: forward.length,
      quotesAccepted: acceptedCount, quotesDeclined: declinedMade, quotesExpired: expiredMade,
      quotesOpen: openMade, quotesUnbooked: unbookedMade, quotesSuperseded: supersededMade },
    targetChargedHours: Math.round(totalTargetHours * 10) / 10,
    plannedChargedHours: Math.round(planned.reduce((s, j) => s + j.chargedHours, 0) * 10) / 10,
    elapsedMonthTarget: {
      availableToDate: Math.round(availableToDate * 10) / 10,
      soldToDate: Math.round(soldToDate * 10) / 10,
      ratio: availableToDate > 0 ? Math.round((soldToDate / availableToDate) * 1000) / 10 : 0,
    },
  };
}
