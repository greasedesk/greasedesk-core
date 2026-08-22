/**
 * File: pages/api/marketing-car.ts
 * GET ?vehicleId= → one car's job-card history, its open findings, and its owner's figures.
 *
 * ── ON DEMAND, BECAUSE THE BOARD IS NOT CHEAP ───────────────────────────────────────────────────
 * The marketing board already costs four bulk reads to build, and it is built once per page load.
 * Opening a car must not re-run it — which is why this is its own endpoint fetched client-side
 * rather than more work in getServerSideProps. Fetching every car's history upfront would be the
 * N+1 the board itself had removed: 619 cars x their history is what took it from 15.8s to 1.02s.
 *
 * FLAT, NOT TWO-PER-CARD — and flat is the property, not the number. Measured against a served
 * request on 2026-08-22: THIRTEEN SQL statements for a car with one visit and thirteen for a car
 * with twelve, of which two are the guard's own visibility lookup. Prisma issues a statement per
 * relation level, so the six Prisma calls here are not six queries; counting the calls and calling
 * it two, as this header did until it was measured, was wrong by a factor of five.
 *
 * The six: the car; its cards with their invoice, lines and items; the ownership edge; the OWNER's
 * cards for the customer-level figures; the open findings; and the two reading tables. The owner
 * comes from the ownership edge, so somebody who owns three cars is counted across all of them.
 *
 * Through requireTenantApi: the scope can only be OBTAINED from the validator, never taken from
 * the caller, and the vehicle is re-checked against it before anything is read.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { requireTenantApi, canAccessSite } from '@/lib/admin-guard';
import { openDueItemsForVehicle, dueLabel, showsDueLabel } from '@/lib/due-items';
import { printedTyreLines } from '@/lib/tyres';
import { printedBatteryLine } from '@/lib/battery';

/** Gross pennies for a set of lines. Both sides are pounds in the column; the UI wants pennies. */
const grossOf = (lines: Array<{ line_total: unknown; line_vat: unknown }>) =>
  lines.reduce((a, l) => a + Math.round((Number(l.line_total) + Number(l.line_vat)) * 100), 0);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  const scope = await requireTenantApi(req, res);
  if (!scope) return;

  const vehicleId = String(req.query.vehicleId || '');
  if (!vehicleId) return res.status(400).json({ message: 'A vehicle is required.' });

  const vehicle = await prisma.vehicle.findFirst({
    where: { id: vehicleId, group_id: scope.groupId },
    select: { id: true, registration: true, make: true, model: true },
  });
  if (!vehicle) return res.status(404).json({ message: 'Vehicle not found.' });

  // ── 1. THE CAR'S HISTORY ──────────────────────────────────────────────────────────────────────
  const cards = await prisma.jobCard.findMany({
    where: { group_id: scope.groupId, vehicle_id: vehicleId },
    orderBy: { created_at: 'desc' },
    select: {
      id: true, created_at: true, status: true, odometer_in: true, site_id: true,
      // ONE invoice per card. The frozen lines are what the customer was billed for; once issued
      // the ledger reads InvoiceLine and the card is a draft, so the history reads the invoice and
      // falls back to the card's own items only where none was ever raised.
      invoice: {
        select: { invoice_number: true, series: true, status: true, date_issued: true,
                  lines: { select: { description: true, line_total: true, line_vat: true } } },
      },
      items: { select: { description: true, qty: true, unit_price: true, vat_amount: true } },
    },
  });
  const visible = cards.filter((c) => canAccessSite(scope.vis, c.site_id));

  const history = visible.map((c) => {
    const inv = c.invoice;
    const lines = inv ? inv.lines.map((l) => l.description) : c.items.map((i) => i.description);
    const pennies = inv
      ? grossOf(inv.lines)
      : c.items.reduce((a, i) => a + Math.round((Number(i.qty) * Number(i.unit_price) + Number(i.vat_amount)) * 100), 0);
    return {
      cardId: c.id,
      date: c.created_at.toISOString().slice(0, 10),
      status: c.status,
      odometerIn: c.odometer_in,
      invoiceNumber: inv?.invoice_number ?? null,
      issued: !!inv,
      // FIRST LINE ONLY. A catalogue line is Title + newline + Description (see lib/catalogue's
      // fixedLineText), so the raw text is multi-line and the joined form runs to 264 characters at
      // p90 and 1,157 at the tail. The row shows the titles; the whole thing lives on the card.
      summary: lines.map((d) => String(d).split('\n')[0].trim()).filter(Boolean),
      grossPennies: pennies,
    };
  });

  // ── 2. THE OWNER'S FIGURES ────────────────────────────────────────────────────────────────────
  // A person, not a chassis: somebody ringing about one car is talking to someone who may have
  // three. Resolved through the ownership edge, which is the owner of record (car-first re-root).
  const edge = await prisma.vehicleOwnership.findFirst({
    where: { vehicle_id: vehicleId, is_current: true },
    select: { customer: { select: { id: true, name: true } } },
  });
  let customer: null | {
    name: string | null; totalPennies: number; visits: number; firstVisit: string | null;
    averagePennies: number; cars: number;
  } = null;
  if (edge?.customer) {
    const own = await prisma.jobCard.findMany({
      where: { group_id: scope.groupId, customer_id: edge.customer.id },
      select: { created_at: true, vehicle_id: true, site_id: true,
                invoice: { select: { lines: { select: { line_total: true, line_vat: true } } } } },
      orderBy: { created_at: 'asc' },
    });
    const mine = own.filter((c) => canAccessSite(scope.vis, c.site_id));
    const total = mine.reduce((a, c) => a + (c.invoice ? grossOf(c.invoice.lines) : 0), 0);
    customer = {
      name: edge.customer.name,
      totalPennies: total,
      visits: mine.length,
      firstVisit: mine[0]?.created_at.toISOString().slice(0, 10) ?? null,
      // Over VISITS, not over invoiced visits: "what they spend when they come in" includes the
      // times they came in and were charged nothing.
      averagePennies: mine.length ? Math.round(total / mine.length) : 0,
      cars: new Set(mine.map((c) => c.vehicle_id)).size,
    };
  }

  // ── 3. WHAT WAS FOUND, AND THAT NOBODY HAS ANSWERED ───────────────────────────────────────────
  // Raised-and-unanswered ONLY. Declines and values are deliberately absent: no finding on any
  // tenant has ever been declined, and DueItemLine — the join that would give one a value — has
  // never had a row. Building for either would be building against a column with one value in it.
  const findings = await openDueItemsForVehicle(prisma, scope.groupId, vehicleId);

  // ── THE READING THE TIMING IS JUDGED AGAINST ──────────────────────────────────────────────────
  // The newest odometer we actually hold, walking visits newest-first and taking the first that
  // recorded one — NOT `visible[0].odometer_in`, which is null on any car whose last visit never
  // keyed a reading and would silently drop "overdue by 1,200 miles" back to "due at 78,000".
  // A car with no reading anywhere passes null, and dueLabel's documented contract for null is the
  // wording it has always had: it states the target and makes no claim about having passed it.
  // Latest rather than MAX on purpose — this is what the car read when we last saw it, and a
  // mis-keyed 780,000 should not permanently declare every finding overdue.
  const atMiles = visible.find((c) => c.odometer_in != null)?.odometer_in ?? null;

  // ── 4. WHAT WAS MEASURED ──────────────────────────────────────────────────────────────────────
  // TWO STATEMENTS — no relations to walk, so here the calls and the statements do match, unlike
  // the card read above. Both flat in the car's history: the readings are per-VISIT, so fetching
  // them per card is the N+1 this endpoint exists to avoid. Each takes the car's readings newest-first and
  // the latest per corner is picked in memory — four rows out of a handful, which is cheaper than
  // four round trips and does not depend on DISTINCT ON surviving a Prisma version.
  //
  // NOT SITE-FILTERED, like the findings and the car itself above. A reading is a fact about the
  // CAR, not about a visit — that is why job_card_id is SetNull on both models. Filtering by the
  // site of the card it happened to be taken on would hide the tread depth of a car the user can
  // otherwise see in full.
  const tyreRows = await prisma.tyreReading.findMany({
    where: { group_id: scope.groupId, vehicle_id: vehicleId },
    orderBy: { measured_at: 'desc' },
    select: { corner: true, depth_outer_tenths: true, depth_centre_tenths: true,
              depth_inner_tenths: true, measured_at: true },
  });
  const latestPerCorner = new Map<string, typeof tyreRows[number]>();
  for (const r of tyreRows) if (!latestPerCorner.has(r.corner)) latestPerCorner.set(r.corner, r);
  const corners = [...latestPerCorner.values()];
  const tyreDates = [...new Set(corners.map((r) => r.measured_at.toISOString().slice(0, 10)))].sort();
  const battery = await prisma.batteryReading.findFirst({
    where: { group_id: scope.groupId, vehicle_id: vehicleId },
    orderBy: { measured_at: 'desc' },
    select: { voltage_mv: true, soc_pct: true, soh_pct: true, rated_cca: true,
              cca_standard: true, measured_at: true },
  });

  return res.status(200).json({
    vehicle: { id: vehicle.id, registration: vehicle.registration, desc: [vehicle.make, vehicle.model].filter(Boolean).join(' ') || null },
    history, customer, atMiles,
    findings: findings.map((f) => ({
      id: f.id, description: f.description,
      raisedOn: f.createdAt,
      response: f.customerResponse,
      // ONE RULE DECIDES WHETHER A TIMING IS APPENDED, and this is its fourth caller rather than
      // its fourth implementation — `showsDueLabel` exists because a battery description already
      // saying "Replace." once acquired "due at the next service" on a real customer's invoice.
      // Empty string is the shape the other three callers use for "nothing to append".
      timing: showsDueLabel(f) ? dueLabel(f, atMiles) : '',
    })),
    // ── THE SAME SENTENCE THE DOCUMENT PRINTS ────────────────────────────────────────────────
    // printedTyreLines and printedBatteryLine are the frozen-advisory wording, and the pane borrows
    // them rather than formatting tenths and millivolts a second time. Two consequences, both
    // wanted: the caller reads exactly what the customer's invoice says, and "BELOW LEGAL LIMIT"
    // comes from the SAME threshold as the board's `tyre_illegal` reason, so the pane cannot
    // contradict the row that sent you to it. Re-deriving either here is how those two drift.
    readings: {
      tyres: {
        lines: printedTyreLines(corners.map((r) => ({
          corner: r.corner,
          depths: { outer: r.depth_outer_tenths, centre: r.depth_centre_tenths, inner: r.depth_inner_tenths },
        }))),
        // LATEST PER CORNER, so a car whose nearside was re-measured last visit shows the new
        // figure beside three older ones. One date when they came off one visit; the newest and a
        // caveat when they did not, because "measured 14 Aug" would be false of the other three.
        measuredOn: tyreDates[tyreDates.length - 1] ?? null,
        spansVisits: tyreDates.length > 1,
      },
      battery: battery ? {
        line: printedBatteryLine({
          voltageMv: battery.voltage_mv, socPct: battery.soc_pct, sohPct: battery.soh_pct,
          ratedCca: battery.rated_cca, ccaStandard: battery.cca_standard,
        }),
        measuredOn: battery.measured_at.toISOString().slice(0, 10),
      } : null,
    },
  });
}
