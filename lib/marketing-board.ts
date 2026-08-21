/**
 * File: lib/marketing-board.ts
 * THE BOARD — one row per car, its signals gathered, its stack computed.
 *
 * Replaces the two-tab MOT/service split. A garage makes ONE phone call about a car, so the car is
 * the row and every reason it is worth ringing about travels with it. The old shape could put the
 * same car in both tabs and say neither thing to whoever rang.
 *
 * ── NO MONEY IN THIS SHAPE AT ALL ───────────────────────────────────────────────────────────────
 * Not "money the caller may not see" — none. The board it replaces rendered the tenant's average
 * job value to a STANDARD mechanic with no check of any kind, because the page never consulted
 * financeVisibility. The fix is not a gate on a field: it is that this builder has no field to
 * gate. When value arrives it arrives shaped by financeVisibility server-side, as the diary does.
 */
import { prisma } from '@/lib/db';
import { motBand, contactRoute, noContactLabel, isUnactioned, serviceDue, WINDOW_DAYS, type ContactRecord } from '@/lib/marketing-lists';
import { batteryState, type BatteryState } from '@/lib/battery';
import { leadStack, unansweredPrompt, type Stack, type LeadReason } from '@/lib/marketing-pipeline';

export type BoardRow = {
  vehicleId: string;
  registration: string;
  vehicleDesc: string | null;
  customerName: string | null;
  /** ALWAYS present, for every role. No opt-out covers a phone call and no role gate covers ringing. */
  phone: string | null;
  canSms: boolean;
  canEmail: boolean;
  noContact: string | null;
  /** What the garage last did about this car. */
  state: string | null;
  channel: string | null;
  /** When DVSA last ANSWERED about this car — the row's own freshness. See lib/mot-refresh. */
  motCheckedAt: string | null;
  /** The trigger a contact record is recorded against. Machine-readable; never rendered raw. */
  dueDate: string | null;
  /** Why it is where it is, strongest first. */
  reasons: LeadReason[];
  stack: Stack;
};

export type Board = {
  hot: BoardRow[];
  warm: BoardRow[];
  later: BoardRow[];
  /** A COUNT, not a value. See lib/marketing-pipeline for why there is no figure here. */
  fleet: number;
  /**
   * HOT AND NOT YET RUNG — what the nav badge counts.
   *
   * Not the same question as the stack. The STACK is about the car's condition: an expired MOT is
   * still an expired MOT after you have left a voicemail, so `contacted` does not push a car out
   * of Hot and should not. The BADGE is about outstanding work, and a car you rang this morning is
   * not outstanding this afternoon — so it falls on contact while the row stays where it is,
   * marked with what was done.
   *
   * Getting these the same way round would produce one of two familiar failures: a badge that
   * never falls however hard the list is worked, or a car that disappears from Hot because
   * somebody left a message and nobody ever called back.
   */
  hotUnactioned: number;
  /** Findings nobody has put to the customer — the reason Hot is empty, when it is. */
  unansweredFindings: number;
  /** The sentence the board says about itself. NULL when there is nothing to say. */
  prompt: string | null;
};

export async function buildBoard(groupId: string, now: Date = new Date()): Promise<Board> {
  // EVERY CAR WITH A REASON TO RING: an MOT date, an open finding, or a battery test. A car with
  // none of the three is not a lead and is not fetched — the fleet count says how many those are.
  const [vehicles, fleet, contacts] = await Promise.all([
    prisma.vehicle.findMany({
      where: {
        group_id: groupId,
        OR: [
          { mot_expiry: { not: null } },
          { due_items: { some: { closed_at: null } } },
          { battery_readings: { some: {} } },
          { tyre_readings: { some: {} } },
        ],
      },
      select: {
        id: true, registration: true, make: true, model: true, mot_expiry: true, mot_checked_at: true,
        battery_readings: {
          orderBy: { measured_at: 'desc' }, take: 1,
          select: { voltage_mv: true, soc_pct: true, soh_pct: true, rated_cca: true, cca_standard: true },
        },
        tyre_readings: { select: { depth_outer_tenths: true, depth_centre_tenths: true, depth_inner_tenths: true, measured_at: true, corner: true } },
      },
    }),
    prisma.vehicle.count({ where: { group_id: groupId } }),
    prisma.marketingContact.findMany({
      where: { group_id: groupId },
      select: { vehicle_id: true, state: true, for_date: true, snooze_until: true, created_at: true, channel: true },
    }),
  ]);

  // THE MOST RECENT record per car, whichever reason it was about. The board is one row per car,
  // so the garage's last answer about that car is the one that applies.
  const byVehicle = new Map<string, typeof contacts[number]>();
  for (const c of contacts) {
    const seen = byVehicle.get(c.vehicle_id);
    if (!seen || c.created_at > seen.created_at) byVehicle.set(c.vehicle_id, c);
  }

  const ids = vehicles.map((v) => v.id);

  // ── THREE BULK READS, NOT THREE PER CAR ──────────────────────────────────────────────────────
  // The first version ran openDueItemsForVehicle, a job-card query and an owner lookup INSIDE the
  // loop: about six hundred round trips for a 222-car fleet, and it built the board in 15.8
  // seconds. Query depth is the latency currency on this stack (lhr1 → Neon eu-west-2), and a
  // page nobody waits for is a page nobody opens. Everything the loop needs is fetched here and
  // grouped in memory.
  const [allItems, allCards, edges] = await Promise.all([
    prisma.vehicleDueItem.findMany({
      where: { group_id: groupId, vehicle_id: { in: ids }, closed_at: null },
      orderBy: { created_at: 'desc' },
      select: {
        id: true, vehicle_id: true, description: true, due_basis: true, due_date: true, due_mileage: true,
        customer_response: true, found_on_job_card_id: true, created_at: true, observation_key: true,
        timing_in_description: true, due_date_precision: true,
      },
    }),
    prisma.jobCard.findMany({
      where: { vehicle_id: { in: ids }, odometer_in: { not: null } },
      select: { vehicle_id: true, odometer_in: true, created_at: true },
      orderBy: { created_at: 'asc' },
    }),
    prisma.vehicleOwnership.findMany({
      where: { vehicle_id: { in: ids }, is_current: true },
      select: { vehicle_id: true, customer_id: true },
    }),
  ]);
  const owners = await prisma.customer.findMany({
    where: { id: { in: [...new Set(edges.map((e) => e.customer_id))] } },
    select: { id: true, name: true, phone: true, phone_e164: true, email: true, sms_opt_out: true, email_opt_out: true },
  });
  const ownerById = new Map(owners.map((o) => [o.id, o]));
  const ownerOfVehicle = new Map(edges.map((e) => [e.vehicle_id, ownerById.get(e.customer_id) ?? null]));
  const itemsByVehicle = new Map<string, typeof allItems>();
  for (const i of allItems) { const a = itemsByVehicle.get(i.vehicle_id) ?? []; a.push(i); itemsByVehicle.set(i.vehicle_id, a); }
  const cardsByVehicle = new Map<string, typeof allCards>();
  for (const c of allCards) { const a = cardsByVehicle.get(c.vehicle_id) ?? []; a.push(c); cardsByVehicle.set(c.vehicle_id, a); }

  /** The same shape openDueItemsForVehicle returns, mapped from a bulk row. */
  const toOpenItem = (r: typeof allItems[number]) => ({
    id: r.id, description: r.description, dueBasis: r.due_basis,
    dueDate: r.due_date ? r.due_date.toISOString().slice(0, 10) : null,
    dueMileage: r.due_mileage, customerResponse: r.customer_response,
    foundOnJobCardId: r.found_on_job_card_id, createdAt: r.created_at.toISOString().slice(0, 10),
    observationKey: r.observation_key, timingInDescription: r.timing_in_description,
    dueDatePrecision: r.due_date_precision,
  });

  // ── THE SIGNALS THAT ALREADY HAVE THEIR OWN REASON ───────────────────────────────────────────
  // A battery advisory is BOTH a due item and a battery reading, so it surfaced twice on one row —
  // "Battery — a cell has failed" and "1 job due — Battery — 9.00V resting, a cell has failed".
  // Same fact, two sentences, which is the duplication the invoice advisory block had. The reading
  // is the stronger statement, so the finding it produced is suppressed here.
  const COVERED_BY_A_SIGNAL = new Set(['battery']);

  const rows: BoardRow[] = [];
  let unansweredFindings = 0;

  for (const v of vehicles) {
    const items = (itemsByVehicle.get(v.id) ?? []).map(toOpenItem);
    const readings = (cardsByVehicle.get(v.id) ?? []).map((c) => ({ date: c.created_at, miles: c.odometer_in as number }));
    const hits = serviceDue(items as never, { now, currentMiles: readings.length ? readings[readings.length - 1].miles : null, readings });
    const dueIds = new Set(hits.map((h: { item: { id: string } }) => h.item.id));

    const findings = items
      .filter((i) => !(i.observationKey && COVERED_BY_A_SIGNAL.has(i.observationKey)))
      .map((i) => ({
        description: i.description,
        response: i.customerResponse as 'not_raised' | 'declined' | 'agreed_later' | 'wants_call',
        dueWithinWindow: dueIds.has(i.id),
      }));
    unansweredFindings += findings.filter((f) => f.response === 'not_raised').length;

    // THE LATEST TEST ONLY. An old failure the garage already acted on is not today's lead.
    const b = v.battery_readings[0];
    const battery: BatteryState | null = b
      ? batteryState({ voltageMv: b.voltage_mv, socPct: b.soc_pct, sohPct: b.soh_pct, ratedCca: b.rated_cca, ccaStandard: b.cca_standard as never })
      : null;

    // THE LOWEST SINGLE READING on the car, from the latest measurement of each corner — the law
    // cares about the worst point on the worst tyre, not an average of anything.
    const latestByCorner = new Map<string, typeof v.tyre_readings[number]>();
    for (const t of [...v.tyre_readings].sort((a, b2) => b2.measured_at.getTime() - a.measured_at.getTime())) {
      if (!latestByCorner.has(t.corner)) latestByCorner.set(t.corner, t);
    }
    const depths = [...latestByCorner.values()].flatMap((t) => [t.depth_outer_tenths, t.depth_centre_tenths, t.depth_inner_tenths]);
    const lowestTreadTenths = depths.length ? Math.min(...depths) : null;

    const rec = byVehicle.get(v.id);
    const contactRec: ContactRecord | null = rec
      ? { reason: 'mot', forDate: rec.for_date, snoozeUntil: rec.snooze_until, createdAt: rec.created_at }
      : null;
    const spent = rec ? !isUnactioned({ dueDate: v.mot_expiry }, contactRec, now) : false;

    const band = motBand(v.mot_expiry, now);
    const motDays = v.mot_expiry ? (v.mot_expiry.getTime() - now.getTime()) / 86_400_000 : null;

    const { stack, reasons } = leadStack({
      motBand: band, motDays, battery, lowestTreadTenths, findings,
      contact: rec ? { state: rec.state as never, snoozeUntil: rec.snooze_until, spent } : null,
    }, now);

    if (!reasons.length) continue; // nothing to ring about

    const c = ownerOfVehicle.get(v.id) ?? null;
    const route = c ? contactRoute(c) : { sms: false, email: false, phone: null };

    rows.push({
      vehicleId: v.id, registration: v.registration,
      vehicleDesc: [v.make, v.model].filter(Boolean).join(' ') || null,
      customerName: c?.name ?? null,
      phone: route.phone, canSms: route.sms, canEmail: route.email,
      noContact: c ? noContactLabel(c) : null,
      state: rec?.state ?? null, channel: rec?.channel ?? null,
      motCheckedAt: v.mot_checked_at ? v.mot_checked_at.toISOString() : null,
      dueDate: (v.mot_expiry ?? hits.find((h: { date: Date | null }) => h.date)?.date ?? null)?.toISOString().slice(0, 10) ?? null,
      reasons, stack,
    });
  }

  const pick = (s: Stack) => rows.filter((r) => r.stack === s);
  const hot = pick('hot');
  return {
    hot, warm: pick('warm'), later: pick('later'),
    fleet, unansweredFindings,
    hotUnactioned: hot.filter((r) => r.state == null).length,
    prompt: unansweredPrompt(hot.length, unansweredFindings),
  };
}

export { WINDOW_DAYS };
