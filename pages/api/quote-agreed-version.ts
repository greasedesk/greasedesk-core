/**
 * File: pages/api/quote-agreed-version.ts
 * POST { jobCardId, versionId } → record that the customer agreed a LATER quote version, on a card
 * that has moved past the point where the ordinary verbal control is offered.
 *
 * TWO SHAPES, ONE ACT:
 *   • NO INVOICE YET (card accepted / in_progress) — a customer agreed a revised price mid-job. This
 *     is ordinary quoting, and it is the case that LOSES MONEY: with an accepted version present,
 *     lib/invoice-issue column-copies THAT version, so the invoice raised later bills the OLD figure
 *     no matter what the estimate says. KR60LCX sat at accepted v2 £2,015.01 / sent v3 £2,171.01 with
 *     seven lines of work in the bay — £156.00 that would simply never have been invoiced.
 *   • INVOICE ALREADY RAISED — correcting a document. Guarded and admin-only, as before.
 *
 * ── AUTHORITY FOLLOWS THE ARTEFACT AT RISK (ruling 2026-08-08) ──────────────────────────────────
 * No invoice → nothing has been issued, so this is the same act as the existing verbal control and
 * carries the same authority (canAccessSite — see pages/api/quote-accept-verbal).
 * Invoice present → it exists to change that document, so admin, matching unlock/re-issue. Anything
 * less would be a route for laundering authority: a lower-privilege acceptance feeding an
 * admin-level correction.
 *
 * TWO STEPS, NOT ONE, where an invoice exists: this records the agreement and nothing else; the
 * admin then unlocks and re-issues. Fusing them would hide a change to what a customer owes inside
 * a click labelled "accepted". With NO invoice there is no second step — the figure is simply right
 * when the invoice is eventually raised.
 *
 * The card status is NOT checked — that is the whole point, and why this calls recordAgreedVersion
 * rather than acceptQuote. The invoice guards apply ONLY when there is an invoice to protect.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { Prisma } from '@prisma/client';
import { getVisibility } from '@/lib/site-visibility';
import { canAccessSite } from '@/lib/admin-guard';
import { recordAgreedVersion, isAgreedVersionRefusal } from '@/lib/quote-acceptance';
import { refuseIfVoid, refuseIfSent } from '@/lib/invoice-void';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ message: 'Method Not Allowed' });
  }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });

  const { jobCardId, versionId } = (req.body ?? {}) as { jobCardId?: string; versionId?: string };
  if (!jobCardId || !versionId) return res.status(400).json({ message: 'jobCardId and versionId are required.' });

  const card = await prisma.jobCard.findFirst({
    where: { id: jobCardId, group_id: user.group_id },
    select: { id: true, site_id: true, group_id: true, status: true },
  });
  if (!card) return res.status(404).json({ message: 'Job card not found.' });

  const vis = await getVisibility(user.id as string);
  if (!canAccessSite(vis, card.site_id)) return res.status(403).json({ message: 'You don’t have access to that job card.' });

  // The invoice is now OPTIONAL. Where one exists it must be correctable; where none exists there is
  // nothing to protect and the guards below simply do not apply.
  const invoice = (await prisma.invoice.findUnique({
    where: { job_card_id: card.id },
    select: { id: true, status: true, invoice_number: true, receipt_sent_at: true },
  })) as { id: string; status: string; invoice_number: string | null; receipt_sent_at: Date | null } | null;

  // AUTHORITY FOLLOWS THE ARTEFACT. Admin only once a document exists to be changed.
  if (invoice && !vis.isAdmin) {
    return res.status(403).json({ message: 'This job has already been invoiced — only an admin can change which version it was agreed at.' });
  }

  if (invoice) {
    const voided = refuseIfVoid(invoice);
    if (voided) return res.status(409).json(voided);

    // MONEY HAS MOVED → a different conversation. Unmark the payment first if it was recorded wrongly.
    if (invoice.status === 'paid' || invoice.status === 'paid_pending') {
      return res.status(409).json({
        code: 'already_paid',
        message: 'This invoice has been paid, so its lines can no longer change. Unmark the payment first if it was recorded in error.',
      });
    }

    // ALREADY WITH THE CUSTOMER → refuse. `invoice.sent` is audited against the JOB CARD (see
    // lib/invoice-void.refuseIfSent), which is unambiguous because a card has at most one invoice.
    const sentAudit = await prisma.auditLog.findFirst({
      where: { entity_id: card.id, action: 'invoice.sent' },
      select: { id: true },
    });
    const sent = refuseIfSent(invoice, !!sentAudit);
    if (sent) return res.status(409).json(sent);
  }

  const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) =>
    recordAgreedVersion(tx, {
      groupId: card.group_id,
      jobCardId: card.id,
      versionId,
      actorUserId: user.id as string,
      at: new Date(),
    }),
  );
  if (isAgreedVersionRefusal(result)) return res.status(409).json(result);

  return res.status(200).json({
    ok: true,
    version: result.version,
    grossPennies: result.grossPennies,
    // The next step is stated, because this deliberately did not take it.
    invoiced: !!invoice,
    // The wording follows what actually happened. With no invoice there is no second step to name,
    // and inventing one ("now unlock…") would send someone looking for a control that isn't there.
    message: invoice
      ? `Recorded that the customer agreed version ${result.version}. This is logged as a garage-recorded agreement. Invoice ${invoice.invoice_number} still shows the earlier figures — unlock and re-issue it to correct them.`
      : `Recorded that the customer agreed version ${result.version}. This is logged as a garage-recorded agreement. The invoice for this job will now be raised at the agreed figures.`,
  });
}
