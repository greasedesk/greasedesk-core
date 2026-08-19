/**
 * File: components/pwa/PhoneBattery.tsx
 * THE BATTERY TEST, ON THE PHONE — the surface the mechanic is actually holding.
 *
 * ── WHY THIS IS NOT THE DESKTOP COMPONENT ───────────────────────────────────────────────────────
 * The desktop form posts. Here the save is a durable ENQUEUE, because a bay has no signal and a
 * measurement must never be lost to a dead bar. Replay-safe with no id: BatteryReading is unique on
 * job_card_id, so a redelivered envelope upserts. (A finding needs a client-supplied id for exactly
 * the opposite reason — no natural key. The asymmetry is deliberate; see lib/pwa-outbox.)
 *
 * ── THREE NUMBERS TYPED, NOT TAPPED, AND WHY THAT IS THE FAST ANSWER ────────────────────────────
 * The tyre chips exist because tread values cluster and a tenth either way changes nothing. None of
 * that holds here: a voltage cannot be chipped, and the two percentages come off the tester exact.
 * Chips would round away the precision that makes the reading evidence. Ten keystrokes on a numeric
 * pad beats any tapping design, so the work went into the keypad, the bounds and the ordering
 * instead — the fields are in the order the tester displays them, so it is transcription rather
 * than a lookup.
 *
 * The rating is the CAR's, prefilled from its last test, so on any second visit it is zero input.
 */
import React, { useState } from 'react';
import { enqueueBattery } from '@/lib/pwa-outbox';

const STANDARDS = ['EN', 'SAE', 'DIN', 'JIS', 'IEC'] as const;
const num = (s: string) => (s.trim() === '' ? null : Number(s));

export default function PhoneBattery({ jobCardId, lastRatedCca, lastCcaStandard, onQueued }: {
  jobCardId: string;
  lastRatedCca?: number | null;
  lastCcaStandard?: string | null;
  onQueued?: () => void;
}) {
  const [voltage, setVoltage] = useState('');
  const [soc, setSoc] = useState('');
  const [soh, setSoh] = useState('');
  const [ratedCca, setRatedCca] = useState(lastRatedCca != null ? String(lastRatedCca) : '');
  const [std, setStd] = useState<string>(lastCcaStandard ?? '');
  const [queued, setQueued] = useState(false);

  const v = num(voltage), sc = num(soc), sh = num(soh);
  const ok = (n: number | null, lo: number, hi: number) => n != null && Number.isFinite(n) && n >= lo && n <= hi;
  // All three or nothing — a test missing one number would silently change which state it lands in.
  // And the rating is both-or-neither: a rating without its standard is not comparable to another.
  const ready = ok(v, 0.1, 30) && ok(sc, 0, 100) && ok(sh, 0, 100)
    && ((ratedCca.trim() === '' && std === '') || (num(ratedCca) != null && std !== ''));

  async function save() {
    await enqueueBattery({
      jobCardId, voltage: v as number, socPct: Math.round(sc as number), sohPct: Math.round(sh as number),
      ratedCca: ratedCca.trim() === '' ? null : Math.round(num(ratedCca) as number),
      ccaStandard: std === '' ? null : std,
    });
    setQueued(true);
    onQueued?.();
  }

  // 44px minimum: a gloved thumb on a phone, not a mouse.
  const field = 'w-full min-h-[48px] px-3 bg-surface border border-line rounded-lg text-ink text-base tabular-nums';

  return (
    <section className="bg-surface border border-line rounded-xl p-4" data-testid="phone-battery">
      <h2 className="text-sm font-semibold text-ink mb-1">Battery test</h2>
      <p className="text-xs text-muted mb-3">Straight off the tester, in the order it shows them.</p>

      <div className="grid grid-cols-3 gap-2">
        <label className="block">
          <span className="text-xs text-muted">Volts</span>
          <input inputMode="decimal" value={voltage} onChange={(e) => setVoltage(e.target.value.replace(/[^\d.]/g, ''))}
            placeholder="12.45" data-testid="phone-battery-voltage" className={field} />
        </label>
        <label className="block">
          <span className="text-xs text-muted">Charge %</span>
          <input inputMode="numeric" value={soc} onChange={(e) => setSoc(e.target.value.replace(/[^\d]/g, '').slice(0, 3))}
            placeholder="86" data-testid="phone-battery-soc" className={field} />
        </label>
        <label className="block">
          <span className="text-xs text-muted">Health %</span>
          <input inputMode="numeric" value={soh} onChange={(e) => setSoh(e.target.value.replace(/[^\d]/g, '').slice(0, 3))}
            placeholder="72" data-testid="phone-battery-soh" className={field} />
        </label>
      </div>

      {/* THE DENOMINATOR — first visit only. Health is measured against it, and it cannot be added
          afterwards, which is the entire reason it is asked for at the car rather than in the office. */}
      <div className="mt-2">
        <span className="text-xs text-muted">Battery rating {lastRatedCca != null && <em className="not-italic">— remembered from last time</em>}</span>
        <div className="flex gap-2 mt-1">
          <input inputMode="numeric" value={ratedCca} onChange={(e) => setRatedCca(e.target.value.replace(/[^\d]/g, '').slice(0, 4))}
            placeholder="700" data-testid="phone-battery-cca" className={`${field} max-w-[6.5rem]`} />
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="CCA standard">
            {STANDARDS.map((k) => (
              <button key={k} type="button" role="radio" aria-checked={std === k} onClick={() => setStd(std === k ? '' : k)}
                data-testid={`phone-battery-std-${k}`}
                className={`min-h-[48px] px-2.5 text-xs font-semibold rounded-lg border ${std === k ? 'bg-ink text-white border-ink' : 'bg-surface border-line text-muted'}`}>
                {k}
              </button>
            ))}
          </div>
        </div>
      </div>

      {queued && <p className="text-sm text-ok mt-3" data-testid="phone-battery-queued">Saved. It’ll sync when you have signal.</p>}
      <button type="button" disabled={!ready} onClick={save} data-testid="phone-battery-save"
        className="mt-3 w-full min-h-[48px] text-sm font-semibold bg-accent text-white rounded-lg disabled:opacity-50">
        Save battery test
      </button>
    </section>
  );
}
