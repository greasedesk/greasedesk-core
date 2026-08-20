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
import React, { useEffect, useRef, useState } from 'react';
import { resizeImage } from '@/lib/image-resize';
import { TyreSummary } from '@/components/jobcard/ConditionSummary';
import type { TyreCondition } from '@/lib/vehicle-condition';

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

type Props = {
  jobCardId: string; canEdit: boolean; defaultType?: TyreType | null;
  /** What the CAR says (lib/vehicle-condition) — shown above the form, across all visits. */
  recorded?: TyreCondition[];
  /** What THIS VISIT recorded — what the form opens on. Not the same thing; see lib/jobcard-page-data. */
  onThisCard?: TyreOnThisCard[];
  onSaved: () => void;
};

const tyreSlot = (c: TyreCorner) => `tyre_${c}`;

/**
 * ── THE FORM OPENS ON WHAT THE CAR ALREADY SAYS ─────────────────────────────────────────────────
 * It used to open blank, always. TyreSummary showed the recorded depths above the form while every
 * chip below sat unselected and the counter read "0 of 4" over four stored corners — the panel
 * reporting itself unfilled when it was not, on the one screen whose job is to say what has been
 * measured. A mechanic could not tell what they had entered, and a colleague could not tell whether
 * the tyres had been done at all.
 *
 * Seeded from `raw` (lib/vehicle-condition), not from the display strings beside it: parsing "8.0"
 * back into 80 would make this a second reader of our own output.
 *
 * A useState INITIALISER, not an effect. It runs once per mount, so a save that refreshes the card
 * cannot clobber what someone is halfway through typing; leaving the tab unmounts and re-seeds.
 */
export type TyreOnThisCard = {
  corner: string; type: string;
  depth_outer_tenths: number; depth_centre_tenths: number; depth_inner_tenths: number;
};

const seedFrom = (rows: TyreOnThisCard[], fallbackType: TyreType): Record<TyreCorner, Corner> => {
  const out: Record<TyreCorner, Corner> = {
    front_left: blank(fallbackType), front_right: blank(fallbackType),
    rear_left: blank(fallbackType), rear_right: blank(fallbackType),
  };
  for (const r of rows) {
    const c = r.corner as TyreCorner;
    if (!(c in out)) continue;
    const o = r.depth_outer_tenths, m = r.depth_centre_tenths, i = r.depth_inner_tenths;
    out[c] = (o === m && m === i)
      ? { type: r.type as TyreType, even: o, outer: null, centre: null, inner: null, uneven: false }
      : { type: r.type as TyreType, even: null, outer: o, centre: m, inner: i, uneven: true };
  }
  return out;
};

/** Same corner, same three depths, same type — nothing to write. */
const unchanged = (a: Corner, b: Corner) =>
  a.type === b.type && a.uneven === b.uneven && a.even === b.even
  && a.outer === b.outer && a.centre === b.centre && a.inner === b.inner;

export default function TyreCapture({ jobCardId, canEdit, defaultType, recorded = [], onThisCard = [], onSaved }: Props) {
  const seedType = defaultType ?? 'summer_standard';
  const [seed, setSeed] = useState<Record<TyreCorner, Corner>>(() => seedFrom(onThisCard, seedType));
  const [state, setState] = useState<Record<TyreCorner, Corner>>(() => seedFrom(onThisCard, seedType));
  // RE-SEEDS WHEN A NEW PAYLOAD ARRIVES, while untouched. This surface is server-rendered so it
  // cannot hit the phone's stale-first-paint case — but after a save, `seed` still held the
  // pre-save values, so the button went on offering to re-save what had just been saved. Same
  // effect, same guard: `dirty` protects work in progress.
  const [dirty, setDirty] = useState(false);
  const fingerprint = JSON.stringify(onThisCard);
  const seenRef = useRef(fingerprint);
  useEffect(() => {
    if (dirty || fingerprint === seenRef.current) return;
    seenRef.current = fingerprint;
    const fresh = seedFrom(onThisCard, seedType);
    setSeed(fresh); setState(fresh);
  }, [fingerprint, dirty, onThisCard, seedType]);
  // WHICH CORNERS ARE OPEN FOR EDITING. A recorded corner collapses to its value; this is how it
  // reopens. Never pre-populated — a corner someone has already measured should not greet them
  // with eight chips they have to read past.
  const [editing, setEditing] = useState<Partial<Record<TyreCorner, boolean>>>({});
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

  const set = (c: TyreCorner, patch: Partial<Corner>) => { setDirty(true); setState((s) => ({ ...s, [c]: { ...s[c], ...patch } })); };
  const depthsOf = (c: Corner) => c.uneven
    ? { outer: c.outer, centre: c.centre, inner: c.inner }
    : { outer: c.even, centre: c.even, inner: c.even };
  const complete = (c: Corner) => Object.values(depthsOf(c)).every((v) => typeof v === 'number' && v > 0);
  const filled = CORNERS.filter(({ key }) => complete(state[key])).length;
  // WHAT WOULD ACTUALLY BE WRITTEN. `filled` answers "how much of this car is measured" and now
  // reads 4 of 4 the moment the form opens on a finished set — which is the honest answer and the
  // wrong basis for a Save button. A button offering to save four corners that are already saved
  // is the same lie in the other direction.
  const changed = CORNERS.filter(({ key }) => complete(state[key]) && !unchanged(state[key], seed[key])).length;

  async function save() {
    setBusy(true); setErr(null);
    try {
      // ONLY WHAT CHANGED. Now that the form opens on this visit's readings, sending every
      // complete corner would re-write the three a mechanic never touched — and the upsert sets
      // measured_at to now, so untouched corners would be re-dated to the moment somebody pressed
      // Save on a fourth. "A corner not re-measured today is still the truth" has to survive the
      // form knowing what it already holds.
      const corners = CORNERS.filter(({ key }) => complete(state[key]) && !unchanged(state[key], seed[key]))
        .map(({ key }) => ({
          corner: key, type: state[key].type, depths: depthsOf(state[key]) as { outer: number; centre: number; inner: number },
        }));
      if (!corners.length) { setDone(true); return; }
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
      {/* WHAT IS ALREADY RECORDED, above the form that records it. */}
      <TyreSummary tyres={recorded} />
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

              {complete(c) && !editing[key] ? (
                // COLLAPSED. The value is the point; the eight chips that produced it are not.
                <button type="button" disabled={!canEdit || busy} onClick={() => setEditing((e) => ({ ...e, [key]: true }))}
                  data-testid={`tyre-${key}-change`} className="text-xs text-accent underline">Change</button>
              ) : !c.uneven ? (
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

              <div className={`flex flex-wrap items-center gap-2 ${complete(c) && !editing[key] ? '' : 'mt-2'}`}>
                <button type="button" disabled={!canEdit || busy || upBusy !== null}
                  onClick={() => { shotFor.current = key; fileRef.current?.click(); }}
                  data-testid={`tyre-${key}-photo`} className="text-xs text-accent underline">
                  {upBusy === key ? 'Uploading…' : shots[key] ? `Photo ✓${shots[key]! > 1 ? ` ×${shots[key]}` : ''}` : 'Photo'}
                </button>
                {/* HIDDEN ON A COLLAPSED CORNER. "Worn unevenly" beside a settled reading invites a
                    mode change nobody asked for; Change is the way back in. */}
                {(!complete(c) || editing[key]) && (
                  <button type="button" disabled={!canEdit || busy} onClick={() => set(key, { uneven: !c.uneven })}
                    data-testid={`tyre-${key}-uneven`} className="text-xs text-accent underline">
                    {c.uneven ? 'Same across the tyre' : 'Worn unevenly'}
                  </button>
                )}
              </div>

              {/* ── TYPE: FOUR VISIBLE OPTIONS, ONE TAP ──────────────────────────────────────────
                  This was a <select>, which on a phone is tap-scroll-tap and a native wheel that
                  covers the screen — three interactions and a lost sense of place, for a field that
                  is usually already correct. Four chips are one tap and, more often, zero: the
                  value is pre-filled from this car's last reading, so the row reads as a
                  confirmation. Same reasoning as the depth chips, and it matters more here because
                  the select was the only non-chip control left in the form. */}
              <div className="flex flex-wrap gap-1.5 mt-2" role="radiogroup" aria-label={`${label} tyre type`}>
                {TYPES.map((ty) => (
                  <button key={ty.key} type="button" role="radio" aria-checked={c.type === ty.key}
                    disabled={!canEdit || busy} onClick={() => set(key, { type: ty.key })}
                    data-testid={`tyre-${key}-type-${ty.key}`}
                    className={`min-h-[36px] text-xs font-medium rounded-lg border px-2.5 ${c.type === ty.key ? 'bg-ink text-white border-ink' : 'bg-surface border-line text-muted'}`}>
                    {ty.label}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {err && <p className="text-sm text-danger mt-3">{err}</p>}
      {done && <p className="text-sm text-ok mt-3" data-testid="tyre-saved">Tyres saved. Anything worn is now on the car’s list.</p>}
      {canEdit && (
        <button type="button" disabled={busy || changed === 0} onClick={save} data-testid="tyre-save"
          className="mt-3 text-sm font-semibold bg-accent hover:bg-accent-hover text-white rounded-lg px-4 py-2.5 disabled:opacity-50">
          {busy ? 'Saving…' : changed === 0 ? 'Nothing to save' : changed === 4 ? 'Save all four' : `Save ${changed}`}
        </button>
      )}
    </div>
  );
}
