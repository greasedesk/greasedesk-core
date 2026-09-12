/**
 * File: components/pwa/ClockControl.tsx
 * CLOCK ON / CLOCK OFF, on the phone. One control, one tap, and it must work with a glove on.
 *
 * ── WHY IT IS THIS BIG ──────────────────────────────────────────────────────────────────────────
 * A tech will not use it otherwise and the whole input collapses — every downstream figure then
 * inherits the estimate it was supposed to replace. Full width, 64px tall (the rest of /m is 56px;
 * this is the one control someone reaches for with oily hands and without looking), and the label
 * says what will HAPPEN, not what the state is: "Clock on" / "Clock off", never "Clocked on".
 *
 * ── IT NAMES WHAT IT IS ABOUT TO CLOSE ──────────────────────────────────────────────────────────
 * Clocking onto a second car closes the first — the honest behaviour, because a tech cannot be on
 * two at once and forgetting to clock off is the normal failure. Silently moving someone would make
 * that a surprise on a payslip-shaped report later, so the button says whose time it is ending
 * BEFORE the tap, and confirms it after.
 *
 * ── TWO NUMBERS, BOTH LABELLED ──────────────────────────────────────────────────────────────────
 * Labour (the sum of everyone's sessions) and On the ramp (the elapsed span). Both are true and a
 * reader shown one assumes the other; the ambiguity is the defect, so neither appears alone.
 */
import { useState } from 'react';
import { enqueueClock } from '@/lib/pwa-outbox';

export type ClockState = {
  openHere: boolean;
  openElsewhereReg: string | null;
  openSince: string | null;
  labourMinutes: number;
  elapsedMinutes: number | null;
  running: number;
  disputed: number;
};

const hhmm = (mins: number) => `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;

export default function ClockControl({ jobCardId, clock, onChanged }: {
  jobCardId: string; clock: ClockState; onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function tap() {
    setBusy(true); setMsg(null);
    try {
      const res = await fetch('/api/pwa/clock', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        // deviceAt is sent ONLY by the outbox, when the tap happened with no signal. A live tap
        // sends nothing and the server stamps it — server time whenever there is a server.
        body: JSON.stringify({ action: clock.openHere ? 'off' : 'on', jobCardId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setMsg(data?.message || 'That did not go through. Try again.'); return; }
      if (data.supersededCount > 0) setMsg(`Clocked off ${data.supersededReg ?? 'the other job'} first.`);
      onChanged();
    } catch {
      // OFFLINE IS NOT AN ERROR — it is the forecourt. The tap is parked in the outbox with the
      // instant it happened, and the drain sends it when there is signal. Refusing here would kill
      // the feature exactly where it is most needed, which is why the device's clock is accepted at
      // all — labelled, never trusted silently (lib/job-clock::resolveInstant).
      await enqueueClock({ jobCardId, action: clock.openHere ? 'off' : 'on' });
      setMsg('No signal — saved, and it will send when you are back.');
    } finally { setBusy(false); }
  }

  const since = clock.openSince ? new Date(clock.openSince) : null;
  return (
    <section className="px-4 py-3 border-b border-line" aria-label="Time on this job">
      {clock.openElsewhereReg && !clock.openHere && (
        <p className="mb-2 text-sm text-warn" data-testid="clock-elsewhere">
          You are clocked on to <strong>{clock.openElsewhereReg}</strong>. Clocking on here will clock you off that.
        </p>
      )}
      <button
        type="button" onClick={tap} disabled={busy} data-testid="clock-button"
        className={`w-full min-h-[64px] rounded-xl text-lg font-semibold text-white transition-colors disabled:opacity-60 ${
          clock.openHere ? 'bg-danger hover:bg-danger' : 'bg-accent hover:bg-accent-hover'}`}
      >
        {busy ? 'Saving…' : clock.openHere ? 'Clock off' : 'Clock on'}
      </button>
      {clock.openHere && since && (
        // RUNNING IS NEVER ZERO. An open session says when it started; it does not render a duration
        // it would have to keep re-deriving, and it never reads as "0h 00m of work".
        <p className="mt-2 text-sm text-ink" data-testid="clock-running">
          Running since {since.getHours()}:{String(since.getMinutes()).padStart(2, '0')}.
        </p>
      )}
      {msg && <p className="mt-2 text-sm text-muted" data-testid="clock-message">{msg}</p>}
      <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-muted">Labour</dt>
          <dd className="text-ink font-medium" data-testid="clock-labour">{hhmm(clock.labourMinutes)}</dd>
        </div>
        <div>
          <dt className="text-muted">On the ramp</dt>
          <dd className="text-ink font-medium" data-testid="clock-elapsed">
            {clock.elapsedMinutes == null ? '—' : hhmm(clock.elapsedMinutes)}
          </dd>
        </div>
      </dl>
      {(clock.running > 0 || clock.disputed > 0) && (
        <p className="mt-2 text-xs text-muted" data-testid="clock-excluded">
          {clock.running > 0 && `${clock.running} still running`}
          {clock.running > 0 && clock.disputed > 0 && ' · '}
          {clock.disputed > 0 && `${clock.disputed} disputed (clock times disagree)`}
          {' — not counted above.'}
        </p>
      )}
    </section>
  );
}
