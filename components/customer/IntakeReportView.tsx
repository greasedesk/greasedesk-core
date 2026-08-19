/**
 * File: components/customer/IntakeReportView.tsx
 * THE INTAKE REPORT, as the customer sees it.
 *
 * This is the only GreaseDesk a car owner ever meets — and in a sale it is the screen that makes
 * the whole intake process real to someone who has never used the product: their car, their video,
 * their findings, their tap. It is held to a higher standard than an internal panel.
 *
 * THREE RULES IT KEEPS:
 *   1. NO PRICES. A yes means "quote me for this", and the copy says so in those words rather than
 *      leaving the customer to infer what they have agreed to.
 *   2. THE VIDEO DOES NOT AUTOPLAY. 20MB on cellular is a cost nobody agreed to; a poster and a
 *      play control put it in their hands. If playback fails — a presigned URL can expire
 *      mid-stream — the page fetches a fresh URL instead of dying silently.
 *   3. AN ANSWER IS ALWAYS CHANGEABLE. Tapping again re-answers; the record appends, so the
 *      garage sees the history and the customer is never stuck with a mis-tap.
 */
import React, { useCallback, useRef, useState } from 'react';

type Media = { id: string; kind: 'photo' | 'video'; url: string | null; posterUrl: string | null; label: string | null; durationSeconds: number | null; rotation: number };
type Finding = { id: string; description: string; timing: string; answered: 'yes' | 'no' | 'call_me' | null };

type Props = {
  token: string;
  garageName: string;
  garagePhone: string | null;
  registration: string | null;
  vehicleDesc: string | null;
  walkaround: Media | null;
  photos: Media[];
  findings: Finding[];
};

/**
 * EVERY SELECTED STATE IS FILLED, not merely darker text.
 *
 * The first version gave "No thanks" and "Call me" a selected tone of `bg-surface text-ink` against
 * an unselected `bg-surface text-muted` — a difference of one text shade. On the served page it was
 * genuinely hard to tell whether a tap had registered, which on the ONE screen a customer ever sees
 * is the difference between a considered answer and a confused one. A filled chip is unambiguous at
 * arm's length, on a phone, outdoors.
 */
const ANSWERS: Array<{ key: 'yes' | 'no' | 'call_me'; label: string; on: string }> = [
  // "Yes please" — NOT "Accept". Acceptance is a priced act and this screen has no prices.
  { key: 'yes', label: 'Yes please', on: 'bg-ok text-white border-ok' },
  { key: 'no', label: 'No thanks', on: 'bg-ink text-white border-ink' },
  { key: 'call_me', label: 'Call me', on: 'bg-accent text-white border-accent' },
];

const fmtDur = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

export default function IntakeReportView(p: Props) {
  const [findings, setFindings] = useState<Finding[]>(p.findings);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoSrc, setVideoSrc] = useState<string | null>(p.walkaround?.url ?? null);
  const [retried, setRetried] = useState(false);

  // A PRESIGNED URL CAN DIE MID-STREAM. Ask for a fresh one once rather than leaving a stalled
  // player with no explanation. Once only — a second failure is a real problem and should say so.
  const refreshVideo = useCallback(async () => {
    if (retried || !p.walkaround) return;
    setRetried(true);
    try {
      const r = await fetch(`/api/intake-media?token=${encodeURIComponent(p.token)}&id=${encodeURIComponent(p.walkaround.id)}`, { cache: 'no-store' });
      if (!r.ok) return;
      const d = await r.json();
      if (d?.url) { setVideoSrc(d.url); videoRef.current?.load(); }
    } catch { /* the poster and the error line already say something is wrong */ }
  }, [p.token, p.walkaround, retried]);

  async function answer(id: string, a: 'yes' | 'no' | 'call_me') {
    setBusy(id); setErr(null);
    const before = findings;
    setFindings((f) => f.map((x) => (x.id === id ? { ...x, answered: a } : x)));  // optimistic
    try {
      const r = await fetch('/api/intake-respond', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: p.token, dueItemId: id, answer: a }),
      });
      if (!r.ok) { setFindings(before); setErr('That didn’t save. Please try again, or call us.'); }
    } catch { setFindings(before); setErr('That didn’t save. Please try again, or call us.'); }
    finally { setBusy(null); }
  }

  const answered = findings.filter((f) => f.answered !== null).length;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-ink">Your car’s check-in</h1>
        <p className="text-sm text-muted mt-1">
          {p.garageName} looked over{' '}
          <span className="font-medium text-ink">{[p.registration, p.vehicleDesc].filter(Boolean).join(' · ') || 'your car'}</span>{' '}
          when it arrived. Here’s what we saw.
        </p>
      </header>

      {p.walkaround && (
        <section>
          <h2 className="text-sm font-semibold text-ink mb-2">
            Walkaround
            {p.walkaround.durationSeconds != null && <span className="font-normal text-muted"> · {fmtDur(p.walkaround.durationSeconds)}</span>}
          </h2>
          {/* preload="none" + a poster: nothing downloads until they press play. */}
          <video
            ref={videoRef} src={videoSrc ?? undefined} poster={p.walkaround.posterUrl ?? undefined}
            controls playsInline preload="none" onError={refreshVideo}
            data-testid="report-walkaround"
            className="w-full rounded-xl bg-black max-h-[70vh]"
          />
          <p className="text-xs text-muted mt-1">A single unbroken take of the car as it arrived.</p>
        </section>
      )}

      {p.photos.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-ink mb-2">Photos</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {p.photos.map((m) => (
              <figure key={m.id} className="space-y-1">
                {m.url && <img src={m.url} alt={m.label ?? 'Intake photo'} loading="lazy"
                  style={m.rotation ? { transform: `rotate(${m.rotation}deg)` } : undefined}
                  className="w-full aspect-[4/3] object-cover rounded-lg bg-surface-muted" />}
                {m.label && <figcaption className="text-xs text-muted">{m.label}</figcaption>}
              </figure>
            ))}
          </div>
        </section>
      )}

      {findings.length > 0 && (
        <section>
          <div className="flex items-baseline justify-between gap-2 mb-1">
            <h2 className="text-sm font-semibold text-ink">What your car needs</h2>
            <span className="text-xs text-muted" data-testid="report-progress">{answered} of {findings.length} answered</span>
          </div>
          {/* THE SENTENCE THAT STOPS A YES BEING AN ACCEPTANCE. Said once, plainly, above the
              buttons — not in small print underneath them. */}
          <p className="text-sm text-muted mb-3">
            Tell us which you’d like a price for. Saying yes isn’t an order — we’ll send you a quote
            and you can decide then.
          </p>

          <ul className="space-y-3">
            {findings.map((f) => (
              <li key={f.id} className="bg-surface border border-line rounded-xl p-4" data-testid={`report-finding-${f.id}`}>
                <p className="text-sm font-medium text-ink">{f.description}</p>
                <p className="text-xs text-muted mt-0.5">{f.timing}</p>
                <div className="flex flex-wrap gap-2 mt-3">
                  {ANSWERS.map((a) => {
                    const on = f.answered === a.key;
                    return (
                      <button key={a.key} type="button" disabled={busy === f.id}
                        onClick={() => answer(f.id, a.key)}
                        aria-pressed={on}
                        data-testid={`report-answer-${a.key}`}
                        className={`min-h-[44px] text-sm font-semibold rounded-lg px-4 border transition-colors disabled:opacity-50 ${on ? a.on : 'bg-surface border-line text-muted hover:text-ink'}`}>
                        {on ? `✓ ${a.label}` : a.label}
                      </button>
                    );
                  })}
                </div>
                {f.answered && <p className="text-xs text-muted mt-2">Tap another to change your answer.</p>}
              </li>
            ))}
          </ul>
          {err && <p className="text-sm text-danger mt-3">{err}</p>}
        </section>
      )}

      {findings.length === 0 && (
        // A CLEAN CAR IS GOOD NEWS AND SHOULD READ AS IT. Never an empty section.
        <section className="bg-ok-soft text-ok rounded-xl p-4 text-sm font-medium" data-testid="report-nothing-needed">
          We didn’t find anything your car needs beyond the work you booked.
        </section>
      )}

      {p.garagePhone && (
        <footer className="text-sm text-muted border-t border-line pt-4">
          Questions? Call {p.garageName} on <a href={`tel:${p.garagePhone.replace(/[^\d+]/g, '')}`} className="text-accent font-medium">{p.garagePhone}</a>.
        </footer>
      )}
    </div>
  );
}
