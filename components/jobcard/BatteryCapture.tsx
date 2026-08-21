/**
 * File: components/jobcard/BatteryCapture.tsx
 * THE BATTERY TEST — three numbers off the tester and two photographs of the screens they came off.
 *
 * ── WHY THESE ARE TYPED AND THE TYRES ARE TAPPED ────────────────────────────────────────────────
 * Tread depth chips work because the useful values cluster and a tenth either way changes nothing.
 * A voltage cannot be chipped — 11.98 is 11.98 — and the charge and health percentages come off the
 * tester exact. Offering chips here would round away the precision that makes the reading evidence,
 * so all three are numeric fields with a numeric keypad and bounds. Ten keystrokes, not twelve taps.
 *
 * ── THE RATING IS FIRST-VISIT-ONLY WORK ─────────────────────────────────────────────────────────
 * The rated CCA and its standard belong to the CAR, so they prefill from its last test and the
 * common case is zero input — the same trick as the tyre type. They are captured at all because the
 * health percentage is measured AGAINST them: type 400 for a 700 battery and the health reads
 * catastrophically low, and without the denominator stored nobody can ever see that it did. It
 * cannot be retrofitted, which is the whole argument for asking now.
 */
import React, { useRef, useState } from 'react';
import { resizeImage } from '@/lib/image-resize';
import { BatterySummary } from '@/components/jobcard/ConditionSummary';
import type { BatteryCondition } from '@/lib/vehicle-condition';
import { CCA_STANDARDS, CCA_STANDARD_LABEL, MIN_RATED_CCA, MAX_RATED_CCA, BATTERY_SLOTS, BATTERY_SLOT_LABEL, type BatterySlot, type CcaStandard } from '@/lib/battery';

type Props = {
  jobCardId: string;
  canEdit: boolean;
  /** This car's last test, so the rating is a confirmation rather than a lookup. */
  lastRatedCca?: number | null;
  lastCcaStandard?: string | null;
  /** What the car ALREADY says (lib/vehicle-condition). The form used to be write-only. */
  recorded?: BatteryCondition | null;
  onSaved: () => void;
};

const num = (s: string) => (s.trim() === '' ? null : Number(s));

export default function BatteryCapture({ jobCardId, canEdit, lastRatedCca, lastCcaStandard, recorded = null, onSaved }: Props) {
  const [voltage, setVoltage] = useState('');
  const [soc, setSoc] = useState('');
  const [soh, setSoh] = useState('');
  const [ratedCca, setRatedCca] = useState(lastRatedCca != null ? String(lastRatedCca) : '');
  const [std, setStd] = useState<CcaStandard | ''>((lastCcaStandard as CcaStandard) ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const fileRef = useRef<HTMLInputElement>(null);
  const shotFor = useRef<BatterySlot | null>(null);
  const [shots, setShots] = useState<Partial<Record<BatterySlot, number>>>({});
  const [upBusy, setUpBusy] = useState<BatterySlot | null>(null);

  const v = num(voltage), sc = num(soc), sh = num(soh);
  const inRange = (n: number | null, lo: number, hi: number) => n != null && Number.isFinite(n) && n >= lo && n <= hi;
  // Shown only once something out-of-range has been typed — a hint after the fact, never a warning
  // before anybody has done anything.
  const ccaOdd = ratedCca.trim() !== '' && !inRange(num(ratedCca), MIN_RATED_CCA, MAX_RATED_CCA);
  // All three, or nothing. A test with two of the numbers is not a test — and a missing one would
  // silently change which state lib/battery lands in.
  const ready = inRange(v, 0.1, 30) && inRange(sc, 0, 100) && inRange(sh, 0, 100)
    // Both or neither: a rating without its standard is not comparable to another rating.
    // The floor is checked HERE too, so the Save button stays off rather than the mechanic tapping
    // it and getting a sentence back. lib/battery owns the number; this just asks it.
    && ((ratedCca.trim() === '' && std === '')
      || (num(ratedCca) != null && std !== '' && (num(ratedCca) as number) >= MIN_RATED_CCA && (num(ratedCca) as number) <= MAX_RATED_CCA));

  async function onPhoto(files: FileList | null) {
    const slot = shotFor.current; shotFor.current = null;
    if (!files?.length || !slot) return;
    setUpBusy(slot); setErr(null);
    try {
      // THE EXISTING PIPELINE, unchanged — JobCardPhoto.slot is free text, so these two slots need
      // no schema change at all. The same inheritance the tyre corners got.
      const blob = await resizeImage(files[0]);
      const pre = await fetch('/api/photos/presign', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobCardId, stage: 'intake', slot, contentType: 'image/jpeg' }) });
      if (!pre.ok) { setErr('Could not start the upload.'); return; }
      const { photoId, key, uploadUrl } = await pre.json();
      const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
      if (!put.ok) { setErr('The photo didn’t upload.'); return; }
      await fetch('/api/photos', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobCardId, stage: 'intake', slot, photoId, key, label: BATTERY_SLOT_LABEL[slot] }) });
      setShots((s) => ({ ...s, [slot]: (s[slot] ?? 0) + 1 }));
      onSaved();
    } catch { setErr('The photo didn’t upload.'); }
    finally { setUpBusy(null); if (fileRef.current) fileRef.current.value = ''; }
  }

  async function save() {
    setBusy(true); setErr(null); setSaved(null);
    try {
      const r = await fetch('/api/battery-readings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobCardId, voltage: v, socPct: Math.round(sc as number), sohPct: Math.round(sh as number),
          ratedCca: ratedCca.trim() === '' ? null : Math.round(num(ratedCca) as number),
          ccaStandard: std === '' ? null : std,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(j?.message ?? 'The reading didn’t save.'); return; }
      // The STATE, echoed back from the one place the rule lives — so the mechanic sees what the
      // reading meant rather than guessing from the numbers.
      setSaved(j?.advisory ? 'Saved — an advisory was raised.' : 'Saved — nothing to advise.');
      onSaved();
    } catch { setErr('The reading didn’t save.'); }
    finally { setBusy(false); }
  }

  // A tabular numeric field. inputMode brings up the phone's number pad rather than the alphabet.
  const field = 'w-full min-h-[44px] px-3 bg-surface border border-line rounded-lg text-ink text-sm tabular-nums';

  return (
    <section className="bg-surface border border-line rounded-xl p-4" data-testid="battery-capture">
      <h2 className="text-sm font-semibold text-ink mb-1">Battery test</h2>
      {/* WHAT IS ALREADY RECORDED, above the form that records it. */}
      <BatterySummary battery={recorded} />
      <p className="text-xs text-muted mb-3">
        All three off the tester. Charge and health mean different things — a flat battery reads low
        on health whether or not it is failing.
      </p>

      <div className="grid grid-cols-3 gap-2">
        <label className="block">
          <span className="text-xs text-muted">Voltage</span>
          <input inputMode="decimal" value={voltage} disabled={!canEdit}
            onChange={(e) => setVoltage(e.target.value.replace(/[^\d.]/g, ''))}
            placeholder="12.45" data-testid="battery-voltage" className={field} />
        </label>
        <label className="block">
          <span className="text-xs text-muted">Charge %</span>
          <input inputMode="numeric" value={soc} disabled={!canEdit}
            onChange={(e) => setSoc(e.target.value.replace(/[^\d]/g, '').slice(0, 3))}
            placeholder="86" data-testid="battery-soc" className={field} />
        </label>
        <label className="block">
          <span className="text-xs text-muted">Health %</span>
          <input inputMode="numeric" value={soh} disabled={!canEdit}
            onChange={(e) => setSoh(e.target.value.replace(/[^\d]/g, '').slice(0, 3))}
            placeholder="72" data-testid="battery-soh" className={field} />
        </label>
      </div>

      {/* THE DENOMINATOR. Prefilled from this car's last test, so it is usually already right. */}
      <div className="grid grid-cols-3 gap-2 mt-2">
        <label className="block">
          <span className="text-xs text-muted">Rated CCA</span>
          <input inputMode="numeric" value={ratedCca} disabled={!canEdit}
            onChange={(e) => setRatedCca(e.target.value.replace(/[^\d]/g, '').slice(0, 4))}
            placeholder="700" data-testid="battery-rated-cca" className={field} />
        </label>
        <div className="col-span-2">
          <span className="text-xs text-muted">Standard</span>
          <div className="flex flex-wrap gap-1.5 mt-0.5" role="radiogroup" aria-label="CCA standard">
            {CCA_STANDARDS.map((k) => (
              <button key={k} type="button" role="radio" aria-checked={std === k} disabled={!canEdit}
                onClick={() => setStd(std === k ? '' : k)} data-testid={`battery-std-${k}`}
                className={`min-h-[44px] px-3 text-xs font-semibold rounded-lg border ${std === k ? 'bg-ink text-white border-ink' : 'bg-surface border-line text-muted'}`}>
                {CCA_STANDARD_LABEL[k]}
              </button>
            ))}
          </div>
        </div>
      </div>
      <p className={`text-[11px] mt-1 ${ccaOdd ? 'text-warn' : 'text-muted'}`} data-testid="battery-cca-hint">
        {ccaOdd
          ? 'Most car batteries are 400–800. It’s on the battery label, by the EN or SAE mark.'
          : 'Health is measured against this rating, so it is worth getting right — and it can’t be added afterwards. It’ll be remembered for next time.'}
      </p>

      {/* PROOF. One shared file input retargeted at whichever screen is being photographed. */}
      <input ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden"
        onChange={(e) => onPhoto(e.target.files)} />
      <div className="flex flex-wrap gap-2 mt-3">
        {BATTERY_SLOTS.map((slot) => (
          <button key={slot} type="button" disabled={!canEdit || upBusy !== null}
            onClick={() => { shotFor.current = slot; fileRef.current?.click(); }}
            data-testid={`battery-photo-${slot}`}
            className="min-h-[44px] px-3 text-xs font-medium rounded-lg border border-line bg-surface text-ink disabled:opacity-50">
            {upBusy === slot ? 'Uploading…' : `${BATTERY_SLOT_LABEL[slot]}${shots[slot] ? ` ✓${shots[slot]}` : ''}`}
          </button>
        ))}
      </div>

      {err && <p className="text-sm text-danger mt-2" data-testid="battery-error">{err}</p>}
      {saved && <p className="text-sm text-ok mt-2" data-testid="battery-saved">{saved}</p>}

      <button type="button" disabled={!canEdit || !ready || busy} onClick={save} data-testid="battery-save"
        className="mt-3 w-full min-h-[44px] text-sm font-semibold bg-accent text-white rounded-lg disabled:opacity-50">
        {busy ? 'Saving…' : 'Save battery test'}
      </button>
    </section>
  );
}
