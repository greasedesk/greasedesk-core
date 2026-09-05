/**
 * File: pages/api/superadmin/trial-extend.ts
 * POST { groupId, next, category, note } → OPERATOR extends a tenant's trial. support-role.
 *
 * ── STRIPE OWNS THE TRIAL CLOCK, SO THIS DOES NOT WRITE THE MIRROR AND HOPE ─────────────────────
 * lib/stripe-billing-cache mirrors Stripe's trial_end onto Group.trial_ends_at on every
 * subscription webhook, and says so in its own header. Writing the mirror here would make a second
 * source of truth for a clock we do not own, and the next webhook would silently revert it.
 *
 * So: update the subscription, RE-READ it, and apply the re-read through applyStripeSubscriptionToCache
 * — the same writer the webhook calls. The mirror lands immediately, from Stripe's own value, and
 * the webhook stays idempotent when it arrives. The response carries the RE-READ date, never the
 * requested one, which is the pattern migrate-subscription-price already states: "trial_end will be
 * re-read after the real call and compared, not assumed."
 *
 * ── TWO BRANCHES, AND THE SECOND IS NOT A DEGRADED FIRST ────────────────────────────────────────
 * Two of the six live trials have NO subscription — signups that stalled before Checkout. There is
 * nothing to extend in Stripe, so Group.trial_ends_at is their only clock and the write is local.
 * That is a different act, not a lesser one, and the response says which was performed. Refusing
 * would block the case most likely to need help.
 *
 * ── BOTH LEDGERS ────────────────────────────────────────────────────────────────────────────────
 * SuperAdminAudit for accountability, and a row on the TENANT'S OWN AuditLog because somebody
 * outside the business changed when their card gets charged. user_id is null: nobody inside did it.
 * That second row is what ten other operator writes still owe — see the note in tenant-phone-exempt.
 *
 * EXTEND ONLY. Pulling a trial back moves the commission boundary; lib/trial-extension refuses it
 * by name and explains why.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { requireOperatorApi, tenantInScope } from '@/lib/operator-auth';
import { getStripe } from '@/lib/stripe';
import { applyStripeSubscriptionToCache } from '@/lib/stripe-billing-cache';
import { validateExtension, toStripeTrialEnd, resolveTrialDate } from '@/lib/trial-extension';
import { writeAudit } from '@/lib/audit';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).end(); }
  const actor = await requireOperatorApi(req, res, { minRole: 'support' });
  if (!actor) return;

  const { groupId, next, category, note } = (req.body || {}) as Record<string, string | undefined>;
  if (!groupId) return res.status(400).json({ message: 'Missing groupId.' });
  // 404, NOT 403. The Engine Room is undiscoverable; a 403 confirms the tenant exists.
  if (!(await tenantInScope(actor, groupId))) return res.status(404).json({ message: 'Not found.' });

  const group = await prisma.group.findUnique({
    where: { id: groupId },
    select: {
      id: true, group_name: true, ref: true, trial_ends_at: true,
      billing: { select: { stripe_subscription_id: true } },
    },
  });
  if (!group) return res.status(404).json({ message: 'Not found.' });

  // EVERY REFUSAL BEFORE ANY CALL — including the two Stripe would make itself.
  // A PLAIN DATE FROM THE CONTROL, RESOLVED HERE. The browser sends YYYY-MM-DD and nothing else —
  // it used to append a fixed noon UTC, which made a same-day extension a reduction.
  const checked = validateExtension({
    current: group.trial_ends_at,
    next: next ? resolveTrialDate(next) : null,
    category, note,
  });
  if (!checked.ok) return res.status(400).json({ message: checked.message });

  const from = group.trial_ends_at;
  const subId = group.billing?.stripe_subscription_id ?? null;
  const stripe = getStripe();
  let stripeTrialEndAfter: Date | null = null;

  if (subId && stripe) {
    try {
      await stripe.subscriptions.update(
        subId,
        {
          trial_end: toStripeTrialEnd(checked.next),
          // The subscription is trialing, so there is nothing to prorate — and an unexpected
          // proration invoice on a tenant promised a free period is the surprise worth ruling out
          // rather than reasoning about. Same flag, same argument, as the price migration.
          proration_behavior: 'none',
        },
        { idempotencyKey: `trial:${subId}:${toStripeTrialEnd(checked.next)}` },
      );
      // RE-READ AND APPLY. Nothing below is assumed from the request.
      const fresh = await stripe.subscriptions.retrieve(subId);
      await applyStripeSubscriptionToCache(fresh, groupId);
      const t = (fresh as any).trial_end;
      stripeTrialEndAfter = typeof t === 'number' ? new Date(t * 1000) : null;
    } catch (e: any) {
      console.error('[trial-extend] stripe update failed', e?.message);
      return res.status(502).json({ message: `Stripe refused the change: ${e?.message ?? 'unknown error'}. Nothing has been altered.` });
    }
  } else {
    // NO SUBSCRIPTION: ours to move, and the only clock they have.
    await prisma.group.update({ where: { id: groupId }, data: { trial_ends_at: checked.next } });
  }

  const to = stripeTrialEndAfter ?? checked.next;

  // ── LEDGER ONE: OURS ─────────────────────────────────────────────────────────────────────────
  // The DIRECTION is in the action, not the payload — a field nobody filters on is a field nobody
  // reads. `stripeTrialEndAfter` is the RE-READ value: if it diverges from what we asked for, this
  // row is the only place that difference survives.
  await prisma.superAdminAudit.create({
    data: {
      operator_user_id: actor.userId, action: 'tenant.trial_extended',
      target_group_id: groupId, target_operator_id: null,
      target_name_snapshot: group.group_name, target_ref_snapshot: group.ref == null ? null : String(group.ref),
      reason: checked.note,
      detail: {
        from: from ? from.toISOString() : null,
        to: to.toISOString(),
        deltaDays: checked.deltaDays,
        category: checked.category,
        hadSubscription: !!subId,
        stripeSubscriptionId: subId,
        stripeTrialEndAfter: stripeTrialEndAfter ? stripeTrialEndAfter.toISOString() : null,
      },
    },
  }).catch(() => {});

  // ── LEDGER TWO: THEIRS ───────────────────────────────────────────────────────────────────────
  // Somebody outside the business changed when their card gets charged, and until now nothing on
  // their side of the boundary said so. userId null because nobody inside did it.
  await prisma.$transaction(async (tx) => {
    await writeAudit(tx, {
      groupId, userId: null, entity: 'group', entityId: groupId,
      action: 'billing.trial_extended',
      diff: { from: from ? from.toISOString() : null, to: to.toISOString(), deltaDays: checked.deltaDays },
    });
  }).catch(() => {});

  return res.status(200).json({
    ok: true,
    trialEndsAt: to.toISOString(),
    hadSubscription: !!subId,
    message: subId
      ? `Trial extended to ${to.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}. Stripe confirmed the new date.`
      : `Trial extended to ${to.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}. No subscription yet: this changes their trial date here only.`,
  });
}
