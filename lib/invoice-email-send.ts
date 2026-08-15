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
import { sendNotification } from '@/lib/notify';
import { formatMoney } from '@/lib/format-money';
import { tServer } from '@/lib/server-i18n';
import { writeAudit } from '@/lib/audit';
import { resolveReplyTo } from '@/lib/reply-to';
import { mintInvoicePayLink, payOnlineFor } from '@/lib/invoice-pay-link';

export type InvoiceSendResult = { ok: true } | { ok: false; code: 'NOT_FOUND' | 'NO_RECIPIENT' | 'SEND_FAILED' | 'SUPPRESSED' | 'ERROR'; message: string };

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
    select: { group_name: true, billing_email: true, invoice_email_footer: true, invoice_reply_to: true, invoice_sender_name: true, invoice_bcc: true, inbound_token: true },
  })) as any;
  // Invoicing-tab settings with sensible fallbacks (pre-config tenants behave exactly as before).
  const senderName = (group.invoice_sender_name || '').trim() || group.group_name;
  // ONE resolver — see lib/reply-to. Hands out the inbound address ONLY for entitled tenants.
  const { hasModule } = await import('@/lib/modules');
  const replyTo = resolveReplyTo(group, { inboundEnabled: await hasModule(groupId, 'inbound') });
  const garageCopyAddr = (group.invoice_bcc || '').trim() || (group.billing_email || '').trim();

  const t = (key: string, vars?: Record<string, string | number>) => tServer(doc.locale, 'invoice', key, vars);
  const total = formatMoney(doc.vatRegistered ? doc.totals.grossPennies : doc.totals.netPennies, { currency: doc.currency, locale: doc.locale });
  // Localised HERE (this path owns the tenant's locale); ASSEMBLED by the template. The body lines
  // are translated strings, not HTML — the invoice_document template builds the markup.
  const subject = t('email.subject', { number: doc.number, garage: group.group_name });

  try {
    // MINTED BEFORE THE PDF RENDERS, deliberately. Nothing on the PDF uses it yet, but the QR code
    // and the SMS are the next slice and all three must carry the SAME url from ONE mint — so the
    // call belongs above the render, not beside the email body. Returns null on a receipt, a void,
    // an unlocked invoice or a zero-total document; see lib/invoice-pay-link for why each.
    const payLink = await mintInvoicePayLink({ doc, groupId, recipient: to, createdByUserId: actorUserId });
    // ONE MINT, THREE SURFACES. The PDF gets the same URL as the email button, plus a QR of it and
    // the garage's real payment marks. Null when there is nothing to pay, and the document then
    // carries no payment prompt at all.
    const pay = payLink ? await payOnlineFor({ groupId, url: payLink.url }) : null;
    const pdf = await renderInvoicePdf(doc, pay);
    // THROUGH THE CHOKEPOINT (2026-07-31). This used to call sendEmail directly, which is why the
    // invoice path wrote an AuditLog row but no NotificationLog row — the one send the "what have we
    // sent this customer?" question could never answer. Both records now exist; they answer
    // different questions (audit = who did it to the ledger, notification = what left the building).
    // Contact-preference suppression now applies here too, for free.
    const sent = await sendNotification({
      recipient: to,
      template: 'invoice_document',
      channel: 'email',
      groupId,
      subject: { type: 'invoice', id: invoiceId },
      data: {
        subject,
        greeting: t('email.greeting', { name: doc.customer.name }),
        body: t('email.body', { garage: group.group_name, number: doc.number, total }),
        vehicleLine: doc.vehicle.reg ? `${t('vehicle')}: ${doc.vehicle.reg}${doc.vehicle.desc ? ` (${doc.vehicle.desc})` : ''}` : null,
        signoff: t('email.signoff'),
        garageName: group.group_name,
        footerLine: group.invoice_email_footer ? t('email.footer') : null,
        // Absent on a receipt, so the template renders no button at all rather than a dead one.
        payLink: payLink?.url ?? null,
        payLinkExpiresAt: payLink ? payLink.expiresAt.toISOString() : null,
      },
      // BCC the garage's copy address (Invoicing tab; falls back to billing_email) — skipped when it
      // IS the recipient. From stays GreaseDesk-owned; only display name + Reply-To are tenant-set.
      emailOpts: {
        fromName: senderName,
        replyTo,
        bcc: garageCopyAddr && garageCopyAddr.toLowerCase() !== to.toLowerCase() ? [garageCopyAddr] : undefined,
        attachments: [{ filename: `${(doc.number || 'invoice').replace(/[^\w.-]/g, '_')}.pdf`, content: pdf }],
      },
    });
    // A REFUSAL is not a transport failure and must not read as one — the customer asked not to be
    // emailed, and the caller is told so plainly rather than being shown "try again shortly".
    if (sent.suppressed) return { ok: false, code: 'SUPPRESSED', message: 'This customer has opted out of email — the invoice was not sent. Print or hand over the PDF instead.' };
    if (!sent.ok) return { ok: false, code: 'SEND_FAILED', message: 'The email service didn’t accept the message — please try again shortly.' };
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await writeAudit(tx, {
        groupId, userId: actorUserId, jobCardId: doc.jobCardId, action: 'invoice.sent',
        // Whether a payable link went out is part of what was sent, and the question "could this
        // customer have paid from the email?" has to be answerable later without guessing.
        diff: { number: doc.number, to, payLink: !!payLink },
      });
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
