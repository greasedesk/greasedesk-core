/**
 * File: pages/api/invoice-email.ts
 * POST { invoiceId } → email the invoice PDF to the vehicle's CURRENT owner (ownership edge, same
 * resolution as the card). Deliverability-correct sending: FROM stays the GreaseDesk-owned address
 * with the tenant's name as display name; Reply-To is the tenant's real address (billing_email for
 * now — a dedicated invoice-reply field arrives with the template designer). The configurable
 * "Sent with GreaseDesk" footer lives in the EMAIL only, never the PDF. Audited: invoice.sent.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { Prisma } from '@prisma/client';
import { getVisibility } from '@/lib/site-visibility';
import { canManageSite } from '@/lib/admin-guard';
import { buildInvoiceDoc } from '@/lib/invoice-doc';
import { renderInvoicePdf } from '@/lib/invoice-pdf';
import { getCurrentOwnerId } from '@/lib/vehicle-identity';
import { sendEmail } from '@/lib/email-service';
import { formatMoney } from '@/lib/format-money';
import { tServer } from '@/lib/server-i18n';
import { writeAudit } from '@/lib/audit';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ message: 'Method Not Allowed' });
  }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });

  const { invoiceId } = (req.body || {}) as { invoiceId?: string };
  if (!invoiceId) return res.status(400).json({ message: 'Missing invoiceId.' });

  const doc = await buildInvoiceDoc(invoiceId, user.group_id);
  if (!doc) return res.status(404).json({ message: 'Invoice not found.' });
  const vis = await getVisibility(user.id as string);
  if (!canManageSite(vis, doc.siteId)) return res.status(403).json({ message: 'You do not have access to this invoice.' });

  // Recipient: the vehicle's CURRENT owner via the ownership edge; fall back to the card's own
  // customer link (pre-edge cards only). No address → a friendly, actionable message.
  const card = (await prisma.jobCard.findUnique({
    where: { id: doc.jobCardId },
    select: { vehicle_id: true, customer: { select: { email: true } } },
  })) as any;
  const ownerId = card?.vehicle_id ? await getCurrentOwnerId(prisma, card.vehicle_id as string) : null;
  const owner = ownerId ? ((await prisma.customer.findUnique({ where: { id: ownerId }, select: { email: true } })) as any) : null;
  const to = (owner?.email || card?.customer?.email || '').trim();
  if (!to) return res.status(409).json({ message: 'This customer has no email address on file — add one on the card’s Customer Details tab first.' });

  const group = (await prisma.group.findUnique({
    where: { id: user.group_id },
    select: { group_name: true, billing_email: true, invoice_email_footer: true },
  })) as any;

  const t = (key: string, vars?: Record<string, string | number>) => tServer(doc.locale, 'invoice', key, vars);
  const total = formatMoney(doc.vatRegistered ? doc.totals.grossPennies : doc.totals.netPennies, { currency: doc.currency, locale: doc.locale });
  const subject = t('email.subject', { number: doc.number, garage: group.group_name });
  const bodyLines = [
    `<p>${t('email.greeting', { name: doc.customer.name })}</p>`,
    `<p>${t('email.body', { garage: group.group_name, number: doc.number, total })}</p>`,
    doc.vehicle.reg ? `<p>${t('vehicle')}: ${doc.vehicle.reg}${doc.vehicle.desc ? ` (${doc.vehicle.desc})` : ''}</p>` : '',
    `<p>${t('email.signoff')}<br/>${group.group_name}</p>`,
    group.invoice_email_footer ? `<hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0"/><p style="font-size:12px;color:#9ca3af">${t('email.footer')}</p>` : '',
  ].filter(Boolean);
  const html = `<div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">${bodyLines.join('')}</div>`;

  try {
    const pdf = await renderInvoicePdf(doc);
    const ok = await sendEmail(to, subject, html, {
      fromName: group.group_name,
      replyTo: group.billing_email || undefined,
      attachments: [{ filename: `${(doc.number || 'invoice').replace(/[^\w.-]/g, '_')}.pdf`, content: pdf }],
    });
    if (!ok) return res.status(502).json({ message: 'The email service didn’t accept the message — please try again shortly.' });
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await writeAudit(tx, { groupId: user.group_id as string, userId: user.id as string, jobCardId: doc.jobCardId, action: 'invoice.sent', diff: { number: doc.number, to } });
    });
  } catch (e) {
    console.error('Invoice email error:', e);
    return res.status(500).json({ message: 'Could not send the invoice.' });
  }
  return res.status(200).json({ message: 'Invoice sent.' });
}
