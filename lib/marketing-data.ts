/**
 * File: lib/marketing-data.ts
 * THE TWO LISTS, ASSEMBLED — one read for the page, one number for the badge.
 *
 * lib/marketing-lists holds the RULES and is pure. This holds the queries, so the rules stay
 * provable without a database and the badge cannot drift from the list it counts.
 */
import { prisma } from '@/lib/db';
import { openDueItemsForVehicle, dueLabel } from '@/lib/due-items';
import { getCurrentOwnerId } from '@/lib/vehicle-identity';
import {
  motBand, serviceDue, isUnactioned, contactRoute, noContactLabel,
  estimateRevenue, estimateMotRevenue, WINDOW_DAYS, MOT_EXEMPT_YEARS,
  type MotBand, type ServiceBand, type ContactRecord, type RevenueEstimate,
} from '@/lib/marketing-lists';

export type MarketingRow = {
  vehicleId: string;
  registration: string;
  vehicleDesc: string | null;
  customerName: string | null;
  /** ALWAYS shown. A phone call is not an electronic message and no opt-out covers it. */
  phone: string | null;
  canSms: boolean;
  canEmail: boolean;
  /** "No texts" / "No email" / "No electronic contact", or null when nothing is refused. */
  noContact: string | null;
  /** ISO date the thing is due, or null on the trigger band. Machine-readable — used as the
   *  contact record's `for_date`. NEVER rendered raw; see `dueLabel` below. */
  dueDate: string | null;
  /** The same fact in words, through lib/due-items::dueLabel — so a month-precision service
   *  interval reads "due by November 2026" and an MOT expiry reads "due by 21 August 2026". The
   *  page rendered `dueDate` directly and showed a garage "2026-11-01". */
  dueLabel: string | null;
  /** When DVSA last ANSWERED about this car, ISO — rendered through lib/mot-refresh::checkedLabel.
   *  Null on most of the fleet, which is not news and renders nothing. */
  motCheckedAt: string | null;
  /** What to show when there is no date — the item's own words. */
  triggerText: string | null;
  /** The whichever_first item showing on its date leg because no rate exists. */
  mileageLegUnevaluated: boolean;
  /** contacted | booked | declined | snoozed, or null when nobody has done anything. */
  state: string | null;
  /** HOW it went, when GreaseDesk sent it: sms | email | both. NULL means we do not know — a phone
   *  call, or a contact recorded before sending existed. Not a fifth state. */
  channel: string | null;
  unactioned: boolean;
};

export type MotList = {
  expired: MarketingRow[];
  due: MarketingRow[];
  /**
   * Cars we SHOULD have a date for and do not — registered before the current MOT-exempt window,
   * so an absent expiry is a gap rather than a fact. A list that silently omits them misrepresents
   * itself; counting a two-year-old car among them misrepresents it the other way.
   */
  missingMotDate: number;
  /** Cars whose age we do not know, so we cannot say whether the absence is a gap. Honest-null,
   *  counted separately rather than folded into either side. */
  unknownAge: number;
  /** New enough that having no MOT is CORRECT. Not a gap, and not reported as one. */
  tooNewForMot: number;
  fleet: number;
  revenue: RevenueEstimate;
  unactioned: number;
};

export type ServiceList = {
  dated: MarketingRow[];
  trigger: MarketingRow[];
  revenue: RevenueEstimate;
  unactioned: number;
};

/** This tenant's average invoice, EX-VAT, over the last twelve months. NULL with no history. */
export async function averageInvoicePennies(groupId: string, now: Date): Promise<number | null> {
  const from = new Date(now.getTime() - 365 * 86_400_000);
  const invoices = await prisma.invoice.findMany({
    where: { group_id: groupId, date_issued: { gte: from }, voided_at: null },
    select: { lines: { select: { line_total: true } } },
  });
  if (!invoices.length) return null;
  const p = (d: unknown) => Math.round(Number(d ?? 0) * 100);
  const total = invoices.reduce((a, inv) => a + inv.lines.reduce((b, l) => b + p(l.line_total), 0), 0);
  return Math.round(total / invoices.length);
}

/** A catalogue MOT price, if the garage sells one at a fixed price. NULL otherwise — see the tile. */
export async function motPricePennies(groupId: string): Promise<number | null> {
  const row = await prisma.serviceCatalogue.findFirst({
    where: { group_id: groupId, is_active: true, name: { contains: 'MOT', mode: 'insensitive' }, default_price: { not: null } },
    select: { default_price: true },
  });
  return row?.default_price != null ? Math.round(Number(row.default_price) * 100) : null;
}

type CustomerBits = {
  name: string | null; phone: string | null; phone_e164: string | null; email: string | null;
  sms_opt_out: boolean | null; email_opt_out: boolean | null;
};

async function ownerOf(vehicleId: string): Promise<CustomerBits | null> {
  const id = await getCurrentOwnerId(prisma as never, vehicleId);
  if (!id) return null;
  return prisma.customer.findUnique({
    where: { id },
    select: { name: true, phone: true, phone_e164: true, email: true, sms_opt_out: true, email_opt_out: true },
  });
}

const shape = (
  v: { id: string; registration: string; make: string | null; model: string | null; mot_checked_at?: Date | null },
  c: CustomerBits | null,
  due: {
    dueDate: Date | null; triggerText: string | null; mileageLegUnevaluated: boolean;
    /** Carried so the row's words come from dueLabel rather than being re-derived here. */
    basis?: 'date' | 'mileage' | 'next_service' | 'whichever_first';
    dueMileage?: number | null;
    precision?: 'day' | 'month';
  },
  rec: { state: string; forDate: Date; snoozeUntil: Date | null; createdAt: Date; channel?: string | null } | null,
  now: Date,
): MarketingRow => {
  const route = c ? contactRoute(c) : { sms: false, email: false, phone: null };
  return {
    vehicleId: v.id,
    registration: v.registration,
    vehicleDesc: [v.make, v.model].filter(Boolean).join(' ') || null,
    customerName: c?.name ?? null,
    phone: route.phone,
    canSms: route.sms,
    canEmail: route.email,
    noContact: c ? noContactLabel(c) : null,
    dueDate: due.dueDate ? due.dueDate.toISOString().slice(0, 10) : null,
    dueLabel: due.dueDate
      ? dueLabel({
          dueBasis: due.basis ?? 'date',
          dueDate: due.dueDate.toISOString().slice(0, 10),
          dueMileage: due.dueMileage ?? null,
          dueDatePrecision: due.precision ?? 'day',
        })
      : null,
    motCheckedAt: v.mot_checked_at ? v.mot_checked_at.toISOString() : null,
    triggerText: due.triggerText,
    mileageLegUnevaluated: due.mileageLegUnevaluated,
    state: rec?.state ?? null,
    channel: rec?.channel ?? null,
    unactioned: isUnactioned(
      { dueDate: due.dueDate },
      rec ? ({ reason: 'mot', forDate: rec.forDate, snoozeUntil: rec.snoozeUntil, createdAt: rec.createdAt } as ContactRecord) : null,
      now,
    ),
  };
};

export async function buildMotList(groupId: string, now: Date): Promise<MotList> {
  // A CAR UNDER THREE YEARS OLD HAS NO MOT BECAUSE IT NEEDS NONE. Counting those as a gap would
  // overstate what is missing — the first version of this line said "95 cars have no MOT date" when
  // 62 were genuine gaps, 6 were too new, and 27 had no year recorded at all. Three numbers, not one.
  const firstMotYear = now.getUTCFullYear() - MOT_EXEMPT_YEARS;
  const [vehicles, fleet, undated, contacts] = await Promise.all([
    prisma.vehicle.findMany({
      where: { group_id: groupId, mot_expiry: { not: null, lte: new Date(now.getTime() + WINDOW_DAYS * 86_400_000) } },
      select: { id: true, registration: true, make: true, model: true, mot_expiry: true, mot_checked_at: true },
      orderBy: { mot_expiry: 'asc' },
    }),
    prisma.vehicle.count({ where: { group_id: groupId } }),
    prisma.vehicle.findMany({ where: { group_id: groupId, mot_expiry: null }, select: { year: true } }),
    prisma.marketingContact.findMany({ where: { group_id: groupId, reason: 'mot' }, select: { vehicle_id: true, state: true, for_date: true, snooze_until: true, created_at: true, channel: true } }),
  ]);
  const byVehicle = new Map(contacts.map((c) => [c.vehicle_id, c]));

  const expired: MarketingRow[] = [], due: MarketingRow[] = [];
  for (const v of vehicles) {
    const band: MotBand | null = motBand(v.mot_expiry, now);
    if (!band) continue;
    const rec = byVehicle.get(v.id);
    const row = shape(v, await ownerOf(v.id),
      // A DVSA expiry is a real calendar day, so `day` is honest here and the label shows it.
      { dueDate: v.mot_expiry, triggerText: null, mileageLegUnevaluated: false, basis: 'date', precision: 'day' },
      rec ? { state: rec.state, forDate: rec.for_date, snoozeUntil: rec.snooze_until, createdAt: rec.created_at, channel: rec.channel } : null, now);
    (band === 'expired' ? expired : due).push(row);
  }

  const all = [...expired, ...due];
  return {
    expired, due, fleet,
    missingMotDate: undated.filter((v) => v.year != null && v.year < firstMotYear).length,
    tooNewForMot: undated.filter((v) => v.year != null && v.year >= firstMotYear).length,
    unknownAge: undated.filter((v) => v.year == null).length,
    // NO AVERAGE-INVOICE FIGURE HERE. An MOT is a fixed-price product, not an average job, and
    // multiplying the count by a £178 average would overstate this list threefold.
    revenue: estimateMotRevenue(all.length, await motPricePennies(groupId)),
    unactioned: all.filter((r) => r.unactioned).length,
  };
}

export async function buildServiceList(groupId: string, now: Date): Promise<ServiceList> {
  const vehicles = await prisma.vehicle.findMany({
    where: { group_id: groupId, due_items: { some: { closed_at: null } } },
    select: { id: true, registration: true, make: true, model: true },
  });
  const contacts = await prisma.marketingContact.findMany({
    where: { group_id: groupId, reason: 'service' },
    select: { vehicle_id: true, state: true, for_date: true, snooze_until: true, created_at: true, channel: true },
  });
  const byVehicle = new Map(contacts.map((c) => [c.vehicle_id, c]));

  const dated: MarketingRow[] = [], trigger: MarketingRow[] = [];
  for (const v of vehicles) {
    const items = await openDueItemsForVehicle(prisma, groupId, v.id);
    const cards = await prisma.jobCard.findMany({
      where: { vehicle_id: v.id, odometer_in: { not: null } },
      select: { odometer_in: true, created_at: true },
      orderBy: { created_at: 'asc' },
    });
    const readings = cards.map((c) => ({ date: c.created_at, miles: c.odometer_in as number }));
    const currentMiles = readings.length ? readings[readings.length - 1].miles : null;
    const hits = serviceDue(items, { now, currentMiles, readings });
    if (!hits.length) continue;

    const owner = await ownerOf(v.id);
    const rec = byVehicle.get(v.id);
    // ONE ROW PER CAR, not per finding: the garage makes one phone call. The soonest dated hit
    // represents the car; if there is none, its first trigger item does.
    const datedHits = hits.filter((h) => h.band === 'dated').sort((a, b) => (a.date as Date).getTime() - (b.date as Date).getTime());
    const pick = datedHits[0] ?? hits[0];
    const row = shape(v, owner, {
      dueDate: pick.date,
      triggerText: pick.band === 'trigger' ? pick.item.description : null,
      mileageLegUnevaluated: pick.mileageLegUnevaluated,
      basis: pick.item.dueBasis,
      dueMileage: pick.item.dueMileage,
      precision: pick.item.dueDatePrecision ?? 'day',
    }, rec ? { state: rec.state, forDate: rec.for_date, snoozeUntil: rec.snooze_until, createdAt: rec.created_at, channel: rec.channel } : null, now);
    (pick.band === 'dated' ? dated : trigger).push(row);
  }

  dated.sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)));
  const all = [...dated, ...trigger];
  return {
    dated, trigger,
    revenue: estimateRevenue(all.length, await averageInvoicePennies(groupId, now)),
    unactioned: all.filter((r) => r.unactioned).length,
  };
}

/**
 * THE BADGE. Unactioned cars across both lists — not the size of the lists.
 *
 * A count that never falls is one a garage stops seeing within a week; this one drops as the list
 * is worked and returns as the next car enters the window. See isUnactioned for what spends a
 * contact record.
 */
export async function marketingBadgeCount(groupId: string, now: Date): Promise<number> {
  const [mot, service] = await Promise.all([buildMotList(groupId, now), buildServiceList(groupId, now)]);
  return mot.unactioned + service.unactioned;
}
