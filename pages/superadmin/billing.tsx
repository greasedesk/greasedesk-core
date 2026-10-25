/**
 * File: pages/superadmin/billing.tsx
 * Programme billing settings — OWNER ONLY (gSSP enforces minRole 'owner'; the nav link is hidden
 * for everyone else AND this page 404s them). Today it carries one field, and that field is the
 * reason the screen exists.
 *
 * THE TRIAL LENGTH. It used to be two hard-coded constants and seven lines of marketing copy, so
 * changing it meant a code change, a review and a deploy — which is why it sat at 60 for a year
 * while the only place that printed a different number was never noticed. It is one integer now.
 *
 * WHAT THIS SCREEN HAS TO SHOW, beyond the field itself: whether THE PUBLIC SITE AGREES. The
 * homepage and pricing page are statically generated and refreshed on demand when this saves. A
 * save that succeeds while that refresh fails leaves this screen reading 30 and greasedesk.com
 * promising 60 — so the refresh result is printed here, in the operator's own words, rather than
 * being a detail in a log nobody opens.
 */
import { useCallback, useEffect, useState } from 'react';
import Head from 'next/head';
import type { GetServerSideProps } from 'next';
import { requireOperatorPage, erMinRole, type OperatorRoleName } from '@/lib/operator-auth';
import EngineRoomLayout from '@/components/layout/EngineRoomLayout';

type CopyCheck = { url: string; shows: number | null; agrees: boolean };
type State = {
  trialDays: number;
  publicPaths: string[];
  revalidationTargets: string[];
  copyRevalidatedAt: string | null;
  copyRevalidateError: string | null;
  lastChange: { at: string; by: string; what: string | null } | null;
};
const input = 'bg-surface-muted border border-line rounded-lg px-3 py-2 text-sm text-ink focus:ring-2 focus:ring-accent focus:outline-none';
const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

export default function ProgrammeBilling({ role }: { role: OperatorRoleName }) {
  const [s, setS] = useState<State | null>(null);
  const [days, setDays] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // THREE STATES, not two: null = we have not looked at the public site yet, which is a different
  // thing from having looked and found it stale.
  const [pub, setPub] = useState<{ copy: CopyCheck[]; agrees: boolean } | null>(null);

  const refresh = useCallback(async () => {
    const r = await fetch('/api/superadmin/programme-settings');
    if (r.ok) { const d: State = await r.json(); setS(d); setDays(String(d.trialDays)); }
  }, []);
  const checkPublic = useCallback(async () => {
    setPub(null);
    const r = await fetch('/api/superadmin/programme-settings?check=1');
    if (r.ok) { const d = await r.json(); setPub({ copy: d.publicCopy, agrees: d.publicAgrees }); }
  }, []);
  useEffect(() => { refresh().then(checkPublic); }, [refresh, checkPublic]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/superadmin/programme-settings', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trialDays: Number(days) }),
      });
      const d = await r.json().catch(() => ({}));
      setMsg({ ok: r.ok && d.verified === true, text: d.message || (r.ok ? 'Saved.' : 'Failed.') });
      if (r.ok) { await refresh(); await checkPublic(); }
    } finally {
      // Clear busy in the finally: a thrown fetch must not leave the button dead.
      setBusy(false);
    }
  }

  const dirty = s != null && String(s.trialDays) !== days.trim();

  return (
    <EngineRoomLayout role={role}>
      <Head><title>Engine Room — billing</title><meta name="robots" content="noindex" /></Head>
      <div className="p-6 max-w-2xl space-y-5">
        <h1 className="text-xl font-semibold">Programme billing</h1>
        {msg && <div data-testid="save-result" className={`text-sm rounded-lg px-3 py-2 ${msg.ok ? 'bg-ok-soft text-ok' : 'bg-danger-soft text-danger'}`}>{msg.text}</div>}

        <div className="rounded-xl border border-line bg-surface p-5">
          <h2 className="text-sm font-semibold mb-1">Free trial length</h2>
          <p className="text-xs text-muted mb-4">
            How many days a garage signing up <span className="text-ink">from now on</span> gets before
            their card is charged. This is what Stripe is told at checkout, and it is the number printed
            on the homepage, the pricing page, the checkout step, <code>/llms.txt</code> and the
            verification email — all of them read this field. The homepage and pricing page are
            cached copies, so saving asks them to refresh and then <em>reads them back</em>; the
            line below is what they are actually showing, not what the refresh claimed.
            {' '}<span className="text-ink">Garages already on a trial keep the date they were given.</span>
          </p>
          <form onSubmit={save} className="flex flex-wrap items-end gap-3">
            <div>
              <label className="block text-xs text-muted mb-1">Days</label>
              <input type="number" min={1} max={365} step={1} required value={days}
                onChange={(e) => setDays(e.target.value)} className={`${input} w-28`} />
            </div>
            <button disabled={busy || !dirty} className="bg-surface text-ink border border-line rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50">
              {busy ? 'Saving…' : 'Save'}
            </button>
            {dirty && !busy && <span className="text-xs text-warn self-center">Unsaved.</span>}
          </form>

          {s && (
            <div className="mt-5 border-t border-line pt-4 space-y-2 text-xs">
              {/* ── DOES THE PUBLIC SITE AGREE? ─────────────────────────────────────────────
                  Three states, never collapsed to two: never refreshed, refreshed at a time, or
                  refreshed and FAILED. The third is the dangerous one and it says so. */}
              {/* ── WHAT THE PUBLIC SITE IS SHOWING RIGHT NOW ────────────────────────────────
                  Read back on every load, not reported from the last save. This line used to say
                  "last refreshed <time>" on the strength of res.revalidate() not throwing, and it
                  said it for an hour while greasedesk.com served the old number. A claim about
                  another system has to be a reading of that system. */}
              {pub === null ? (
                <p className="text-muted" data-testid="public-copy-checking">Reading the public site…</p>
              ) : pub.agrees ? (
                <p className="text-ok" data-testid="public-copy-agrees">
                  The public site agrees: {pub.copy.map((c) => c.url.replace(/^https?:\/\//, '')).join(' and ')}{' '}
                  {pub.copy.length === 1 ? 'shows' : 'both show'} {s.trialDays} days.
                </p>
              ) : (
                <p className="text-danger" data-testid="public-copy-disagrees">
                  <span className="font-semibold">The public site does not agree yet.</span>{' '}
                  {pub.copy.map((c) => `${c.url.replace(/^https?:\/\//, '')} shows ${c.shows ?? 'no number'}`).join('; ')}.
                  {' '}These pages refresh themselves within a minute.{' '}
                  <button type="button" onClick={checkPublic} className="underline">Check again</button>
                </p>
              )}
              {s.copyRevalidateError && <p className="text-muted">Last save reported: {s.copyRevalidateError}</p>}
              {s.copyRevalidatedAt
                ? <p className="text-muted">Last confirmed in agreement {when(s.copyRevalidatedAt)}.</p>
                : <p className="text-muted">Never yet confirmed in agreement from this screen.</p>}
              {s.lastChange
                ? <p className="text-muted">Last changed {when(s.lastChange.at)} by {s.lastChange.by}{s.lastChange.what ? ` (${s.lastChange.what})` : ''}.</p>
                : <p className="text-muted">Never changed from this screen.</p>}
            </div>
          )}
        </div>
      </div>
    </EngineRoomLayout>
  );
}

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const gate = await requireOperatorPage(ctx, { minRole: erMinRole('/superadmin/billing') }); // owner
  if (!gate.ok) return { notFound: true };
  return { props: { role: gate.op.role } };
};
