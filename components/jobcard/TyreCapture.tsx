/**
 * File: components/jobcard/TyreCapture.tsx
 * FOUR TYRES, IN AS FEW TAPS AS THE CAR ALLOWS.
 *
 * ── THE DESIGN CONSTRAINT IS TIME, NOT COMPLETENESS ─────────────────────────────────────────────
 * Twelve numeric fields and four dropdowns on a phone at a car will not get done, and a feature
 * mechanics skip earns nothing however good the model behind it is. So:
 *
 *   ONE TAP PER CORNER sets all three readings at once. Even wear is the common case, so a whole
 *   car is four taps.
 *
 *   "WORN UNEVENLY" SPLITS ONE CORNER into three inputs — and that expansion happens exactly where
 *   the alignment signal lives, so the extra effort is spent only where there is something to
 *   learn. A mechanic who sees even wear never touches it.
 *
 *   THE TYPE IS PRE-FILLED from this car's last recorded reading. Cars rarely change tyre type
 *   between services, so the common case is ZERO taps and the control is a confirmation.
 *
 * Chip values are the real-world clusters, and 1.6 is present because it is the legal limit and a
 * mechanic reaches for it by name.
 */
import React, { useRef, useState } from 'react';
import { resizeImage } from '@/lib/image-resize';

export type TyreCorner = 'front_left' | 'front_right' | 'rear_left' | 'rear_right';
export type TyreType = 'summer_standard' | 'summer_runflat' | 'winter_standard' | 'winter_runflat';

const CORNERS: Array<{ key: TyreCorner; label: string }> = [
  { key: 'front_left', label: 'Front left' }, { key: 'front_right', label: 'Front right' },
  { key: 'rear_left', label: 'Rear left' }, { key: 'rear_right', label: 'Rear right' },
];
const TYPES: Array<{ key: TyreType; label: string }> = [
  { key: 'summer_standard', label: 'Summer' }, { key: 'summer_runflat', label: 'Summer RF' },
  { key: 'winter_standard', label: 'Winter' }, { key: 'winter_runflat', label: 'Winter RF' },
];
/** Tenths of a mm. 16 = 1.6mm, the legal limit. */
const CHIPS = [80, 70, 60, 50, 40, 30, 20, 16];
const mm = (t: number) => (t / 10).toFixed(1);

type Corner = { type: TyreType; even: number | null; outer: number | null; centre: number | null; inner: number | null; uneven: boolean };
const blank = (type: TyreType): Corner => ({ type, even: null, outer: null, centre: null, inner: null, uneven: false });

type Props = { jobCardId: string; canEdit: boolean; defaultType?: TyreType | null; onSaved: () => void };

const tyreSlot = (c: TyreCorner) => `tyre_${c}`;

export default function TyreCapture({ jobCardId, canEdit, defaultType, onSaved }: Props) {
  const seedType = defaultType ?? 'summer_standard';
  const [state, setState] = useState<Record<TyreCorner, Corner>>({
    front_left: blank(seedType), front_right: blank(seedType), rear_left: blank(seedType), rear_right: blank(seedType),
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  // PROOF, per corner. One shared file input retargeted at whichever corner asked for it — four
  // inputs would be four hidden elements doing the same job.
  const fileRef = useRef<HTMLInputElement>(null);
  const shotFor = useRef<TyreCorner | null>(null);
  const [shots, setShots] = useState<Partial<Record<TyreCorner, number>>>({});
  const [upBusy, setUpBusy] = useState<TyreCorner | null>(null);

  async function onPhoto(files: FileList | null) {
    const corner = shotFor.current; shotFor.current = null;
    if (!files?.length || !corner) return;
    setUpBusy(corner); setErr(null);
    try {
      // THE EXISTING PIPELINE, unchanged: client resize → presigned R2 PUT → commit. The slot is
      // the only new thing, and JobCardPhoto.slot is already a free string.
      const blob = await resizeImage(files[0]);
      const pre = await fetch('/api/photos/presign', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobCardId, stage: 'intake', slot: tyreSlot(corner), contentType: 'image/jpeg' }) });
      if (!pre.ok) { setErr('Could not start the upload.'); return; }
      const { photoId, key, uploadUrl } = await pre.json();
      const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
      if (!put.ok) { setErr('The photo didn’t upload.'); return; }
      await fetch('/api/photos', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobCardId, stage: 'intake', slot: tyreSlot(corner), photoId, key, label: `${CORNERS.find((x) => x.key === corner)?.label} tyre` }) });
      setShots((s) => ({ ...s, [corner]: (s[corner] ?? 0) + 1 }));
      onSaved();
    } catch { setErr('The photo didn’t upload.'); }
    finally { setUpBusy(null); if (fileRef.current) fileRef.current.value = ''; }
  }

  const set = (c: TyreCorner, patch: Partial<Corner>) => setState((s) => ({ ...s, [c]: { ...s[c], ...patch } }));
  const depthsOf = (c: Corner) => c.uneven
    ? { outer: c.outer, centre: c.centre, inner: c.inner }
    : { outer: c.even, centre: c.even, inner: c.even };
  const complete = (c: Corner) => Object.values(depthsOf(c)).every((v) => typeof v === 'number' && v > 0);
  const filled = CORNERS.filter(({ key }) => complete(state[key])).length;

  async function save() {
    setBusy(true); setErr(null);
    try {
      const corners = CORNERS.filter(({ key }) => complete(state[key])).map(({ key }) => ({
        corner: key, type: state[key].type, depths: depthsOf(state[key]) as { outer: number; centre: number; inner: number },
      }));
      const r = await fetch('/api/tyre-readings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobCardId, corners }),
      });
      const d = await r.json();
      if (!r.ok) { setErr(d?.message ?? 'Could not save that.'); return; }
      setDone(true); onSaved();
    } finally { setBusy(false); }
  }

  const chip = (on: boolean) =>
    `min-h-[44px] min-w-[44px] text-sm font-semibold rounded-lg border px-2 ${on ? 'bg-accent text-white border-accent' : 'bg-surface border-line text-ink'}`;

  return (
    <div className="bg-surface border border-line rounded-xl p-5" data-testid="tyre-capture">
      <div className="flex items-baseline justify-between gap-2 mb-1">
        <h3 className="text-sm font-semibold text-ink">Tyres</h3>
        <span className="text-xs text-muted" data-testid="tyre-progress">{filled} of 4</span>
      </div>
      <p className="text-xs text-muted mb-3">Tap the tread depth. Only open a tyre up if it’s worn unevenly.</p>

      {/* One input, retargeted. capture="environment" opens the rear camera on a phone. */}
      <input ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden"
        onChange={(e) => onPhoto(e.target.files)} />

      <div className="space-y-3">
        {CORNERS.map(({ key, label }) => {
          const c = state[key];
          return (
            <div key={key} className="bg-surface-muted rounded-lg p-3" data-testid={`tyre-${key}`}>
              <div className="flex items-baseline justify-between gap-2 mb-2">
                <span className="text-sm font-medium text-ink">{label}</span>
                {complete(c) && (
                  <span className="text-xs text-ok" data-testid={`tyre-done-${key}`}>
                    {c.uneven ? `${mm(c.outer!)} / ${mm(c.centre!)} / ${mm(c.inner!)}mm` : `${mm(c.even!)}mm`}
                  </span>
                )}
              </div>

              {!c.uneven ? (
                <div className="flex flex-wrap gap-1.5">
                  {CHIPS.map((v) => (
                    <button key={v} type="button" disabled={!canEdit || busy} onClick={() => set(key, { even: v })}
                      data-testid={`tyre-${key}-chip-${v}`} className={chip(c.even === v)}>{mm(v)}</button>
                  ))}
                </div>
              ) : (
                <div className="space-y-2">
                  {([['outer', 'Outer edge'], ['centre', 'Centre'], ['inner', 'Inner edge']] as const).map(([f, lbl]) => (
                    <div key={f}>
                      <p className="text-xs text-muted mb-1">{lbl}</p>
                      <div className="flex flex-wrap gap-1.5">
                        {CHIPS.map((v) => (
                          <button key={v} type="button" disabled={!canEdit || busy} onClick={() => set(key, { [f]: v } as Partial<Corner>)}
                            data-testid={`tyre-${key}-${f}-${v}`} className={chip(c[f] === v)}>{mm(v)}</button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2 mt-2">
                <button type="button" disabled={!canEdit || busy || upBusy !== null}
                  onClick={() => { shotFor.current = key; fileRef.current?.click(); }}
                  data-testid={`tyre-${key}-photo`} className="text-xs text-accent underline">
                  {upBusy === key ? 'Uploading…' : shots[key] ? `Photo ✓${shots[key]! > 1 ? ` ×${shots[key]}` : ''}` : 'Photo'}
                </button>
                <button type="button" disabled={!canEdit || busy} onClick={() => set(key, { uneven: !c.uneven })}
                  data-testid={`tyre-${key}-uneven`} className="text-xs text-accent underline">
                  {c.uneven ? 'Same across the tyre' : 'Worn unevenly'}
                </button>
                {/* THE TYPE, pre-filled from this car's last reading — usually a confirmation, not
                    an entry. Tucked to the right so it does not compete with the depth chips. */}
                <select value={c.type} disabled={!canEdit || busy} onChange={(e) => set(key, { type: e.target.value as TyreType })}
                  data-testid={`tyre-${key}-type`}
                  className="ml-auto text-xs bg-surface border border-line rounded-lg px-2 py-1.5 text-ink">
                  {TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
                </select>
              </div>
            </div>
          );
        })}
      </div>

      {err && <p className="text-sm text-danger mt-3">{err}</p>}
      {done && <p className="text-sm text-ok mt-3" data-testid="tyre-saved">Tyres saved. Anything worn is now on the car’s list.</p>}
      {canEdit && (
        <button type="button" disabled={busy || filled === 0} onClick={save} data-testid="tyre-save"
          className="mt-3 text-sm font-semibold bg-accent hover:bg-accent-hover text-white rounded-lg px-4 py-2.5 disabled:opacity-50">
          {busy ? 'Saving…' : filled === 4 ? 'Save all four' : `Save ${filled}`}
        </button>
      )}
    </div>
  );
}
