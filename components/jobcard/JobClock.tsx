/**
 * File: components/jobcard/JobClock.tsx
 * TIME ON THIS JOB, on the desktop — where a manager reads it.
 *
 * The phone shows the same two numbers to the tech standing at the car; this answers a different
 * question, for a different person, which is why both exist. It also carries the CORRECTION, because
 * an endpoint a manager can only reach with an API call is an endpoint nobody uses — and then the
 * "still running" list only ever grows and nothing clears it.
 *
 * ── BOTH NUMBERS, ALWAYS, LABELLED ──────────────────────────────────────────────────────────────
 * LABOUR is the sum of everyone's sessions. ON THE RAMP is the elapsed span from first start to last
 * end. Two techs on a car for an hour is two hours of labour and one hour on the ramp; a reader
 * shown one number assumes the other, and the ambiguity is the defect.
 *
 * ── AND WHAT IS NOT COUNTED SAYS SO ─────────────────────────────────────────────────────────────
 * A running session and a disputed one both contribute nothing to the totals. Silently excluding
 * them would make a job look cheap; the line under the numbers names how many and why.
 */
import { useState } from 'react';

export type ClockSession = {
  id: string; who: string; startedAt: string; endedAt: string | null;
  state: 'running' | 'closed' | 'disputed'; minutes: number | null;
  cause: string | null; correctsId: string | null; correctionReason: string | null; correctedBy: string | null;
};
export type JobClockProps = {
  clock: { labourMinutes: number; elapsedMinutes: number | null; running: number; disputed: number; sessions: ClockSession[] };
  jobCardId: string; isAdmin: boolean; onChanged: () => void;
};

const hhmm = (m: number) => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
const clock = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const forInput = (iso: string) => { const d = new Date(iso); const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };

const STATE_TONE: Record<string, string> = {
  running: 'bg-warn-soft text-warn border-warn',
  disputed: 'bg-danger-soft text-danger border-danger',
  closed: 'bg-surface-muted text-muted border-line',
};

export default function JobClock({ clock: c, jobCardId, isAdmin, onChanged }: JobClockProps) {
  const [editing, setEditing] = useState<ClockSession | null>(null);
  const [form, setForm] = useState({ startedAt: '', endedAt: '', reason: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function open(s: ClockSession) {
    setErr(null);
    setForm({ startedAt: forInput(s.startedAt), endedAt: s.endedAt ? forInput(s.endedAt) : '', reason: '' });
    setEditing(s);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!editing) return;
    setBusy(true); setErr(null);
    try {
      const res = await fetch('/api/jobcard-clock', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          correctsId: editing.id,
          startedAt: new Date(form.startedAt).toISOString(),
          endedAt: form.endedAt ? new Date(form.endedAt).toISOString() : null,
          reason: form.reason,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(data?.message || 'That correction was not accepted.'); return; }
      setEditing(null); onChanged();
    } catch { setErr('We could not reach the server.'); } finally { setBusy(false); }
  }

  return (
    <section className="bg-surface border border-line rounded-xl p-4" data-testid="job-clock">
      <h3 className="text-sm font-semibold text-ink">Time on this job</h3>
      <dl className="mt-3 flex gap-8">
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted">Labour</dt>
          <dd className="text-xl font-semibold text-ink" data-testid="job-clock-labour">{hhmm(c.labourMinutes)}</dd>
          <p className="text-xs text-muted">summed across everyone</p>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted">On the ramp</dt>
          <dd className="text-xl font-semibold text-ink" data-testid="job-clock-elapsed">
            {c.elapsedMinutes == null ? '—' : hhmm(c.elapsedMinutes)}
          </dd>
          <p className="text-xs text-muted">first start to last finish</p>
        </div>
      </dl>
      {(c.running > 0 || c.disputed > 0) && (
        <p className="mt-2 text-xs text-muted" data-testid="job-clock-excluded">
          Not counted above: {c.running > 0 && `${c.running} still running`}
          {c.running > 0 && c.disputed > 0 && ', '}
          {c.disputed > 0 && `${c.disputed} disputed (the device and server clocks disagree)`}.
        </p>
      )}

      {c.sessions.length === 0 ? (
        <p className="mt-4 text-sm text-muted">Nobody has clocked on to this job.</p>
      ) : (
        <ul className="mt-4 divide-y divide-line" data-testid="job-clock-sessions">
          {c.sessions.map((s) => (
            <li key={s.id} className="py-2 flex items-start gap-3 text-sm">
              <span className={`shrink-0 text-[11px] rounded-full border px-2 py-0.5 ${STATE_TONE[s.state]}`}>{s.state}</span>
              <span className="flex-1">
                <span className="text-ink font-medium">{s.who}</span>{' '}
                <span className="text-muted">
                  {clock(s.startedAt)} → {s.endedAt ? clock(s.endedAt) : 'still running'}
                  {s.minutes != null && ` · ${hhmm(s.minutes)}`}
                  {s.cause === 'superseded' && ' · closed by clocking onto another job'}
                </span>
                {/* THE ORIGINAL STAYS VISIBLE. A correction is a row that points at one, so both are
                    listed and the correction says whose judgement it was. */}
                {s.correctsId && (
                  <span className="block text-xs text-muted" data-testid="job-clock-correction">
                    Correction by {s.correctedBy ?? 'someone'} — “{s.correctionReason}”
                  </span>
                )}
              </span>
              {isAdmin && !s.correctsId && (
                <button type="button" onClick={() => open(s)} data-testid="job-clock-correct"
                  className="shrink-0 text-xs text-accent hover:underline">Correct</button>
              )}
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <form onSubmit={submit} className="mt-4 border-t border-line pt-4 space-y-3" data-testid="job-clock-form">
          <p className="text-sm text-ink">Correcting {editing.who}’s session. The original stays on the record.</p>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm text-muted">Started
              <input type="datetime-local" required value={form.startedAt} onChange={(e) => setForm((f) => ({ ...f, startedAt: e.target.value }))}
                className="mt-1 w-full p-2 bg-surface border border-line rounded-lg text-ink text-sm" />
            </label>
            <label className="text-sm text-muted">Finished
              <input type="datetime-local" value={form.endedAt} onChange={(e) => setForm((f) => ({ ...f, endedAt: e.target.value }))}
                className="mt-1 w-full p-2 bg-surface border border-line rounded-lg text-ink text-sm" />
            </label>
          </div>
          <label className="block text-sm text-muted">Why
            {/* MANDATORY, and the server refuses a blank one too — this is the prompt, not the rule. */}
            <input required value={form.reason} maxLength={500} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
              placeholder="e.g. Forgot to clock off; agreed 90 minutes with Dave."
              data-testid="job-clock-reason"
              className="mt-1 w-full p-2 bg-surface border border-line rounded-lg text-ink text-sm" />
          </label>
          {err && <p className="text-sm text-danger" data-testid="job-clock-error">{err}</p>}
          <div className="flex gap-2">
            <button type="submit" disabled={busy} className="bg-accent hover:bg-accent-hover text-white text-sm font-medium rounded-lg px-4 py-2 disabled:opacity-60">
              {busy ? 'Saving…' : 'Record correction'}
            </button>
            <button type="button" onClick={() => setEditing(null)} className="text-sm text-muted hover:text-ink px-2">Cancel</button>
          </div>
        </form>
      )}
    </section>
  );
}
