/**
 * File: components/layout/BillingBanner.tsx
 * THE billing banner, mounted once in AdminLayout so it reaches every /admin page rather than only
 * Settings → Licence, which is where lapse used to hide. Deliberately NOT on /m: a mechanic cannot
 * fix a billing problem, so the PWA stays silent and simply refuses to place work (ruling).
 *
 * ── THE WORDING FOLLOWS THE PHASE, AND THE PHASES ARE NOT INTERCHANGEABLE ───────────────────────
 *  grace      — a red countdown. Full functionality; say what happens when it runs out.
 *  restricted — OUR clock has run out. Stripe may STILL be retrying, so this must NOT say the
 *               subscription has lapsed. It says the payment hasn't arrived, and it names what
 *               still works, because what still works is most of the product.
 *  lapsed     — Stripe's own word. Read-only, and the existing non-punitive sentence.
 *
 * When Stripe cancels early the phase jumps straight from grace to lapsed: billingGate tests the
 * lapsed statuses first, so this can never render "3 days left" over an endpoint returning 402.
 */
import React, { useEffect, useState } from 'react';
import Link from 'next/link';

type Gate = { phase: 'ok' | 'grace' | 'restricted' | 'lapsed'; daysLeft: number | null; reason: string | null };

export default function BillingBanner() {
  const [gate, setGate] = useState<Gate | null>(null);
  useEffect(() => {
    let alive = true;
    fetch('/api/billing-gate', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive && d) setGate(d); })
      .catch(() => { /* the banner is not worth breaking a page over */ });
    return () => { alive = false; };
  }, []);

  if (!gate || gate.phase === 'ok') return null;

  const settings = <Link href="/admin/settings/licences" className="underline font-medium">Settings → Licence</Link>;

  if (gate.phase === 'grace') {
    const d = gate.daysLeft ?? 0;
    // The two populations get different first sentences; the consequence is identical.
    const why = gate.reason === 'trial_ended'
      ? 'Your trial has ended and we haven’t been able to take payment yet.'
      : 'We haven’t been able to take your subscription payment.';
    return (
      <div className="bg-danger-soft border-b border-danger text-danger px-4 sm:px-6 lg:px-8 py-2 text-sm" data-testid="billing-banner" data-phase="grace">
        <span className="font-semibold tabular-nums">{d} day{d === 1 ? '' : 's'} left</span>
        {' — '}{why} Everything works as normal until then. Update your card in {settings}.
      </div>
    );
  }

  if (gate.phase === 'restricted') {
    return (
      <div className="bg-danger-soft border-b border-danger text-danger px-4 sm:px-6 lg:px-8 py-2 text-sm" data-testid="billing-banner" data-phase="restricted">
        <span className="font-semibold">Your subscription payment hasn’t arrived</span>
        {' — new bookings are paused. You can still quote, add to jobs already in the workshop, and invoice them as normal. '}
        Update your card in {settings}.
      </div>
    );
  }

  return (
    <div className="bg-warn-soft border-b border-warn text-warn px-4 sm:px-6 lg:px-8 py-2 text-sm" data-testid="billing-banner" data-phase="lapsed">
      <span className="font-semibold">Your subscription has lapsed</span>
      {' — your records are safe and fully exportable. Resubscribe from '}{settings}{' to add new work.'}
    </div>
  );
}
