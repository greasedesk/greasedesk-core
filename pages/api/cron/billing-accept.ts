/**
 * File: pages/api/cron/billing-accept.ts
 * TEMPORARY item-12 acceptance harness (delete after the run). Drives the Stripe SANDBOX with test
 * clocks and reports VERBATIM Stripe object state at each step — the app's keys live here on Vercel.
 * CRON_SECRET Bearer. Touches ONLY Stripe test objects (its own throwaway customers/clocks) — never
 * TMBS, never our DB. Sandbox only.
 *
 * Ops (call in order, threading ids via query params):
 *   ?op=setup&card=<num>        → clock + customer(on clock) + PM + off_session SetupIntent + trialing sub
 *   ?op=quantity&sub=&item=&customer=  → qty 1→2 (proration) then 2→1 (credit)
 *   ?op=advance&clock=&sub=&days=61    → advance the clock past trial; report renewal invoice + PaymentIntent
 *   ?op=cancel&sub=             → cancel; report status
 *   ?op=cleanup&clock=          → delete the test clock (removes its customers/subs)
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getStripe, stripePriceId } from '@/lib/stripe';

export const config = { maxDuration: 60 };

const j = (o: any) => JSON.parse(JSON.stringify(o)); // strip class wrappers for clean output

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ message: 'Not authorised.' });
  const stripe = getStripe();
  const price = stripePriceId();
  if (!stripe || !price) return res.status(503).json({ message: 'Stripe not configured.' });
  const op = String(req.query.op || '');
  const q = (k: string) => (req.query[k] ? String(req.query[k]) : '');

  try {
    if (op === 'setup') {
      const cardNum = q('card') || '4000002500003155'; // requires auth on-session, succeeds off-session
      const clock = await (stripe as any).testHelpers.testClocks.create({ frozen_time: Math.floor(Date.now() / 1000) });
      const customer = await stripe.customers.create({ test_clock: clock.id, email: `zz-accept-${clock.id.slice(-6)}@example.com`, name: 'ZZ Acceptance' });
      // Attach a card + establish an OFF-SESSION mandate via a SetupIntent (what Checkout does at day 1).
      const pm = await stripe.paymentMethods.create({ type: 'card', card: { number: cardNum, exp_month: 12, exp_year: 2032, cvc: '123' } as any });
      await stripe.paymentMethods.attach(pm.id, { customer: customer.id });
      await stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: pm.id } });
      let setupIntent: any = null, setupErr: any = null;
      try {
        setupIntent = await stripe.setupIntents.create({ customer: customer.id, payment_method: pm.id, usage: 'off_session', confirm: true, automatic_payment_methods: { enabled: true, allow_redirects: 'never' } });
      } catch (e: any) { setupErr = { type: e?.type, code: e?.code, message: e?.message, decline_code: e?.decline_code }; }
      const sub = await stripe.subscriptions.create({
        customer: customer.id, items: [{ price, quantity: 1 }], trial_period_days: 60,
        default_payment_method: pm.id, off_session: true,
        trial_settings: { end_behavior: { missing_payment_method: 'create_invoice' } },
        payment_behavior: 'default_incomplete', expand: ['latest_invoice.payment_intent', 'items.data'],
      } as any).catch(async () => stripe.subscriptions.create({ customer: customer.id, items: [{ price, quantity: 1 }], trial_period_days: 60, default_payment_method: pm.id, off_session: true, trial_settings: { end_behavior: { missing_payment_method: 'create_invoice' } }, expand: ['latest_invoice', 'items.data'] } as any));
      return res.status(200).json({ op, clock: clock.id, customer: customer.id, pm: pm.id, sub: sub.id, item: (sub as any).items?.data?.[0]?.id,
        subscription_status: sub.status, latest_invoice_amount_due: (sub as any).latest_invoice?.amount_due, setupIntent_status: setupIntent?.status ?? null, setupIntent_next_action: setupIntent?.next_action?.type ?? null, setupErr,
        report: { subscription_status: sub.status, charged: (sub as any).latest_invoice?.amount_paid ?? 0, mandate: setupIntent?.status } });
    }

    if (op === 'quantity') {
      const sub = q('sub'); const item = q('item'); const customer = q('customer');
      const up2 = await stripe.subscriptions.update(sub, { items: [{ id: item, quantity: 2 }], proration_behavior: 'create_prorations' });
      const upcoming2 = await (stripe.invoices as any).retrieveUpcoming({ customer });
      const down1 = await stripe.subscriptions.update(sub, { items: [{ id: item, quantity: 1 }], proration_behavior: 'create_prorations' });
      const upcoming1 = await (stripe.invoices as any).retrieveUpcoming({ customer });
      return res.status(200).json({ op,
        after_up_qty: (up2 as any).items.data[0].quantity,
        upcoming_after_up_lines: upcoming2.lines.data.map((l: any) => ({ desc: l.description, amount: l.amount, proration: l.proration })),
        after_down_qty: (down1 as any).items.data[0].quantity,
        upcoming_after_down_lines: upcoming1.lines.data.map((l: any) => ({ desc: l.description, amount: l.amount, proration: l.proration })),
        upcoming_after_down_total: upcoming1.total });
    }

    if (op === 'advance') {
      const clock = q('clock'); const sub = q('sub'); const days = Number(q('days') || 61);
      const target = Math.floor(Date.now() / 1000) + days * 86400;
      await (stripe as any).testHelpers.testClocks.advance({ frozen_time: target } as any, undefined as any).catch(async () => (stripe as any).testHelpers.testClocks.advance(clock, { frozen_time: target }));
      // poll until ready
      let c: any; for (let i = 0; i < 25; i++) { c = await (stripe as any).testHelpers.testClocks.retrieve(clock); if (c.status === 'ready') break; await new Promise((r) => setTimeout(r, 1500)); }
      const s: any = await stripe.subscriptions.retrieve(sub, { expand: ['latest_invoice.payment_intent'] });
      const pi = s.latest_invoice?.payment_intent;
      return res.status(200).json({ op, clock_status: c?.status, subscription_status: s.status,
        latest_invoice_id: s.latest_invoice?.id, latest_invoice_status: s.latest_invoice?.status, latest_invoice_amount_paid: s.latest_invoice?.amount_paid,
        payment_intent_id: pi?.id, payment_intent_status: pi?.status, payment_intent_next_action: pi?.next_action?.type ?? null,
        off_session: true, report_THE_ONE: { payment_intent_status: pi?.status, next_action: pi?.next_action?.type ?? 'none', invoice_status: s.latest_invoice?.status } });
    }

    if (op === 'cancel') {
      const s = await stripe.subscriptions.cancel(q('sub'));
      return res.status(200).json({ op, subscription_status: s.status, canceled_at: s.canceled_at });
    }

    if (op === 'cleanup') {
      await (stripe as any).testHelpers.testClocks.del(q('clock'));
      return res.status(200).json({ op, deleted_clock: q('clock') });
    }

    return res.status(400).json({ message: 'op must be setup|quantity|advance|cancel|cleanup' });
  } catch (e: any) {
    return res.status(200).json({ op, error: { type: e?.type, code: e?.code, message: e?.message, param: e?.param, decline_code: e?.decline_code, raw: e?.raw?.message } });
  }
}
