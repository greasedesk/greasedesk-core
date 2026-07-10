/**
 * File: pages/api/invoices.ts
 * GET ?status=all|unpaid|pending|paid|warranty & q=<customer or reg> → the Invoices (AR/debtors)
 * list. Permission-gated SERVER-SIDE (canViewInvoices — managers/admins always, STANDARD via the
 * tenant toggle; 403 otherwise) and site-scoped SERVER-SIDE (rows filtered to vis.siteIds — a
 * manager cannot query another site's invoices). Amounts computed through the existing money
 * chokepoints: frozen snapshot lines for pending/paid, live card items for issued — never a forked
 * formula. unit_cost never leaves the server.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { getVisibility } from '@/lib/site-visibility';
import { getTenantPermissions, canViewInvoices } from '@/lib/permissions';
import { invoiceTotals, computeInvoiceLinePennies } from '@/lib/invoice';
import { poundsToPennies } from '@/lib/quote-totals';
import { getCurrentOwnerId } from '@/lib/vehicle-identity';

const STATUS_FILTERS: Record<string, object> = {
  all: {},
  unpaid: { status: 'issued', series: 'chargeable' }, // the debtors view
  pending: { status: 'paid_pending' },
  paid: { status: 'paid' },
  warranty: { series: 'warranty' },
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ message: 'Method Not Allowed' });
  }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });

  const vis = await getVisibility(user.id as string);
  const perms = await getTenantPermissions(user.group_id as string);
  if (!canViewInvoices(vis, perms)) return res.status(403).json({ message: 'You do not have permission to view invoices.' });

  const statusKey = String(req.query.status || 'all');
  const statusWhere = STATUS_FILTERS[statusKey] ?? {};
  const q = String(req.query.q || '').trim();

  const rows = (await prisma.invoice.findMany({
    where: {
      group_id: user.group_id,
      site_id: { in: vis.siteIds }, // server-side site scope — never widened by any toggle
      ...statusWhere,
      ...(q ? { OR: [
        { customer_name_snapshot: { contains: q, mode: 'insensitive' } },
        { vehicle_reg_snapshot: { contains: q.replace(/\s+/g, ''), mode: 'insensitive' } },
        { invoice_number: { contains: q, mode: 'insensitive' } },
      ] } : {}),
    },
    orderBy: { issued_at: 'desc' },
    take: 500,
    select: {
      id: true, invoice_number: true, status: true, series: true, issued_at: true, paid_at: true, receipt_sent_at: true,
      confirm_due_at: true, payment_method_snapshot: true,
      customer_name_snapshot: true, vehicle_reg_snapshot: true, vat_registered_at_issue: true, job_card_id: true,
      lines: { select: { vat_rate: true, line_total: true, line_vat: true } },
      job_card: { select: { vehicle_id: true, customer: { select: { email: true } }, items: { select: { qty: true, unit_price: true, vat_rate: true } } } },
      site: { select: { currency_code: true, locale: true } },
    },
  })) as any[];

  const list = await Promise.all(rows.map(async (r) => {
    // Amount = gross (what's owed — the AR number). Frozen lines once pending/paid; live items while issued.
    let grossPennies = 0;
    if (r.status !== 'issued') {
      grossPennies = invoiceTotals(r.lines).grossPennies;
    } else if (r.series === 'warranty') {
      grossPennies = 0;
    } else {
      const registered = !!r.vat_registered_at_issue;
      for (const it of r.job_card?.items ?? []) {
        const { netPennies, vatPennies } = computeInvoiceLinePennies(Number(it.qty), poundsToPennies(Number(it.unit_price)), Number(it.vat_rate), registered);
        grossPennies += netPennies + vatPennies;
      }
    }
    // Recipient for the resend confirmation — edge-resolved current owner, card customer fallback.
    const ownerId = r.job_card?.vehicle_id ? await getCurrentOwnerId(prisma, r.job_card.vehicle_id as string) : null;
    const owner = ownerId ? ((await prisma.customer.findUnique({ where: { id: ownerId }, select: { email: true } })) as any) : null;
    return {
      id: r.id,
      number: r.invoice_number ?? '',
      customer: r.customer_name_snapshot,
      reg: r.vehicle_reg_snapshot,
      status: r.status,
      series: r.series,
      issuedAt: r.issued_at,
      paidAt: r.paid_at,
      receiptSent: !!r.receipt_sent_at,
      manualPending: r.status === 'paid_pending' && !r.confirm_due_at,
      method: r.payment_method_snapshot ?? null,
      grossPennies,
      currency: r.site?.currency_code ?? 'GBP',
      locale: r.site?.locale ?? 'en-GB',
      jobCardId: r.job_card_id,
      recipientEmail: (owner?.email || r.job_card?.customer?.email || '').trim() || null,
    };
  }));

  return res.status(200).json({ invoices: list });
}
