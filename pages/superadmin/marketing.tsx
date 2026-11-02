/**
 * File: pages/superadmin/marketing.tsx
 * THE ENGINE ROOM'S MARKETING SCREEN — four sequences, their copy, and the four switches that let
 * them send. OWNER only (nav minRole owner; this gssp enforces the same independently, and so does
 * the API: a nav entry is not an authorisation).
 *
 * ── THE ORDER OF THIS PAGE IS AN ARGUMENT ──────────────────────────────────────────────────────
 * Copy first, switch last, on every card. Somebody arriving here to "turn the emails on" should have
 * to scroll past the five emails they are about to send to real people, and the switch should be the
 * last thing they reach. The switch also asks for a confirmation, as the prospect one did.
 *
 * ── WHAT THE SWITCH PANEL HAS TO SAY, AND WHY ──────────────────────────────────────────────────
 * Three facts, because without any one of them "on" means something different:
 *   how many enrolments are waiting  — what turning it on actually sets in motion, not a vague yes;
 *   how many of the five are written — a sequence switched on with two emails written sends two and
 *                                     then holds, which is a perfectly reasonable thing to do on
 *                                     purpose and a nasty surprise by accident;
 *   which domain it leaves from      — adding the DNS records does nothing on its own, so a screen
 *                                     that said "on" without saying this would let somebody believe
 *                                     the subdomain was protecting the invoices when it was not.
 *
 * ── THE PREVIEW IS THE REAL RENDERER ──────────────────────────────────────────────────────────
 * It comes back from the server, rendered through the same template a send uses, rather than being
 * assembled here from the same fields. A preview written beside the thing it previews agrees with
 * itself and proves nothing; this one goes wrong in the ways a real send would.
 */
import React, { useState } from 'react';
import Head from 'next/head';
import type { GetServerSideProps } from 'next';
import EngineRoomLayout from '@/components/layout/EngineRoomLayout';
import { requireOperatorPage, erMinRole, type OperatorRoleName } from '@/lib/operator-auth';
import {
  SEQUENCE_AUDIENCE, SEQUENCE_KEYS, SEQUENCE_LABEL, STEPS, STOP_LABEL, GOAL_STOP, CONSENT_LABEL, CONSENT_OF,
  type SequenceKey,
} from '@/lib/marketing-engine';

type Step = {
  sequence: SequenceKey; step: number; subject: string; body: string;
  ctaLabel: string | null; ctaUrl: string | null;
  updatedAt: string | null; updatedBy: string | null; sendable: boolean; afterDays: number;
};
type Switch = { sequence: SequenceKey; enabled: boolean; changedAt: string | null; changedBy: string | null; queued: number; copyWritten: number };
type From = { address: string; onMarketingDomain: boolean };
type PageProps = { role: OperatorRoleName; switches: Switch[]; copy: Record<string, Step[]>; from: From };

const input = 'w-full p-2 rounded border text-sm';
const inputStyle = { background: 'var(--content-bg)', borderColor: 'var(--surface-muted)', color: 'var(--text)' } as React.CSSProperties;

function StepEditor({ s }: { s: Step }) {
  const [f, setF] = useState({ subject: s.subject, body: s.body, ctaLabel: s.ctaLabel ?? '', ctaUrl: s.ctaUrl ?? '' });
  const [msg, setMsg] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ subject: string; html: string } | null>(null);
  const [testTo, setTestTo] = useState('');
  const [busy, setBusy] = useState(false);

  async function post(action: string, extra: Record<string, unknown> = {}) {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/superadmin/marketing', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, sequence: s.sequence, step: s.step, ...extra }),
      });
      const d = await r.json().catch(() => ({}));
      return { ok: r.ok, d };
    } finally {
      // CLEARED IN `finally`, every time. A busy flag left set by a thrown fetch disables the only
      // button that could retry it, and this screen does not remount on its own.
      setBusy(false);
    }
  }

  async function save() {
    const { ok, d } = await post('save-copy', { subject: f.subject, body: f.body, ctaLabel: f.ctaLabel, ctaUrl: f.ctaUrl });
    setMsg(ok ? 'Saved. It goes out as written on the next run.' : d?.message || 'Failed.');
  }
  async function showPreview() {
    // SAVE FIRST, then preview what is stored. Previewing the unsaved textarea would show something
    // nobody can send, and the gap between the two is exactly where a typo survives a check.
    const saved = await post('save-copy', { subject: f.subject, body: f.body, ctaLabel: f.ctaLabel, ctaUrl: f.ctaUrl });
    if (!saved.ok) { setMsg(saved.d?.message || 'Failed.'); return; }
    const { ok, d } = await post('preview');
    if (ok) { setPreview({ subject: d.subject, html: d.html }); setMsg(null); } else setMsg(d?.message || 'Nothing to preview.');
  }
  async function sendTest() {
    const saved = await post('save-copy', { subject: f.subject, body: f.body, ctaLabel: f.ctaLabel, ctaUrl: f.ctaUrl });
    if (!saved.ok) { setMsg(saved.d?.message || 'Failed.'); return; }
    const { ok, d } = await post('send-test', { to: testTo });
    setMsg(ok ? `Test sent to ${testTo}.` : d?.message || 'Failed.');
  }

  return (
    <div className="rounded-xl border p-4 mb-3" style={{ borderColor: 'var(--surface-muted)', background: 'var(--surface)' }} data-testid={`copy-${s.sequence}-${s.step}`}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-semibold text-ink">
          Email {s.step} of {STEPS}
          <span className="ml-2 font-normal text-muted">
            {s.afterDays === 0 ? 'goes as soon as they are enrolled' : `${s.afterDays} days after the one before`}
          </span>
        </span>
        <span className={`text-xs px-2 py-0.5 rounded ${s.sendable ? 'bg-ok-soft text-ok' : 'bg-warn-soft text-warn'}`} data-testid={`copy-state-${s.sequence}-${s.step}`}>
          {s.sendable ? 'written' : 'not written — the sequence holds here'}
        </span>
      </div>

      <label className="block text-xs text-muted mb-1">Subject</label>
      <input className={input} style={inputStyle} value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} data-testid={`subject-${s.sequence}-${s.step}`} />

      <label className="block text-xs text-muted mt-3 mb-1">
        Body — plain text. A blank line starts a new paragraph. No HTML, no markdown.
      </label>
      <textarea className={input} style={{ ...inputStyle, minHeight: 160 }} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} data-testid={`body-${s.sequence}-${s.step}`} />

      <div className="grid grid-cols-2 gap-3 mt-3">
        <div>
          <label className="block text-xs text-muted mb-1">Button label — leave both blank for no button</label>
          <input className={input} style={inputStyle} value={f.ctaLabel} onChange={(e) => setF({ ...f, ctaLabel: e.target.value })} data-testid={`cta-label-${s.sequence}-${s.step}`} />
        </div>
        <div>
          <label className="block text-xs text-muted mb-1">Button link — a full https:// address</label>
          <input className={input} style={inputStyle} value={f.ctaUrl} onChange={(e) => setF({ ...f, ctaUrl: e.target.value })} data-testid={`cta-url-${s.sequence}-${s.step}`} />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 mt-3">
        <button onClick={save} disabled={busy} className="rounded-lg px-4 py-2 text-sm bg-accent text-white" data-testid={`save-${s.sequence}-${s.step}`}>Save</button>
        <button onClick={showPreview} disabled={busy} className="rounded-lg px-4 py-2 text-sm bg-surface border border-line" data-testid={`preview-${s.sequence}-${s.step}`}>Save and preview</button>
        <input className="p-2 rounded border text-sm" style={inputStyle} placeholder="your@address" value={testTo} onChange={(e) => setTestTo(e.target.value)} data-testid={`test-to-${s.sequence}-${s.step}`} />
        <button onClick={sendTest} disabled={busy || !testTo.trim()} className="rounded-lg px-4 py-2 text-sm bg-surface border border-line" data-testid={`send-test-${s.sequence}-${s.step}`}>Send me a test</button>
      </div>

      {msg && <p className="mt-2 text-sm text-muted" data-testid={`msg-${s.sequence}-${s.step}`}>{msg}</p>}
      {s.updatedAt && <p className="mt-1 text-xs text-muted">Last edited {s.updatedAt.slice(0, 16).replace('T', ' ')} by {String(s.updatedBy).slice(0, 8)}.</p>}

      {preview && (
        <div className="mt-3 rounded-lg border p-3" style={{ borderColor: 'var(--surface-muted)' }} data-testid={`preview-out-${s.sequence}-${s.step}`}>
          <p className="text-xs text-muted mb-2">Subject: <span className="text-ink">{preview.subject}</span></p>
          {/* The server rendered this through the real template; it is our own escaped output.
              ON --email-paper, NOT on --surface: this is a picture of what a stranger's mail client
              will show, and a mail client is not in our dark mode. Previewing on a themed surface
              would let an operator approve, in dark mode, copy that goes out white-on-white. */}
          <div style={{ background: 'var(--email-paper)', color: 'var(--email-ink)', padding: 8, borderRadius: 6 }}
               dangerouslySetInnerHTML={{ __html: preview.html }} />
        </div>
      )}
    </div>
  );
}

function SequenceCard({ sw, steps, from }: { sw: Switch; steps: Step[]; from: From }) {
  const [s, setS] = useState(sw);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function flip(enabled: boolean) {
    setBusy(true);
    try {
      const r = await fetch('/api/superadmin/marketing', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'switch', sequence: s.sequence, enabled }),
      });
      const d = await r.json().catch(() => ({}));
      const next = (d?.switches as Switch[] | undefined)?.find((x) => x.sequence === s.sequence);
      if (r.ok && next) setS(next);
      setConfirming(false);
    } finally { setBusy(false); }
  }

  return (
    <section className="mb-8" data-testid={`sequence-${s.sequence}`}>
      <h2 className="text-lg font-semibold text-ink">{SEQUENCE_LABEL[s.sequence]}</h2>
      <p className="text-sm text-muted mt-1">{SEQUENCE_AUDIENCE[s.sequence]}</p>
      <p className="text-xs text-muted mt-1">
        Consent: {CONSENT_LABEL[CONSENT_OF[s.sequence]]}. Stops when they {STOP_LABEL[GOAL_STOP[s.sequence]].replace(/^Stopped — (they )?/, '')}, and on unsubscribe.
      </p>

      <div className="mt-4">
        {steps.map((st) => <StepEditor key={st.step} s={st} />)}
      </div>

      <div className={`rounded-xl border p-4 ${s.enabled ? 'border-ok bg-ok-soft' : 'border-warn bg-warn-soft'}`} data-testid={`switch-${s.sequence}`}>
        <div className="font-semibold text-ink" data-testid={`switch-state-${s.sequence}`}>
          This sequence is {s.enabled ? 'ON' : 'OFF'}
        </div>
        <p className="mt-1 text-sm text-muted" data-testid={`switch-detail-${s.sequence}`}>
          {s.copyWritten} of {STEPS} emails written.
          {' '}
          {s.enabled
            ? `${s.queued} enrolment${s.queued === 1 ? '' : 's'} active.`
            : `${s.queued} enrolment${s.queued === 1 ? ' is' : 's are'} queued. Nothing is emailed to anyone until this is switched on; each one then starts from the first email.`}
        </p>
        <p className="mt-1 text-xs text-muted" data-testid={`switch-from-${s.sequence}`}>
          {from.onMarketingDomain
            ? `Sends from ${from.address}.`
            : `Sends from ${from.address} — the same address as invoices and receipts. MARKETING_EMAIL_FROM is not set, so the marketing subdomain is not in use yet (docs/marketing-subdomain-dns.md, step 4).`}
        </p>
        <p className="mt-1 text-xs text-muted">
          {s.changedAt ? `Last changed ${s.changedAt.slice(0, 16).replace('T', ' ')} by ${String(s.changedBy).slice(0, 8)}.` : 'Never switched on — this is the default.'}
        </p>
        <div className="mt-3 flex items-center gap-2">
          {s.enabled ? (
            <button onClick={() => flip(false)} disabled={busy} className="rounded-lg px-4 py-2 text-sm bg-surface border border-line" data-testid={`switch-off-${s.sequence}`}>
              Switch this sequence off
            </button>
          ) : confirming ? (
            <>
              <button onClick={() => flip(true)} disabled={busy} className="rounded-lg px-4 py-2 text-sm bg-accent text-white" data-testid={`switch-confirm-${s.sequence}`}>
                Yes — start emailing {s.queued} real {s.queued === 1 ? 'person' : 'people'}
              </button>
              <button onClick={() => setConfirming(false)} className="text-sm text-muted">Cancel</button>
            </>
          ) : (
            <button onClick={() => setConfirming(true)} className="rounded-lg px-4 py-2 text-sm bg-surface border border-line" data-testid={`switch-on-${s.sequence}`}>
              Switch this sequence on…
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

export default function Marketing({ role, switches, copy, from }: PageProps) {
  return (
    <EngineRoomLayout role={role}>
      <Head><title>Marketing — Engine Room</title></Head>
      <h1 className="text-xl font-semibold text-ink">Marketing sequences</h1>
      <p className="text-sm text-muted mt-1">
        Five emails each, a week apart. Every sequence stops on its own goal and on unsubscribe, and
        an unsubscribe stops all four. Each switch is off until you turn it on, and a step nobody has
        written holds the sequence rather than sending an empty email.
      </p>
      <div className="mt-6">
        {SEQUENCE_KEYS.map((k) => {
          const sw = switches.find((x) => x.sequence === k);
          return sw ? <SequenceCard key={k} sw={sw} steps={copy[k] ?? []} from={from} /> : null;
        })}
      </div>
    </EngineRoomLayout>
  );
}

export const getServerSideProps: GetServerSideProps<PageProps> = async (ctx) => {
  const gate = await requireOperatorPage(ctx, { minRole: erMinRole('/superadmin/marketing') });
  if (!gate.ok) return { notFound: true };
  const { allSwitchStates, copyFor } = await import('@/lib/marketing-store');
  const { marketingFromAddress, marketingFromConfigured } = await import('@/lib/email-service');
  const raw = await allSwitchStates();
  const switches: Switch[] = raw.map((s) => ({
    sequence: s.sequence, enabled: s.enabled, queued: s.queued, copyWritten: s.copyWritten,
    changedAt: s.changedAt ? s.changedAt.toISOString() : null, changedBy: s.changedBy,
  }));
  const copy: Record<string, Step[]> = {};
  for (const k of SEQUENCE_KEYS) {
    copy[k] = (await copyFor(k)).map((c) => ({ ...c, updatedAt: c.updatedAt ? c.updatedAt.toISOString() : null }));
  }
  return { props: { role: gate.op.role, switches, copy, from: { address: marketingFromAddress(), onMarketingDomain: marketingFromConfigured() } } };
};
