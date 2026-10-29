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
type PlanKindMap = Record<string, 'months' | 'pennies' | 'switch'>;
type State = {
  trialDays: number;
  planSettings: Record<string, number>;
  planLabels: Record<string, string>;
  planKinds: PlanKindMap;
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
  const [plan, setPlan] = useState<Record<string, string>>({});
  const [planBusy, setPlanBusy] = useState(false);

  const refresh = useCallback(async () => {
    const r = await fetch('/api/superadmin/programme-settings');
    if (r.ok) {
      const d: State = await r.json();
      setS(d); setDays(String(d.trialDays));
      setPlan(Object.fromEntries(Object.entries(d.planSettings).map(([k, v]) => [k, String(v)])));
    }
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
  const planDirty = s != null && Object.entries(plan).some(([k, v]) => String(s.planSettings[k]) !== v.trim());

  async function savePlan(e: React.FormEvent) {
    e.preventDefault();
    setPlanBusy(true); setMsg(null);
    try {
      const body: Record<string, number | boolean> = {};
      for (const [k, v] of Object.entries(plan)) {
        if (!s || String(s.planSettings[k]) === v.trim()) continue;
        body[k] = s.planKinds[k] === 'switch' ? (v === 'true') : Number(v);
      }
      const r = await fetch('/api/superadmin/programme-settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      setMsg({ ok: r.ok, text: d.message || (r.ok ? 'Saved.' : 'Failed.') });
      if (r.ok) await refresh();
    } finally {
      // Clear busy in the finally: a thrown fetch must not leave the button dead.
      setPlanBusy(false);
    }
  }


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
              {/* NAMED, because it is no longer the only number on this screen. The plan settings
                  below added six more, and a gate locating this one by input[type="number"]
                  matched seven elements. A selector that was unique stopped being unique when the
                  page grew — the field did not change, its surroundings did. */}
              <input data-testid="trial-days" type="number" min={1} max={365} step={1} required value={days}
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

        {/* ── PLAN AND REWARD SETTINGS ──────────────────────────────────────────────────────── */}
        {s && (
          <div className="rounded-xl border border-line bg-surface p-5">
            <h2 className="text-sm font-semibold mb-1">Plan and reward settings</h2>
            <p className="text-xs text-muted mb-4">
              Months are charged out of {s.planSettings.months_given} given — an annual plan at{' '}
              {s.planSettings.renewal_annual_months_paid} months charged is{' '}
              {s.planSettings.months_given} for the price of {s.planSettings.renewal_annual_months_paid}.
              Reward amounts are in <span className="text-ink">pennies</span>.
              {/* ── THE SENTENCE THAT STOPS SOMEBODY REPRICING A LIVE GARAGE ──────────────────
                  CORRECTED 2026-10-29, because it was HALF TRUE and read as wholly true. The
                  reward was frozen at signup; the garage's own first-year offer was not, so moving
                  offer_months_paid re-priced the first year of every referred garage that had not
                  yet paid. It was caught in the act mid-rehearsal: a garage referred at 6 months
                  saw its first year go from £450 to £600 eleven minutes later. Both are frozen
                  now (TenantAffiliateTerms.offer_months_paid / months_given), so the sentence
                  names what freezes and what does not instead of implying everything does. */}
              {' '}<span className="text-ink font-semibold">
                A change here applies to garages signing up from now on only. Two things freeze at
                signup for a referred garage: what the affiliate earns, and that garage's
                first-year offer.
              </span>{' '}
              The <span className="text-ink">renewal</span> price is not frozen before a garage
              subscribes — it is the list price, read at checkout. Once a garage does subscribe it
              keeps the amount its subscription was created at, including at renewal. Garages
              already referred keep what was frozen when they signed up; nothing on this screen can
              alter it.
            </p>
            {/* ── THESE NUMBERS ARE PUBLIC NOW (2026-10-29) ─────────────────────────────────────
                They were internal until today: /pricing quoted one monthly figure from a code
                constant and said nothing about yearly. It now shows the yearly price, the monthly
                equivalent and the saving, all derived from THIS row, and so does the home page's
                price line and /llms.txt. An operator typing a number here is changing the
                shop window, not only what checkout charges, and must be told so BEFORE typing. */}
            <p className="text-xs text-muted mb-4" data-testid="plan-settings-public-note">
              <span className="text-ink font-semibold">These figures are on the public site.</span>{' '}
              The yearly price, the monthly equivalent and the saving on{' '}
              <span className="text-ink">/pricing</span> and the home page all come from this row,
              as does <span className="text-ink">/llms.txt</span>. Saving here refreshes the two
              cached pages and then reads them back — the message will say whether the public site
              actually moved, not just that a refresh was attempted. /llms.txt is server-rendered
              and needs no refresh.
            </p>
            <form onSubmit={savePlan} className="space-y-3">
              {Object.keys(s.planSettings).map((f) => (
                <div key={f} className="flex flex-wrap items-center gap-3">
                  <label className="text-xs text-muted flex-1 min-w-[16rem]" htmlFor={`ps-${f}`}>
                    {s.planLabels[f]}
                    {s.planKinds[f] === 'pennies' && plan[f] && Number.isFinite(Number(plan[f]))
                      && <span className="ml-2 text-ink">= £{(Number(plan[f]) / 100).toFixed(2)}</span>}
                    {/* THE FIELD THAT CURRENTLY CHANGES NOTHING. planFor('annual_new') really does
                        read it (lib/billing-plans:94), but every annual plan is priced the same
                        today, so an operator seeing a separate box would reasonably expect it to
                        mean something. It is kept for a future promotion; the note says so. */}
                    {f === 'new_annual_months_paid' && (
                      <span className="block text-[11px] text-muted mt-0.5">
                        Set it the same as renewal unless you’re running a promotion.
                      </span>
                    )}
                  </label>
                  {s.planKinds[f] === 'switch' ? (
                    <input
                      id={`ps-${f}`} data-testid={`ps-${f}`} type="checkbox"
                      checked={plan[f] === 'true'}
                      onChange={(e) => setPlan({ ...plan, [f]: e.target.checked ? 'true' : 'false' })}
                      className="h-4 w-4 accent-accent"
                    />
                  ) : (
                    <input
                      id={`ps-${f}`} data-testid={`ps-${f}`} type="number" step={1}
                      min={s.planKinds[f] === 'months' ? 1 : 0}
                      max={s.planKinds[f] === 'months' ? 12 : undefined}
                      value={plan[f] ?? ''} onChange={(e) => setPlan({ ...plan, [f]: e.target.value })}
                      className={`${input} w-32`}
                    />
                  )}
                </div>
              ))}
              <div className="flex items-center gap-3 pt-1">
                <button disabled={planBusy || !planDirty} data-testid="save-plan-settings"
                  className="bg-surface text-ink border border-line rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50">
                  {planBusy ? 'Saving…' : 'Save plan settings'}
                </button>
                {planDirty && !planBusy && <span className="text-xs text-warn">Unsaved.</span>}
              </div>
            </form>
          </div>
        )}
      </div>
    </EngineRoomLayout>
  );
}

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const gate = await requireOperatorPage(ctx, { minRole: erMinRole('/superadmin/billing') }); // owner
  if (!gate.ok) return { notFound: true };
  return { props: { role: gate.op.role } };
};
