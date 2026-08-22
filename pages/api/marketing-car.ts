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
 * TWO QUERIES, not two-per-card. One walks the car's cards with their invoice and lines; one walks
 * the OWNER's cards for the customer-level figures. The owner comes from the ownership edge, so a
 * customer who owns several cars is counted across all of them.
 *
 * Through requireTenantApi: the scope can only be OBTAINED from the validator, never taken from
 * the caller, and the vehicle is re-checked against it before anything is read.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { requireTenantApi, canAccessSite } from '@/lib/admin-guard';

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
  const findings = await prisma.vehicleDueItem.findMany({
    where: { group_id: scope.groupId, vehicle_id: vehicleId, closed_at: null },
    orderBy: { created_at: 'desc' },
    select: { id: true, description: true, created_at: true, customer_response: true, response_at: true },
  });

  return res.status(200).json({
    vehicle: { id: vehicle.id, registration: vehicle.registration, desc: [vehicle.make, vehicle.model].filter(Boolean).join(' ') || null },
    history, customer,
    findings: findings.map((f) => ({
      id: f.id, description: f.description,
      raisedOn: f.created_at.toISOString().slice(0, 10),
      response: f.customer_response,
      answeredOn: f.response_at ? f.response_at.toISOString().slice(0, 10) : null,
    })),
  });
}
