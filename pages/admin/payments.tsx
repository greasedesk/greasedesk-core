/**
 * File: pages/admin/payments.tsx
 * Payments (ADMIN only) — the garage's payment providers: how they're connected, and the money that
 * came through them, rendered inside GreaseDesk rather than on somebody else's dashboard.
 *
 * ── ADMIN-ONLY, THE SAME LINE HR DRAWS ──────────────────────────────────────────────────────────
 * Payout history and bank details are owner-grade. A `can_invoice` mechanic may RAISE an invoice and
 * still has no business seeing what landed in the bank. The nav flag is decoration; requireAdminPage
 * here and requireAdminApi on every endpoint are the gate — and, crucially, the Stripe Account
 * Session is minted from the server-side role too (lib/stripe-account-session), because with an
 * embedded component the SESSION is the permission and hiding a button is not.
 *
 * ── NO PROVIDER NAME IN THIS FILE'S LOGIC ───────────────────────────────────────────────────────
 * Every row is driven by lib/payment-providers, every state by lib/provider-connection. Payment
 * Assist and Bumper are both coming and both are per-dealer credentialed rather than redirect-based;
 * the only branch they need is `connection`, which decides whether the action redirects or opens a
 * form. Adding one should be a registry entry and a translator, not a page.
 */
import React from 'react';
import Head from 'next/head';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { requireAdminPage } from '@/lib/admin-guard';
import { withI18n } from '@/lib/gssp-i18n';
import { readConnections, providerState, type ProviderState } from '@/lib/provider-connection';
import { PROVIDERS, type ProviderDef } from '@/lib/payment-providers';

// Stripe's loader touches `window`; it must never run during SSR.
const StripeEmbeddedPanel = dynamic(() => import('@/components/payments/StripeEmbeddedPanel'), { ssr: false });

type Row = { def: ProviderDef; state: ProviderState };
type PageProps = { rows: Array<{ key: string; state: ProviderState }> };

const CHIP: Record<ProviderState['status'], { label: string; cls: string }> = {
  not_connected: { label: 'Not connected', cls: 'bg-surface-muted text-muted' },
  incomplete: { label: 'Setup unfinished', cls: 'bg-warn-soft text-warn' },
  ready: { label: 'Live', cls: 'bg-ok-soft text-ok' },
  restricted: { label: 'Paused', cls: 'bg-danger-soft text-danger' },
  disconnected: { label: 'Switched off', cls: 'bg-warn-soft text-warn' },
  unreachable: { label: 'Unavailable', cls: 'bg-danger-soft text-danger' },
};

function ProviderCard({ def, state: initial }: Row) {
  const [state, setState] = React.useState<ProviderState>(initial);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  // RESYNC ON MOUNT. The server rendered our cached view of the provider's truth, which is right
  // almost always — but a garage landing back here from an onboarding flow expects the page to know
  // it happened, and `return_url` only ever means "the flow was exited".
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(def.connectPath, { cache: 'no-store' });
        if (r.ok && !cancelled) { const d = await r.json(); if (d?.state) setState(d.state); }
      } catch { /* the cached state is already on screen; a failed resync is not worth an error */ }
    })();
    return () => { cancelled = true; };
  }, [def.connectPath]);

  async function connect() {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(def.connectPath, { method: 'POST' });
      const d = await r.json().catch(() => ({}));
      // A refusal carries a sentence written for a garage owner — show it, don't flatten it.
      if (!r.ok || !d?.url) { setErr(d?.message || `Could not start ${def.name} setup.`); return; }
      window.location.href = d.url;
    } catch { setErr(`Could not start ${def.name} setup.`); }
    finally { setBusy(false); }
  }

  const btn = 'mt-3 text-sm font-semibold rounded-lg px-4 py-2.5 bg-accent hover:bg-accent-hover text-white disabled:opacity-50';
  const chip = CHIP[state.status];

  const body = () => {
    switch (state.status) {
      case 'ready':
        return (
          <p className="text-sm text-muted" data-testid="connect-ready">
            Connected and able to take payments.
            {state.payoutsEnabled ? '' : ` Payouts to your bank aren’t enabled yet — ${def.name} will contact you if it needs anything.`}
          </p>
        );
      case 'incomplete':
        return (
          <>
            <p className="text-sm text-muted" data-testid="connect-incomplete">
              You can’t take payments through {def.name} until it has what it needs
              {state.requirementsDue?.length ? ` (${state.requirementsDue.length} item${state.requirementsDue.length === 1 ? '' : 's'} outstanding)` : ''}.
            </p>
            <button onClick={connect} disabled={busy} className={btn} data-testid="connect-continue">
              {busy ? 'Opening…' : 'Finish setting up'}
            </button>
          </>
        );
      case 'restricted':
        return (
          <>
            {/* The provider's own reason, verbatim — never our summary of it. */}
            <p className="text-sm text-muted" data-testid="connect-restricted">
              Reason given by {def.name}: <span className="text-ink">{state.reason ?? 'not stated'}</span>.
            </p>
            <p className="text-sm text-muted mt-1">Your other payment methods are unaffected — you can still take cash and bank transfers.</p>
            <button onClick={connect} disabled={busy} className={btn} data-testid="connect-fix">
              {busy ? 'Opening…' : `Sort this out with ${def.name}`}
            </button>
          </>
        );
      case 'disconnected':
        return (
          <>
            <p className="text-sm text-muted" data-testid="connect-disconnected">
              The {def.name} connection was removed. Reconnect to take payments again.
            </p>
            <button onClick={connect} disabled={busy} className={btn} data-testid="connect-reconnect">
              {busy ? 'Opening…' : `Reconnect ${def.name}`}
            </button>
          </>
        );
      case 'unreachable':
        return <p className="text-sm text-muted" data-testid="connect-unreachable">{state.reason}</p>;
      default:
        return (
          <>
            <p className="text-sm text-muted" data-testid="connect-none">{def.blurb}</p>
            <button onClick={connect} disabled={busy} className={btn} data-testid="connect-start">
              {busy ? 'Opening…' : `Set up ${def.name}`}
            </button>
          </>
        );
    }
  };

  return (
    <section className="mb-6" data-testid={`provider-${def.key}`}>
      <div className="bg-surface border border-line rounded-xl p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-ink">{def.name}</h2>
            <p className="text-xs text-muted mt-0.5">{def.tagline}</p>
          </div>
          <span className={`text-xs font-semibold px-2.5 py-1 rounded-full whitespace-nowrap ${chip.cls}`} data-testid={`provider-chip-${def.key}`}>
            {chip.label}
          </span>
        </div>
        <div className="mt-3">{body()}</div>
        {err && <p className="mt-2 text-sm text-danger" data-testid="connect-error">{err}</p>}
      </div>

      {/* The in-page view exists only where there is money to show and a provider that can show it. */}
      {state.status === 'ready' && def.panels.length > 0 && (
        <div className="mt-4">
          <StripeEmbeddedPanel panels={def.panels} />
        </div>
      )}
    </section>
  );
}

export default function PaymentsPage({ rows }: PageProps) {
  const byKey = new Map(rows.map((r) => [r.key, r.state]));
  return (
    <>
      <Head><title>Payments — GreaseDesk</title></Head>
      <div className="p-6 max-w-5xl">
        <h1 className="text-xl font-bold text-ink mb-1">Payments</h1>
        <p className="text-sm text-muted mb-6">
          How customers pay you, and what has reached your bank. How you <em>record</em> a payment —
          cash, card machine, bank transfer — stays under{' '}
          <Link href="/admin/settings/invoicing" className="text-accent hover:underline">Settings → Invoicing</Link>.
        </p>

        {PROVIDERS.map((def) => (
          <ProviderCard key={def.key} def={def} state={byKey.get(def.key) ?? { status: 'not_connected' }} />
        ))}
      </div>
    </>
  );
}

export const getServerSideProps = withI18n([])(async (ctx) => {
  const gate = await requireAdminPage(ctx);
  if (!gate.ok) return { redirect: gate.redirect };

  // One query for every provider, then the pure derivation. A provider with no row has never been
  // connected, which is the absence of a connection rather than a stored status.
  const conns = await readConnections(gate.vis.groupId as string);
  const rows = PROVIDERS.map((p) => ({ key: p.key, state: providerState(conns[p.key] ?? null) }));
  // Dates do not survive JSON; `disconnected` carries one, so it is serialised here rather than
  // left to blow up in the client.
  return { props: { rows: JSON.parse(JSON.stringify(rows)) } };
});
