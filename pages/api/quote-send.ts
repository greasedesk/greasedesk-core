/**
 * File: pages/api/quote-send.ts
 * POST { jobCardId, email?, channel? } → freeze the estimate as a new QuoteVersion, mint a magic
 * link for it, and send it. THE one path a quote reaches a customer, by either channel.
 *
 * COPYABLE LINK, ALWAYS. The URL comes back in the response whether or not the send went, so staff
 * can pass it on by hand (WhatsApp, read out over the phone). A customer with NO address on the
 * chosen channel is not blocked: we mint the link, skip the send, and return it — the same "offer
 * the link rather than fail" pattern as the operator-invite dev fallback.
 *
 * ── ONE PATH, TWO CHANNELS — AND NO SECOND ONE ──────────────────────────────────────────────────
 * pages/api/jobcard-share existed to send a card link by email or SMS and was DELETED with this
 * change. It minted a `quote_view` link without freezing a version, and the customer page resolves
 * the quote BY the version attached to the link — so every quote it ever texted would have rendered
 * "no quote". Nothing called it. The lesson is the one this header already states: freezing,
 * revoking and sending belong together, and a second route that does two of the three is a route
 * that sends dead links.
 *
 * ── WHY THE ALLOWANCE IS CHECKED BEFORE THE FREEZE ──────────────────────────────────────────────
 * sendNotification refuses an SMS with a spent allowance, and it does so at the END — by which
 * point this route has already revoked the live link and frozen a new version. That is exactly the
 * "superseded version and a revoked link behind for a send that never went" the refuseQuoteSend
 * comment below warns about. So the allowance is asked BEFORE anything is destroyed. The chokepoint
 * still has the final word (two operators sending at once can slip past this read), and if it
 * refuses after the freeze the link is still returned to be handed over — losing a hundredth of a
 * message is not worth a second opinion on the balance.
 *
 * `emailed` STILL MEANS AN EMAIL WENT. It is written into quote.sent audit rows going back months
 * and is not being redefined to mean "sent"; `channel` and `sent` are new fields alongside it.
 *
 * Freezing and revoking happen through lib/quote-version, sending through lib/notify, the credential
 * through lib/magic-link — this route orchestrates chokepoints, it does not reimplement any of them.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { getVisibility } from '@/lib/site-visibility';
import { canAccessSite } from '@/lib/admin-guard';
import { canWrite } from '@/lib/billing';
import { createMagicLink, MAGIC_LINK_DAYS, revokeMagicLinksForCard } from '@/lib/magic-link';
import { refuseQuoteSend } from '@/lib/quote-acceptance';
import { sendNotification, type NotifyChannel } from '@/lib/notify';
import { freezeQuoteVersion, attachMagicLink } from '@/lib/quote-version';
import { formatMoney } from '@/lib/format-money';
import { resolveContactRoutes } from '@/lib/contact-routes';
import { reachabilityForJobCard } from '@/lib/message-threads';
import { describeSendFailure, type FailedSend } from '@/lib/send-outcome';
import { smsAllowance } from '@/lib/sms-allowance';
import { writeAudit } from '@/lib/audit';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ message: 'Method Not Allowed' });
  }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });

  const { jobCardId, email: rawEmail, note: rawNote } = (req.body ?? {}) as Record<string, string>;
  // OPTIONAL, ALWAYS. Empty or whitespace is stored as null — a blank note is no note, not an
  // empty paragraph on the customer's quote page.
  const note = typeof rawNote === 'string' && rawNote.trim() ? rawNote.trim().slice(0, 1000) : null;
  if (!jobCardId) return res.status(400).json({ message: 'jobCardId is required.' });
  // Email unless SMS is asked for — the same default and the same argument shape as the messaging
  // centre's compose box, so there is one way to say "by text" across the product.
  const channel: NotifyChannel = (req.body ?? {}).channel === 'sms' ? 'sms' : 'email';
  if (rawEmail && channel === 'sms') {
    return res.status(400).json({ message: 'An email address can’t be used for a text message.' });
  }

  const card = await prisma.jobCard.findFirst({
    where: { id: jobCardId, group_id: user.group_id },
    select: {
      id: true, site_id: true, group_id: true, status: true,
      vehicle: { select: { registration: true } },
      // NO customer select. The recipient comes from the ownership edge now (see below), and
      // leaving the card's own customer email selected here would be an invitation to read it.
      group: {
        select: {
          group_name: true, trading_name: true, tax_label: true, vat_registered: true, phone: true,
          billing: { select: { subscription_status: true, status: true } },
        },
      },
      site: { select: { currency_code: true, locale: true, phone: true, whatsapp: true } },
      _count: { select: { items: true } },
    },
  });
  if (!card) return res.status(404).json({ message: 'Job card not found.' });

  const vis = await getVisibility(user.id as string);
  if (!canAccessSite(vis, card.site_id)) return res.status(403).json({ message: 'You don’t have access to that job card.' });
  if (!canWrite({ subscriptionStatus: card.group.billing?.subscription_status ?? null, status: card.group.billing?.status ?? null })) {
    return res.status(402).json({ message: 'Your subscription is inactive — sending a quote is paused.' });
  }
  if (!card._count.items) return res.status(400).json({ message: 'Add at least one line to the estimate before sending it.' });

  // CAN THIS CARD ANSWER A QUOTE AT ALL? Before the freeze and before the mint — refusing after
  // either would leave a superseded version and a revoked link behind for a send that never went.
  // Same predicate the customer's answer is judged by, so a link is never minted that could only
  // ever be refused. Staff wording; the customer-facing sentence is deliberately different.
  // IS THIS A REVISION? Answered by the VERSIONS, not the card status: acceptance belongs to the
  // version (ruling 2026-08-05). A customer who has already agreed to a figure is being told the
  // price CHANGED, which is a different message from a first quote — so this is read BEFORE the
  // freeze, while the accepted version is still the newest thing on record.
  //
  // The SAME fact also decides what a refusal SAYS: with an accepted version present, "add the work
  // to the estimate and invoice it" is false, because the invoice copies that version and never
  // reads the estimate. One read, both uses — they can never disagree about it.
  const isRevision = (await prisma.quoteVersion.count({
    where: { job_card_id: card.id, status: 'accepted' },
  })) > 0;

  const sendRefusal = refuseQuoteSend(card.status, isRevision);
  if (sendRefusal) return res.status(409).json({ code: sendRefusal.code, message: sendRefusal.message });

  // ── CAN WE AFFORD THE TEXT? ASKED BEFORE ANYTHING IS DESTROYED ─────────────────────────────
  // See the header. Refusing at the chokepoint would mean the live link was already revoked and a
  // new version already frozen for a message that never left — the customer would be holding a dead
  // link and nobody would have told them why.
  if (channel === 'sms') {
    const allowance = await smsAllowance(prisma, card.group_id);
    if (allowance.remaining <= 0) {
      return res.status(409).json({
        code: 'allowance_spent',
        message: 'Your SMS allowance is spent for this month — nothing was sent. Top up, or email the quote instead.',
        allowance,
      });
    }
  }

  // ── WHO IS THIS GOING TO? THE OWNERSHIP EDGE, ON BOTH CHANNELS ─────────────────────────────
  // An explicit address still wins — staff sending to "the other half" is a real thing. Otherwise
  // reachabilityForJobCard answers it, and it answers it the SAME WAY for email and for text.
  // This route used to read card.customer.email directly, which is the card's own customer link
  // rather than the vehicle's current owner (car-first re-root). The two agreed on all 400 open
  // cards when this was measured, so nothing was mis-sent — but resolving the text recipient
  // through the edge and the email recipient through the card would have been two answers to one
  // question, and they only ever agree until they don't.
  //
  // NOT REACHABLE IS NOT A REFUSAL. The copyable-link path above is the whole point: mint it, skip
  // the send, hand it over at the counter.
  const reach = rawEmail
    ? { ok: true as const, address: rawEmail.trim(), reason: null }
    : await reachabilityForJobCard(prisma, card.id, channel);
  const unreachableReason = reach?.ok ? null : (reach?.reason ?? 'The vehicle has no current owner, so there is nobody to send to.');

  // A NEW send supersedes anything already out AND kills its link, before the new one exists — an
  // old set of figures must never be acceptable once a newer offer has been made.
  await revokeMagicLinksForCard(card.id, 'superseded');

  let frozen;
  try {
    frozen = await freezeQuoteVersion({
      groupId: card.group_id,
      jobCardId: card.id,
      createdByUserId: user.id as string,
      vatRegistered: !!card.group.vat_registered,
      taxLabel: card.group.tax_label || 'VAT',
    });
  } catch (e: any) {
    if (e?.message === 'NO_LINES') return res.status(400).json({ message: 'Add at least one line to the estimate before sending it.' });
    throw e;
  }

  const recipient = reach?.ok ? reach.address.trim() : '';
  // THE NOTE IS EMAIL-ONLY, and the quote_ready/quote_revised SMS renderers ignore it — a useful
  // note does not fit the one-segment budget and a truncated explanation is worse than none. It is
  // still written onto the version, because the customer's quote PAGE shows it and that page is
  // what the text links to. So a note sent "by text" is not lost; it is read on the link.
  if (note) await prisma.quoteVersion.update({ where: { id: frozen.id }, data: { note } }).catch(() => {});

  const link = await createMagicLink({
    groupId: card.group_id,
    jobCardId: card.id,
    purpose: 'quote_view',
    recipient: recipient || '(no address — link handed over)',
    createdByUserId: user.id as string,
  });
  await attachMagicLink(frozen.id, link.id, recipient || null);

  const garageName = card.group.trading_name || card.group.group_name || 'Your garage';
  /** An EMAIL went. Not "a send went" — this field is in months of quote.sent audit rows. */
  let emailed = false;
  /** A send went on the chosen channel, whichever it was. The new field; `emailed` keeps its meaning. */
  let sentOk = false;
  let deliveryStatus: string = 'not_attempted';
  let notificationId: string | null = null;
  let sendRefusalMessage: string | null = null;
  /** WHICH silence, as a stable code — so a caller or a test names the branch, not the prose. */
  let sendRefusalCode: string | null = null;
  /** Would trying again plausibly work? Only a provider rejection is retryable. */
  let sendRetryable = false;

  if (recipient) {
    const sent = await sendNotification({
      recipient,
      template: isRevision ? 'quote_revised' : 'quote_ready',
      channel,
      groupId: card.group_id,
      subject: { type: 'job_card', id: card.id },
      data: {
        garageName,
        // THE REPLY ROUTE. The alphanumeric sender is one-way, so a customer who replies to this text
        // reaches nobody. Site number first, group number as the fallback — the same precedence every
        // other contact surface uses (lib/contact-routes), never a second resolution invented here.
        garagePhone: resolveContactRoutes(card.site, card.group).phone,
        registration: card.vehicle?.registration ?? null,
        total: formatMoney(frozen.grossPennies, { currency: card.site?.currency_code ?? 'GBP', locale: card.site?.locale ?? 'en-GB' }),
        // EMAIL ONLY — the sms renderer ignores it. Any useful note breaks the one-segment budget,
        // and a truncated explanation is worse than none; the link carries it instead.
        note,
        link: link.url,
        expiryDays: MAGIC_LINK_DAYS,
      },
    });
    sentOk = sent.ok;
    emailed = sent.ok && channel === 'email';
    deliveryStatus = sent.status;
    notificationId = sent.notificationId;
    // WHY IT DIDN'T GO, in the operator's words. A suppressed or refused send is not an error —
    // the version is frozen and the link is real — but "sent" would be a lie and silence is worse.
    // The allowance can still be spent here despite the pre-check above: two operators sending at
    // the same moment both read a balance of one.
    if (!sent.ok) {
      // ONE MAPPING, shared with invoice-sms. This used to name two skip codes and sweep every
      // other cause into the single sentence:
      //     "The text couldn’t be sent, but the link below still works."
      // Which is what a DEMO TENANT’s deliberate refusal said on 2026-08-18, pointing the
      // diagnosis at a provider that had never been contacted.
      const why = describeSendFailure(sent as FailedSend, {
        channel,
        customerName: reach && 'customerName' in reach ? reach.customerName : null,
      });
      sendRefusalMessage = `${why.message} The quote is frozen and the link below still works.`;
      sendRefusalCode = why.code;
      sendRetryable = why.retryable;
    }
  }

  // The card becomes `quoted` on the first send; a later send doesn't drag it backwards from a
  // further-on status (2b owns the accepted transition).
  if (card.status === 'draft') {
    await prisma.jobCard.update({ where: { id: card.id }, data: { status: 'quoted' } }).catch(() => {});
  }

  await writeAudit(prisma, {
    groupId: card.group_id,
    userId: user.id as string,
    jobCardId: card.id,
    action: 'quote.sent',
    diff: {
      version: frozen.version,
      lines: frozen.lineCount,
      grossPennies: frozen.grossPennies,
      // `emailed` KEEPS ITS MEANING — an email went. Months of rows already carry it and a reader
      // asking "was this emailed?" must not start getting yes for a text. `channel` and `sent` are
      // the new facts, added alongside rather than folded into the old field.
      emailed,
      channel,
      sent: sentOk,
      sentTo: recipient || null,
      handedOver: !recipient, // no address on that channel — the link was offered instead of a send
      // WHAT WAS SAID, on the card's own history. The note goes to the customer; staff need to be
      // able to see afterwards what they were told, without opening the customer's link.
      note,
    },
  }).catch(() => {});

  return res.status(200).json({
    ok: true,
    version: frozen.version,
    quoteVersionId: frozen.id,
    url: link.url,            // ALWAYS returned — copyable by hand
    expiresAt: link.expiresAt.toISOString(),
    expiryDays: MAGIC_LINK_DAYS,
    emailed,
    channel,
    sent: sentOk,
    sentTo: recipient || null,
    // Why nothing went, when nothing went. Two different silences: no address on file at all
    // (unreachableReason) and an address we could not use (sendRefusalMessage).
    unreachableReason,
    sendRefusalMessage,
    sendRefusalCode,
    sendRetryable,
    deliveryStatus,
    notificationId,
    ...(channel === 'sms' ? { allowance: await smsAllowance(prisma, card.group_id) } : {}),
    totals: { netPennies: frozen.netPennies, vatPennies: frozen.vatPennies, grossPennies: frozen.grossPennies },
  });
}
