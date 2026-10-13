/**
 * File: pages/api/quote-respond.ts
 * POST { token, action: 'accept' | 'decline' } — the CUSTOMER's answer to a quote.
 *
 * AUTHENTICATED BY THE MAGIC LINK ALONE. There is no session: the token IS the credential
 * (lib/magic-link states that trade plainly). Which is exactly why the answer is recorded at
 * AUDIT GRADE — WHICH QuoteVersion, WHEN, from WHAT IP and WHAT user-agent — the same weight as the
 * rep agreement's click-sign. If the price is disputed later, the accepted version is frozen and the
 * acceptance is attributable.
 *
 * Bounded by design, per the magic-link rule: this endpoint moves no money and destroys nothing. It
 * writes one decision onto one version, flips one card status, and notifies the garage.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { resolveMagicLink, revokeMagicLinksForCard } from '@/lib/magic-link';
import { clientIp } from '@/lib/auth-rate-limit';
import { sendNotification } from '@/lib/notify';
import { resolveOpsEmail, OPS_EMAIL_SELECT } from '@/lib/ops-email';
import { formatMoney } from '@/lib/format-money';
import { writeAudit } from '@/lib/audit';
import { acceptQuote, refuseQuoteAnswer } from '@/lib/quote-acceptance';
import type { Selection } from '@/lib/quote-options';

/** Shape-only: ids stay strings and a group's value stays string-or-null. What those ids MEAN is
 *  lib/quote-acceptance's question, and it refuses rather than narrowing. */
function normaliseSelection(v: unknown): Selection | null {
  if (!v || typeof v !== 'object') return null;
  // ONE SHAPE FOR BOTH GROUP SHAPES: groupId -> the ids chosen in it. An absent or empty list is a
  // DECLINE, which is a valid answer to every group, so nothing here invents a default. Anything
  // that is not a string is dropped rather than coerced — a selection is the agreement, and a
  // coerced id would be an agreement to something nobody picked.
  const o = v as { byGroup?: unknown };
  const byGroup: Record<string, string[]> = {};
  if (o.byGroup && typeof o.byGroup === 'object') {
    for (const [k, val] of Object.entries(o.byGroup as Record<string, unknown>)) {
      byGroup[k] = Array.isArray(val) ? val.filter((x): x is string => typeof x === 'string') : [];
    }
  }
  return { byGroup };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ message: 'Method Not Allowed' });
  }
  const { token, action, selection } = (req.body ?? {}) as { token?: string; action?: string; selection?: unknown };
  if (!token || (action !== 'accept' && action !== 'decline')) {
    return res.status(400).json({ message: 'A token and an action (accept or decline) are required.' });
  }

  const ip = clientIp(req.headers as any);
  const ua = String(req.headers['user-agent'] ?? '').slice(0, 500);

  const resolved = await resolveMagicLink(token, { purpose: 'quote_view', ip, recordUse: false });
  if (!resolved.ok) {
    const code = resolved.reason === 'expired' ? 410 : resolved.reason === 'rate_limited' ? 429 : 404;
    return res.status(code).json({ message: 'This quote link is no longer valid.', reason: resolved.reason });
  }

  const version = await prisma.quoteVersion.findFirst({
    where: { job_card_id: resolved.link.jobCardId, magic_link_id: resolved.link.id },
    select: { id: true, version: true, status: true, gross_pennies: true, group_id: true },
  });
  if (!version) return res.status(404).json({ message: 'This quote is no longer available.' });

  // Already answered → idempotent, not an error. A customer double-tapping "Accept" on a flaky
  // phone connection must not see a failure for something that already worked.
  if (version.status === 'accepted' || version.status === 'declined') {
    return res.status(200).json({ ok: true, already: true, outcome: version.status, version: version.version });
  }
  if (version.status === 'superseded') {
    return res.status(409).json({ message: 'This quote has been replaced by a newer one.', reason: 'superseded' });
  }

  const card = await prisma.jobCard.findUnique({
    where: { id: resolved.link.jobCardId },
    select: {
      id: true, group_id: true, status: true,
      customer: { select: { name: true } },
      vehicle: { select: { registration: true } },
      site: { select: { currency_code: true, locale: true } },
      group: { select: { group_name: true, trading_name: true, ...OPS_EMAIL_SELECT } },
    },
  });
  if (!card) return res.status(404).json({ message: 'This quote is no longer available.' });

  const now = new Date();
  const accepted = action === 'accept';

  // ── IS THIS CARD STILL OPEN TO AN ANSWER? ────────────────────────────────────────────────────
  // Asked for BOTH outcomes, from the one predicate, BEFORE anything is written. A quote link
  // outlives the state it was minted for: this card had already been invoiced, and the customer
  // was still holding a live link to approve the price.
  const refusal = refuseQuoteAnswer(card.status, accepted ? 'accepted' : 'declined');
  if (refusal) return res.status(409).json({ code: refusal.code, message: refusal.message });

  try {
  await prisma.$transaction(async (tx: any) => {
    if (accepted) {
      // ONE acceptance rule for every door — version, card, accepted_at and audit, in this tx.
      // The ip/ua go in as `attested`: this is the only path where a CUSTOMER is the actor.
      await acceptQuote(tx, {
        groupId: card.group_id, jobCardId: card.id, via: 'link',
        actorUserId: null, attested: { ip, userAgent: ua }, at: now,
        // PASSED STRAIGHT THROUGH, unvalidated here: lib/quote-acceptance resolves it against the
        // options the version actually carries and refuses anything that does not fit. Checking it
        // here as well would be a second opinion about what was agreed.
        selection: normaliseSelection(selection),
      });
      return;
    }
    // DECLINING is not acceptance and keeps its own shape: the version records the answer and the
    // card stays exactly where it is — the garage decides what happens next.
    await tx.quoteVersion.update({
      where: { id: version.id },
      data: { status: 'declined', responded_at: now, responded_ip: ip, responded_user_agent: ua },
    });
    await writeAudit(tx, {
      groupId: card.group_id,
      userId: null, // the CUSTOMER acted — attribution is the ip/ua on the version
      jobCardId: card.id,
      action: 'quote.declined',
      diff: { version: version.version, grossPennies: version.gross_pennies, at: now.toISOString(), ip, userAgent: ua },
    });
  });
  } catch (e: any) {
    // A CUSTOMER MUST NEVER SEE A STACK TRACE FROM A STATE WE CREATED. acceptQuote throws
    // ILLEGAL_TRANSITION as its own backstop; the check above should already have caught it, so
    // reaching here means the card moved between the check and the write. Same sentence either way.
    const msg = String(e?.message ?? '');
    /**
     * A REFUSED SELECTION IS THE CUSTOMER'S PROBLEM TO SOLVE, so it gets its own sentence rather
     * than "something went wrong". Every one of these means the page they are holding no longer
     * matches the quote — a stale tab, or a quote re-sent while they were reading.
     */
    if (msg.startsWith('SELECTION_REFUSED:')) {
      return res.status(409).json({ code: 'selection_refused', message: msg.slice('SELECTION_REFUSED:'.length) });
    }
    if (msg === 'SELECTION_REQUIRED') {
      return res.status(400).json({ code: 'selection_required', message: 'Please choose which options you would like before accepting.' });
    }
    if (msg === 'SELECTION_WITHOUT_OPTIONS' || msg.startsWith('OPTIONS_UNSENDABLE')) {
      console.warn('[quote-respond] stale options page —', msg, 'card', card.id);
      return res.status(409).json({ code: 'quote_changed', message: 'This quote has changed since you opened it — please ask the garage to send it again.' });
    }
    if (msg.startsWith('ILLEGAL_TRANSITION') || msg === 'CARD_NOT_FOUND') {
      console.warn('[quote-respond] refused after check —', msg, 'card', card.id);
      return res.status(409).json({ code: 'already_actioned', message: 'This quote has already been actioned — please contact the garage.' });
    }
    console.error('[quote-respond] failed', msg, 'card', card.id);
    return res.status(500).json({ message: 'Something went wrong — please call the garage.' });
  }

  // A DECLINE ends the link — the offer is over. An ACCEPT deliberately leaves it live so the
  // customer can re-open what they agreed to.
  if (!accepted) await revokeMagicLinksForCard(card.id, 'declined').catch(() => {});

  const garageName = card.group.trading_name || card.group.group_name || 'your garage';
  const total = formatMoney(version.gross_pennies, { currency: card.site?.currency_code ?? 'GBP', locale: card.site?.locale ?? 'en-GB' });
  // THE GARAGE'S OWN ADDRESS, not the billing identity. This used to read billing_email directly —
  // the address captured from whoever filled in the signup form — so a real tenant's acceptance
  // notifications went to a personal inbox while its configured address sat unused.
  const ops = resolveOpsEmail(card.group);
  if (ops.address) await sendNotification({
    recipient: ops.address,
    template: accepted ? 'quote_accepted' : 'quote_declined',
    channel: 'email',
    groupId: card.group_id,
    subject: { type: 'job_card', id: card.id },
    data: {
      garageName,
      customerName: card.customer?.name ?? 'The customer',
      registration: card.vehicle?.registration ?? null,
      version: version.version,
      total,
      when: now.toLocaleString(card.site?.locale ?? 'en-GB'),
      link: `${process.env.NEXT_PUBLIC_APP_URL || 'https://greasedesk.com'}/admin/jobcards/${card.id}`,
    },
  });

  return res.status(200).json({ ok: true, outcome: accepted ? 'accepted' : 'declined', version: version.version });
}
