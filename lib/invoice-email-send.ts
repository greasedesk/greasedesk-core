/**
 * File: lib/invoice-email-send.ts
 * THE one invoice-send implementation — extracted from the API route so the clearance cron and the
 * button share a single path (doc → recipient → compose → PDF → Resend with garage BCC → audit).
 * Two entry points, one behaviour: pages/api/invoice-email (session-authed button) and
 * pages/api/cron/confirm-paid (CRON_SECRET, actorUserId null = system). Server-only.
 * On a CONFIRMED invoice a successful send also stamps receipt_sent_at (clears the visible
 * "receipt not sent" state); issued/pending sends never touch it.
 */
import { prisma } from '@/lib/db';
import { Prisma } from '@prisma/client';
import { buildInvoiceDoc } from '@/lib/invoice-doc';
import { renderInvoicePdf } from '@/lib/invoice-pdf';
import { getCurrentOwnerId } from '@/lib/vehicle-identity';
import { sendEmail } from '@/lib/email-service';
import { formatMoney } from '@/lib/format-money';
import { tServer } from '@/lib/server-i18n';
import { writeAudit } from '@/lib/audit';

export type InvoiceSendResult = { ok: true } | { ok: false; code: 'NOT_FOUND' | 'NO_RECIPIENT' | 'SEND_FAILED' | 'ERROR'; message: string };

export async function sendInvoiceEmail(invoiceId: string, groupId: string, actorUserId: string | null): Promise<InvoiceSendResult> {
  const doc = await buildInvoiceDoc(invoiceId, groupId);
  if (!doc) return { ok: false, code: 'NOT_FOUND', message: 'Invoice not found.' };

  // Recipient: the vehicle's CURRENT owner via the ownership edge; fall back to the card's own
  // customer link (pre-edge cards only).
  const card = (await prisma.jobCard.findUnique({
    where: { id: doc.jobCardId },
    select: { vehicle_id: true, customer: { select: { email: true } } },
  })) as any;
  const ownerId = card?.vehicle_id ? await getCurrentOwnerId(prisma, card.vehicle_id as string) : null;
  const owner = ownerId ? ((await prisma.customer.findUnique({ where: { id: ownerId }, select: { email: true } })) as any) : null;
  const to = (owner?.email || card?.customer?.email || '').trim();
  if (!to) return { ok: false, code: 'NO_RECIPIENT', message: 'This customer has no email address on file — add one on the card’s Customer Details tab first.' };

  const group = (await prisma.group.findUnique({
    where: { id: groupId },
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
    // BCC the garage's own address so it keeps a copy of exactly what the customer received
    // (skipped if it IS the recipient). Configurable copy address arrives with Invoice Settings.
    const garageCopy = (group.billing_email || '').trim();
    const ok = await sendEmail(to, subject, html, {
      fromName: group.group_name,
      replyTo: group.billing_email || undefined,
      bcc: garageCopy && garageCopy.toLowerCase() !== to.toLowerCase() ? [garageCopy] : undefined,
      attachments: [{ filename: `${(doc.number || 'invoice').replace(/[^\w.-]/g, '_')}.pdf`, content: pdf }],
    });
    if (!ok) return { ok: false, code: 'SEND_FAILED', message: 'The email service didn’t accept the message — please try again shortly.' };
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await writeAudit(tx, { groupId, userId: actorUserId, jobCardId: doc.jobCardId, action: 'invoice.sent', diff: { number: doc.number, to } });
      if (doc.status === 'paid') {
        await tx.invoice.update({ where: { id: invoiceId }, data: { receipt_sent_at: new Date() } });
      }
    });
    return { ok: true };
  } catch (e) {
    console.error('Invoice email error:', e);
    return { ok: false, code: 'ERROR', message: 'Could not send the invoice.' };
  }
}
