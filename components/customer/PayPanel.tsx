/**
 * File: components/customer/PayPanel.tsx
 * The customer's card form. Client-only; Stripe's SDK touches `window`.
 *
 * ── IT NEVER CLAIMS THE INVOICE IS PAID ─────────────────────────────────────────────────────────
 * The single most important thing here. `confirmPayment` resolving means the CARD was accepted, not
 * that the money is recorded — fulfilment happens on the webhook, which may land a second later or,
 * on a retry, a minute later. Saying "paid" here would put the customer's word and our ledger out
 * of step for as long as that takes, and would be a lie outright if the webhook never arrived. So
 * the success state says the payment is going through and that a receipt follows. The invoice's own
 * figures are untouched until the webhook says otherwise.
 *
 * ── THE AMOUNT IS DISPLAY ONLY ──────────────────────────────────────────────────────────────────
 * What is charged is re-derived server-side at PaymentIntent creation; nothing this component knows
 * about money can influence it. The figure shown comes back FROM the endpoint precisely so the two
 * cannot disagree — it is the amount that was actually put on the intent, not the page's opinion.
 *
 * ── A CONNECTED ACCOUNT NEEDS ITS OWN Stripe INSTANCE ───────────────────────────────────────────
 * Direct charges live on the garage's account, so loadStripe carries `stripeAccount`. Getting that
 * wrong does not fail loudly — it produces a form that talks to the platform account instead.
 */
import React from 'react';
import { loadStripe, type Stripe as StripeJs } from '@stripe/stripe-js';
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js';
import { formatMoney } from '@/lib/format-money';

type Intent = { clientSecret: string; publishableKey: string; accountId: string; amountPennies: number; currency: string };

const btn = 'w-full text-sm font-semibold rounded-lg px-4 py-3 bg-accent hover:bg-accent-hover text-white disabled:opacity-50';

export default function PayPanel({ token, locale, currency, amountPennies }: {
  token: string; locale: string; currency: string; amountPennies: number;
}) {
  const [intent, setIntent] = React.useState<Intent | null>(null);
  const [stripe, setStripe] = React.useState<StripeJs | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const money = (p: number) => formatMoney(p, { currency, locale });

  // ── SETTLED IS NOT THE SAME AS FAILED ────────────────────────────────────────────────────────
  // A retryable failure keeps the button: pressing again is the fix. A SETTLED refusal — the
  // invoice is void, already paid, under correction, the garage cannot take cards, we have no fee
  // rate — will say the same thing every time, and a Pay button sitting beside its own denial reads
  // as a broken product rather than as an unavailable option. This is the state TMBS's 100003205
  // showed a customer: an offer and a refusal at once.
  const [settled, setSettled] = React.useState(false);

  async function begin() {
    setBusy(true); setErr(null);
    try {
      const r = await fetch('/api/pay/intent', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d?.clientSecret) {
        setErr(d?.message || 'Card payment isn’t available just now.');
        // ABSENT retryable means we could not tell — a network failure, or a body we could not
        // parse. Keep the button: an unknown is not a settlement, and the customer pressing again
        // is exactly how an unknown resolves itself.
        if (d?.retryable === false) setSettled(true);
        return;
      }
      // The garage's account, not ours. A direct charge confirmed against the platform instance
      // fails in a way that looks like a card problem.
      const s = await loadStripe(d.publishableKey, { stripeAccount: d.accountId });
      if (!s) { setErr('Card payment couldn’t be loaded. Please try again.'); return; }
      setStripe(s); setIntent(d);
    } catch {
      setErr('Card payment couldn’t be started. Please try again.');
    } finally { setBusy(false); }
  }

  // The refusal ALONE. No button, and no "your card details never reach us" reassurance about a
  // payment that is not going to happen — the customer needs the reason and the way forward.
  if (settled) {
    return (
      <div className="mt-4" data-testid="pay-panel">
        <p className="text-sm text-danger" data-testid="pay-error">{err}</p>
      </div>
    );
  }

  if (!intent || !stripe) {
    return (
      <div className="mt-4" data-testid="pay-panel">
        <button type="button" onClick={begin} disabled={busy} className={btn} data-testid="pay-start">
          {busy ? 'Opening…' : `Pay ${money(amountPennies)} by card`}
        </button>
        {err && <p className="mt-2 text-sm text-danger" data-testid="pay-error">{err}</p>}
        <p className="mt-2 text-[11px] text-muted">
          Payments are handled by Stripe. Your card details never reach the garage or GreaseDesk.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-4" data-testid="pay-panel">
      <Elements stripe={stripe} options={{ clientSecret: intent.clientSecret }}>
        <PayForm token={token} amount={money(intent.amountPennies)} />
      </Elements>
    </div>
  );
}

function PayForm({ token, amount }: { token: string; amount: string }) {
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [done, setDone] = React.useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!stripe || !elements) return;
    setBusy(true); setErr(null);
    // `if_required` keeps most cards inline; 3-D Secure still redirects, and the return lands back
    // on this invoice with a marker so the page can say the same thing after a round trip.
    const res = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: `${window.location.origin}/c/${token}?pay=processing` },
      redirect: 'if_required',
    });
    setBusy(false);
    if (res.error) {
      // Stripe's own message is the right one here — it is written for cardholders and says things
      // like "your card was declined" that we could only paraphrase worse.
      setErr(res.error.message ?? 'That payment didn’t go through. Please try again or use another card.');
      return;
    }
    setDone(true);
  }

  if (done) {
    return (
      <div className="rounded-lg bg-ok-soft p-4" data-testid="pay-processing">
        <p className="text-sm font-semibold text-ok">Thank you — your payment is going through.</p>
        {/* Deliberately not "paid". The ledger says paid when the webhook says so, and until then
            claiming it here would put the customer's word ahead of our record. */}
        <p className="text-sm text-muted mt-1">
          The garage will send you a receipt once it’s confirmed. You don’t need to do anything else.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit}>
      <PaymentElement />
      <button type="submit" disabled={!stripe || busy} className={`${btn} mt-4`} data-testid="pay-confirm">
        {busy ? 'Paying…' : `Pay ${amount}`}
      </button>
      {err && <p className="mt-2 text-sm text-danger" data-testid="pay-error">{err}</p>}
    </form>
  );
}
