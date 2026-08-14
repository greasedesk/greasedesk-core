/**
 * File: components/payments/StripeEmbeddedPanel.tsx
 * Stripe's embedded Connect components, rendered INSIDE the GreaseDesk workspace — the garage's own
 * payments, payout history and account details, without leaving the product.
 *
 * ── CLIENT-ONLY, AND MOUNTED ONLY WHEN THERE IS SOMETHING TO SHOW ───────────────────────────────
 * Stripe's loader touches `window`, so the page imports this with `ssr: false`. It is mounted only
 * for a READY connection: an incomplete or restricted account gets the page's own state copy, which
 * says what to do about it, and an empty Stripe box beside that message would contradict it.
 *
 * ── WHY PAYOUTS_LIST AND NOT PAYOUTS ────────────────────────────────────────────────────────────
 * Standard accounts are ones where Stripe collects requirements, which is exactly the condition
 * that makes Stripe demand its own sign-in for some components — Balances, Payouts, Account
 * management and the Notification banner. The popup can't be styled or suppressed, and the feature
 * that would disable it is only offered on configurations where we take on liability for negative
 * balances (the thing the Standard ruling exists to avoid). So payout HISTORY, which needs no
 * sign-in, answers "have I been paid" — and only Account details, which genuinely cannot avoid it,
 * warns that Stripe may ask.
 *
 * ── THE THEME IS READ, NOT HARDCODED ────────────────────────────────────────────────────────────
 * Stripe's appearance API wants colour values, and this app has light and dark palettes behind
 * semantic CSS variables. The values are read off the document at mount, so the embedded panel
 * follows the workspace instead of pinning a second copy of the palette that goes stale.
 */
import React from 'react';
import { loadConnectAndInitialize } from '@stripe/connect-js';
import {
  ConnectComponentsProvider,
  ConnectPayments,
  ConnectPayoutsList,
  ConnectAccountManagement,
} from '@stripe/react-connect-js';
import type { PanelKey } from '@/lib/payment-providers';

type Boot = { clientSecret: string; publishableKey: string };

async function mintSession(): Promise<Boot> {
  const r = await fetch('/api/stripe/account-session', { method: 'POST', cache: 'no-store' });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d?.clientSecret) throw new Error(d?.message || 'Could not open the payments view.');
  return { clientSecret: d.clientSecret, publishableKey: d.publishableKey };
}

/** Read a semantic token off the document so the embedded panel matches the workspace it sits in. */
function token(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export default function StripeEmbeddedPanel({ panels }: { panels: Array<{ key: PanelKey; label: string; mayAuthenticate: boolean }> }) {
  const [instance, setInstance] = React.useState<any>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [tab, setTab] = React.useState<PanelKey>(panels[0]?.key ?? 'payments');

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const boot = await mintSession();
        if (cancelled) return;
        // The first secret is already in hand — hand it straight back rather than minting a second
        // one on load. Every later call is a genuine refresh, because sessions expire.
        let first: string | null = boot.clientSecret;
        const connect = await loadConnectAndInitialize({
          publishableKey: boot.publishableKey,
          fetchClientSecret: async () => {
            if (first) { const s = first; first = null; return s; }
            return (await mintSession()).clientSecret;
          },
          appearance: {
            variables: {
              colorPrimary: token('--accent', '#2563EB'),
              colorBackground: token('--surface', '#FFFFFF'),
              colorText: token('--text', '#0F1E33'),
              colorDanger: token('--danger', '#B91C1C'),
              borderRadius: '8px',
            },
          },
        });
        if (!cancelled) setInstance(connect);
      } catch (e: any) {
        if (!cancelled) setErr(e?.message || 'Could not open the payments view.');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (err) {
    return (
      <div className="bg-surface border border-line rounded-xl p-5" data-testid="stripe-panel-error">
        <p className="text-sm text-muted">{err}</p>
        <p className="text-xs text-muted mt-1">Your connection is unaffected — this is only the in-page view.</p>
      </div>
    );
  }
  if (!instance) return <div className="bg-surface border border-line rounded-xl p-5 text-sm text-muted" data-testid="stripe-panel-loading">Loading…</div>;

  const current = panels.find((p) => p.key === tab);

  return (
    <div data-testid="stripe-panel">
      <div className="flex gap-1 mb-3" role="tablist">
        {panels.map((p) => (
          <button
            key={p.key}
            role="tab"
            aria-selected={tab === p.key}
            onClick={() => setTab(p.key)}
            data-testid={`stripe-tab-${p.key}`}
            className={`text-sm px-3 py-2 rounded-lg transition-colors ${
              tab === p.key ? 'bg-accent text-white font-semibold' : 'text-muted hover:text-ink hover:bg-surface-muted'
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Said BEFORE the popup appears, not after. An unexplained Stripe sign-in window reads as a
          phishing attempt, and the garage would be right to think so. */}
      {current?.mayAuthenticate && (
        <p className="text-xs text-muted mb-2" data-testid="stripe-auth-notice">
          Stripe may ask you to sign in to view or change these details — it protects your bank details, and we can’t see them.
        </p>
      )}

      <div className="bg-surface border border-line rounded-xl p-5">
        <ConnectComponentsProvider connectInstance={instance}>
          {tab === 'payments' && <ConnectPayments />}
          {tab === 'payouts' && <ConnectPayoutsList />}
          {tab === 'account' && <ConnectAccountManagement />}
        </ConnectComponentsProvider>
      </div>
    </div>
  );
}
