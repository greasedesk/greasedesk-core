/**
 * File: pages/u/[token].tsx
 * UNSUBSCRIBE FROM GREASEDESK'S FOLLOW-UP EMAILS — the link in every prospecting email's footer.
 *
 * ── OPENING THIS PAGE DOES NOTHING, AND THAT IS DELIBERATE ──────────────────────────────────────
 * Mail scanners follow links. If a GET unsubscribed, a corporate scanner would unsubscribe the
 * prospect before they had read the email — the same reason the rep sign-in page waits for a button.
 * The button POSTs. A mail client that supports RFC 8058 one-click never opens this page at all: it
 * POSTs straight to /api/prospect-unsubscribe from the List-Unsubscribe header.
 *
 * NO DATABASE IN THIS FILE, and no getServerSideProps: a page with none ships whole to the browser,
 * so anything imported here is in the bundle (client-bundle-gate; leaf-module-for-client-constants).
 */
import { useState } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';

export default function Unsubscribe() {
  const router = useRouter();
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'already' | 'unknown' | 'error'>('idle');

  const go = async () => {
    setState('busy');
    try {
      const r = await fetch(`/api/prospect-unsubscribe?t=${encodeURIComponent(String(router.query.token ?? ''))}`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click',
      });
      const j = await r.json().catch(() => ({}));
      setState(r.status === 404 ? 'unknown' : !r.ok ? 'error' : j.already ? 'already' : 'done');
    } catch {
      setState('error');
    }
  };

  return (
    <>
      <Head><title>Unsubscribe — GreaseDesk</title><meta name="robots" content="noindex" /></Head>
      <main className="min-h-screen flex items-center justify-center p-6 bg-slate-50">
        <div className="max-w-sm w-full text-center rounded-2xl p-8 bg-white border border-slate-200" data-testid="unsubscribe">
          <h1 className="text-lg font-semibold text-slate-900 mb-2">Stop GreaseDesk emails</h1>
          {state === 'done' && <p className="text-sm text-slate-600" data-testid="unsubscribe-done">Done. You won&apos;t hear from us again, and we&apos;ve removed your email address.</p>}
          {state === 'already' && <p className="text-sm text-slate-600" data-testid="unsubscribe-already">You&apos;re already unsubscribed. Nothing more will be sent.</p>}
          {state === 'unknown' && <p className="text-sm text-slate-600">We couldn&apos;t find that link. If you&apos;re still receiving emails, reply to one and we&apos;ll stop them.</p>}
          {state === 'error' && <p className="text-sm text-red-700">That didn&apos;t go through. Please try again.</p>}
          {(state === 'idle' || state === 'busy' || state === 'error') && (
            <>
              <p className="text-sm text-slate-500 mb-6">Press to stop the follow-up emails from GreaseDesk. One press, and it takes effect immediately.</p>
              <button onClick={go} disabled={state === 'busy'} data-testid="unsubscribe-button"
                className="w-full min-h-[48px] bg-slate-900 text-white rounded-lg font-medium disabled:opacity-60">
                {state === 'busy' ? 'Unsubscribing…' : 'Unsubscribe'}
              </button>
            </>
          )}
        </div>
      </main>
    </>
  );
}
