/**
 * File: lib/trial-reminder.ts
 * WHAT A GARAGE IS ABOUT TO BE CHARGED, AND WHEN — composed once, sent from Stripe's own
 * `customer.subscription.trial_will_end` event (three days before the trial ends).
 *
 * ── THIS IS NEW, NOT AN EXTENSION (2026-10-28) ─────────────────────────────────────────────────
 * Nothing sent a trial-end reminder before: `trial_will_end` was not among the events the webhook
 * handled, so the first a garage knew of the charge was the charge. Survivable at £75 a month.
 * Annual makes it £750 taken in one go from a card typed in thirty days earlier — the single most
 * likely thing to be disputed, and a bad thing to do to somebody regardless.
 *
 * ── IT DESCRIBES THE SUBSCRIPTION, NOT OUR INTENTION ───────────────────────────────────────────
 * The amount comes from the subscription's OWN item and its discount, not from re-running the
 * price arithmetic: the point of the message is to state what Stripe is about to take. A garage
 * on the affiliate offer is told £600 because the coupon is on the subscription, and the note
 * says what it renews at — a figure it is entitled to know before the money moves, not a year
 * later.
 */
import type Stripe from 'stripe';
import { prisma } from '@/lib/db';
import { sendNotification } from '@/lib/notify';
import { formatMoney } from '@/lib/format-money';
import { appBaseUrl } from '@/lib/stripe';

/** What the subscription's single plan line costs per period, before any discount, in pennies. */
function lineAmountPennies(sub: Stripe.Subscription): number | null {
  const item = sub.items?.data?.[0];
  const unit = typeof item?.price === 'string' ? null : item?.price?.unit_amount ?? null;
  if (unit == null) return null;
  return unit * (item?.quantity ?? 1);
}

/**
 * Send the reminder for this subscription. Returns what happened, so the webhook can log a
 * sentence rather than a boolean. Never throws: a reminder that fails must not make Stripe retry
 * the event and must not affect the subscription.
 */
export async function sendTrialEndingReminder(sub: Stripe.Subscription): Promise<{ sent: boolean; why: string }> {
  try {
    const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
    const billing = customerId
      ? await prisma.groupBilling.findFirst({ where: { stripe_customer_id: customerId }, select: { group_id: true } })
      : null;
    const groupId = billing?.group_id ?? null;
    if (!groupId) return { sent: false, why: 'no tenant matches this Stripe customer' };

    const group = await prisma.group.findUnique({
      where: { id: groupId }, select: { billing_email: true, group_name: true },
    });
    // THREE SILENCES ARE NOT ONE. "No address on file" is a different fact from "the provider
    // refused"; sendNotification reports the second, and this reports the first rather than
    // letting it look like a send that happened.
    if (!group?.billing_email) return { sent: false, why: 'the garage has no billing email on file' };

    const trialEnd = (sub as any).trial_end ? new Date((sub as any).trial_end * 1000) : null;
    if (!trialEnd) return { sent: false, why: 'the subscription carries no trial end' };

    const interval = (() => {
      const item = sub.items?.data?.[0];
      return typeof item?.price === 'string' ? null : item?.price?.recurring?.interval ?? null;
    })();
    const gross = lineAmountPennies(sub);
    if (gross == null) return { sent: false, why: 'the subscription line carries no amount' };

    // THE DISCOUNT THAT IS ACTUALLY ON IT. A duration:'once' coupon comes off the FIRST invoice,
    // which is the one this message is about — so the figure quoted is what will be taken, and
    // the renewal figure is stated separately rather than conflated with it.
    const discount = (sub as any).discounts?.[0]?.coupon?.amount_off
      ?? (sub as any).discount?.coupon?.amount_off
      ?? 0;
    const charge = Math.max(0, gross - (typeof discount === 'number' ? discount : 0));
    const currency = (typeof sub.items?.data?.[0]?.price === 'string' ? null : sub.items?.data?.[0]?.price?.currency) ?? 'gbp';

    const annual = interval === 'year';
    const planLabel = annual ? 'annual' : 'monthly';
    const note = annual && charge !== gross
      ? `That is your first year at the referral price. It renews at ${formatMoney(gross, { currency: currency.toUpperCase() })} a year after that.`
      : annual
        ? `That covers the twelve months from ${trialEnd.toLocaleDateString('en-GB')}.`
        : null;

    const sent = await sendNotification({
      recipient: group.billing_email,
      template: 'trial_ending',
      channel: 'email',
      groupId,
      data: {
        name: group.group_name ?? 'there',
        when: trialEnd.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }),
        planLabel,
        amount: formatMoney(charge, { currency: currency.toUpperCase() }),
        note,
        link: `${appBaseUrl()}/admin/settings/licences`,
      },
    });
    return sent.ok
      ? { sent: true, why: `${planLabel} ${formatMoney(charge, { currency: currency.toUpperCase() })}` }
      : { sent: false, why: `${sent.status}: ${sent.reason ?? 'no reason given'}` };
  } catch (e: any) {
    console.error('[trial-reminder] failed —', e?.message);
    return { sent: false, why: String(e?.message ?? 'threw') };
  }
}
