/**
 * File: pages/superadmin/prospects.tsx
 * THE TRAIL A REP LEFT — every garage visited, who was spoken to, when, and what was said.
 *
 * ── WHO THIS SCREEN IS FOR ──────────────────────────────────────────────────────────────────────
 * Whoever picks up the ground six months after a rep has gone. The record is GreaseDesk's asset, not
 * the rep's, and without a reader the argument for keeping it is void — so this screen is built in
 * the same slice as the logbook, not "later".
 *
 * ── OWNER ONLY, AND NO REGION SCOPING, DELIBERATELY ─────────────────────────────────────────────
 * Every other Engine Room list scopes by the operator's regions through operatorTenantScope, because
 * a tenant HAS a region. A prospect has no Group, so it has no region to take — and inventing a rule
 * now (by postcode? by the rep who recorded it?) would be inventing a wrong one before there is any
 * evidence of how the ground is actually split. Owner-only stands in for scoping until that is
 * decided. prospect-gate asserts this page never calls operatorTenantScope.
 *
 * ── THIS SCREEN WILL MOVE ───────────────────────────────────────────────────────────────────────
 * When rep management moves to reps.greasedesk.com, this list goes with it. It is a read-only list
 * over lib/prospect-store's data; moving it is cheap, and nothing else depends on where it lives.
 *
 * WHAT IS NOT SHOWN: a stripped record shows that the person was removed and why — never a blank that
 * could be mistaken for "nobody was spoken to". Honest null, applied to an erasure.
 */
import Head from 'next/head';
import React, { useState } from 'react';
import type { GetServerSideProps } from 'next';
import { prisma } from '@/lib/db';
import { requireOperatorPage, erMinRole, type OperatorRoleName } from '@/lib/operator-auth';
import { STATUS_LABEL, sequenceLabel, sequenceView, type ProspectStatus } from '@/lib/prospects';
import EngineRoomLayout from '@/components/layout/EngineRoomLayout';

type Visit = { on: string; repId: string; spokeTo: string | null; note: string | null; status: string };
type Row = {
  id: string; garageName: string; address: string | null; status: string;
  email: string | null; stripped: string | null; consent: string; consentAt: string | null;
  followUp: string; signedUpAt: string | null; visits: Visit[];
};

const STRIPPED_WORDS: Record<string, string> = {
  retention: 'removed after 24 months without a visit',
  unsubscribed: 'removed when they unsubscribed',
  signed_up: 'removed when they became a customer',
};

type Sending = { enabled: boolean; changedAt: string | null; changedBy: string | null; queued: number; running: number };

/**
 * THE SWITCH, WHERE IT MATTERS — at the top of the screen that shows what it holds back, not in an
 * env var nobody reads. Turning it ON is a deliberate two-step: it emails real people, and the
 * confirmation says how many. Turning it OFF is one tap, because stopping mail cannot hurt anybody.
 */
function SendingSwitch({ initial }: { initial: Sending }) {
  const [s, setS] = useState(initial);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const flip = async (enabled: boolean) => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch('/api/superadmin/prospect-sending', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) });
      if (!r.ok) { setErr('That did not save.'); return; }
      const j = await r.json();
      setS({ ...s, enabled: j.enabled, changedAt: j.changedAt ? String(j.changedAt).slice(0, 16).replace('T', ' ') : null, changedBy: j.changedBy });
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`mt-4 rounded-xl border p-4 ${s.enabled ? 'border-ok bg-ok-soft' : 'border-warn bg-warn-soft'}`} data-testid="er-sending">
      <div className="font-semibold text-ink" data-testid="er-sending-state">
        Follow-up sending is {s.enabled ? 'ON' : 'OFF'}
      </div>
      <p className="text-sm text-ink mt-1">
        {s.enabled
          ? `${s.running} running. New follow-ups start within the hour of a rep recording the address.`
          : `${s.queued} follow-up${s.queued === 1 ? ' is' : 's are'} queued. Nothing is emailed to anyone until this is switched on; each queued prospect then starts from the first email.`}
      </p>
      <p className="text-xs text-muted mt-1">
        {s.changedAt ? `Last changed ${s.changedAt} by ${String(s.changedBy).slice(0, 8)}.` : 'Never switched on — this is the default.'}
      </p>
      {err && <p className="text-sm text-bad mt-2">{err}</p>}
      <div className="mt-3 flex gap-2">
        {s.enabled ? (
          <button onClick={() => flip(false)} disabled={busy} className="rounded-lg px-4 py-2 text-sm bg-surface border border-line" data-testid="er-sending-off">
            Switch sending off
          </button>
        ) : confirming ? (
          <>
            <button onClick={() => flip(true)} disabled={busy} className="rounded-lg px-4 py-2 text-sm bg-accent text-white" data-testid="er-sending-confirm">
              Yes — email {s.queued} {s.queued === 1 ? 'person' : 'people'} from the next run
            </button>
            <button onClick={() => setConfirming(false)} className="rounded-lg px-4 py-2 text-sm bg-surface border border-line">Cancel</button>
          </>
        ) : (
          <button onClick={() => setConfirming(true)} className="rounded-lg px-4 py-2 text-sm bg-surface border border-line" data-testid="er-sending-on">
            Switch sending on…
          </button>
        )}
      </div>
    </div>
  );
}

export default function Prospects({ role, rows, sending }: { role: OperatorRoleName; rows: Row[]; sending: Sending }) {
  return (
    <EngineRoomLayout role={role}>
      <Head><title>Prospects — Engine Room</title></Head>
      <div className="p-6 max-w-5xl">
        <h1 className="text-lg font-semibold text-ink" data-testid="er-prospects">Prospects</h1>
        <p className="text-sm text-muted mt-1">Garages reps have visited that are not yet customers — the ground covered, kept after a rep moves on.</p>
        <SendingSwitch initial={sending} />
        {rows.length === 0 ? (
          <p className="text-sm text-muted mt-6" data-testid="er-prospects-none">No visits have been recorded yet.</p>
        ) : (
          <div className="mt-6 space-y-3">
            {rows.map((r) => (
              <details key={r.id} className="rounded-xl border border-line bg-surface p-4" data-testid="er-prospect">
                <summary className="cursor-pointer flex flex-wrap justify-between gap-2">
                  <span className="font-medium text-ink">{r.garageName}</span>
                  <span className="text-xs text-muted">{STATUS_LABEL[r.status as ProspectStatus] ?? r.status} · {r.visits.length} visit{r.visits.length === 1 ? '' : 's'} · last {r.visits[0]?.on ?? '—'}</span>
                </summary>
                <div className="mt-3 text-sm text-ink space-y-1">
                  {r.address && <div className="text-muted">{r.address}</div>}
                  <div>
                    <span className="text-muted">Email: </span>
                    {r.stripped ? <em className="text-muted">{STRIPPED_WORDS[r.stripped] ?? 'removed'}</em> : (r.email ?? <em className="text-muted">none given</em>)}
                  </div>
                  <div>
                    <span className="text-muted">Asked to be emailed: </span>
                    {r.consent === 'agreed' ? `agreed on ${r.consentAt}` : r.consent === 'declined' ? `declined on ${r.consentAt}` : 'not asked'}
                  </div>
                  <div><span className="text-muted">Follow-up: </span>{r.followUp}</div>
                  {r.signedUpAt && <div><span className="text-muted">Signed up: </span>{r.signedUpAt}</div>}
                </div>
                <ol className="mt-4 space-y-2 border-t border-line pt-3">
                  {r.visits.map((v, i) => (
                    <li key={i} className="text-sm">
                      <div className="text-xs text-muted">{v.on} · rep {v.repId.slice(0, 8)} · {STATUS_LABEL[v.status as ProspectStatus] ?? v.status}</div>
                      <div>{v.spokeTo ? `Spoke to ${v.spokeTo}` : <em className="text-muted">{r.stripped ? 'name removed' : 'no name recorded'}</em>}</div>
                      {v.note && <div className="text-ink mt-0.5">{v.note}</div>}
                    </li>
                  ))}
                </ol>
              </details>
            ))}
          </div>
        )}
      </div>
    </EngineRoomLayout>
  );
}

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const gate = await requireOperatorPage(ctx, { minRole: erMinRole('/superadmin/prospects') });
  if (!gate.ok) return { notFound: true };
  const ps = await prisma.prospect.findMany({
    orderBy: { updated_at: 'desc' },
    take: 500,
    include: {
      visits: { orderBy: { visited_on: 'desc' } },
      sequence: { select: { state: true, stopped_reason: true, last_sent_at: true } },
    },
  });
  const d = (x: Date | null) => (x ? x.toISOString().slice(0, 10) : null);
  const { prospectSendingState } = await import('@/lib/prospect-store');
  const state = await prospectSendingState();
  const rows: Row[] = ps.map((p) => ({
    id: p.id, garageName: p.garage_name,
    address: [p.address_line1, p.address_locality, p.postcode].filter(Boolean).join(', ') || null,
    status: p.status, email: p.email, stripped: p.personal_stripped_reason,
    consent: p.consent, consentAt: d(p.consent_at),
    // FROM THE ONE SHARED DERIVATION: queued reads as queued, never as running; stopped says why.
    followUp: p.sequence ? sequenceLabel(sequenceView(p.sequence, state.enabled)) : 'never started',
    signedUpAt: d(p.signed_up_at),
    visits: p.visits.map((v) => ({ on: d(v.visited_on)!, repId: v.rep_id, spokeTo: v.spoke_to, note: v.note, status: v.status_at_visit })),
  }));
  const active = ps.filter((p) => p.sequence?.state === 'active');
  const sending: Sending = {
    enabled: state.enabled,
    changedAt: state.changedAt ? state.changedAt.toISOString().slice(0, 16).replace('T', ' ') : null,
    changedBy: state.changedBy,
    // While OFF every active sequence is queued; while ON, only those that have not yet sent anything.
    queued: state.enabled ? active.filter((p) => !p.sequence!.last_sent_at).length : active.length,
    running: state.enabled ? active.filter((p) => p.sequence!.last_sent_at).length : 0,
  };
  return { props: { role: gate.op.role, rows, sending } };
};
