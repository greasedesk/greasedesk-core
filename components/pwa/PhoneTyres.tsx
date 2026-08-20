/**
 * File: components/pwa/PhoneTyres.tsx
 * FOUR TYRES, ON THE PHONE — the surface the mechanic is actually holding.
 *
 * ── WHY THIS IS NOT THE DESKTOP COMPONENT ───────────────────────────────────────────────────────
 * The desktop form talks to the API directly. Here every write goes through the OUTBOX, because a
 * bay has no signal and a mechanic must never lose a measurement to a dead bar. Same interaction —
 * one tap per corner, split only where the wear is uneven, type as four visible options — but the
 * save is a durable enqueue, not a request.
 *
 * The queue makes it replay-safe: TyreReading is unique on (job_card_id, corner), so a redelivered
 * envelope upserts the same rows. Nothing here needs an id for that.
 */
import React, { useState } from 'react';
import { enqueueTyres } from '@/lib/pwa-outbox';
import { TyreSummary } from '@/components/jobcard/ConditionSummary';
import type { TyreCondition } from '@/lib/vehicle-condition';

type Corner = 'front_left' | 'front_right' | 'rear_left' | 'rear_right';
type TType = 'summer_standard' | 'summer_runflat' | 'winter_standard' | 'winter_runflat';

const CORNERS: Array<{ k: Corner; l: string }> = [
  { k: 'front_left', l: 'Front left' }, { k: 'front_right', l: 'Front right' },
  { k: 'rear_left', l: 'Rear left' }, { k: 'rear_right', l: 'Rear right' },
];
const TYPES: Array<{ k: TType; l: string }> = [
  { k: 'summer_standard', l: 'Summer' }, { k: 'summer_runflat', l: 'Summer RF' },
  { k: 'winter_standard', l: 'Winter' }, { k: 'winter_runflat', l: 'Winter RF' },
];
const CHIPS = [80, 70, 60, 50, 40, 30, 20, 16];
const mm = (t: number) => (t / 10).toFixed(1);

type C = { type: TType; even: number | null; outer: number | null; centre: number | null; inner: number | null; uneven: boolean };
const blank = (t: TType): C => ({ type: t, even: null, outer: null, centre: null, inner: null, uneven: false });

type OnThisCard = { corner: string; type: string; depth_outer_tenths: number; depth_centre_tenths: number; depth_inner_tenths: number };

/**
 * SEEDED FROM THIS VISIT'S ROWS, not blank and not from the car's latest.
 *
 * Blank was the bug: after a save and a reload every chip sat unselected and the counter read
 * "0 of 4" over four stored corners. The car's latest would have been a worse fix — TyreReading is
 * unique on (job_card_id, corner), so it can be a reading from a visit last March, and saving would
 * stamp it as measured today.
 */
const seedFrom = (rows: OnThisCard[], fallback: TType): Record<Corner, C> => {
  const out: Record<Corner, C> = {
    front_left: blank(fallback), front_right: blank(fallback), rear_left: blank(fallback), rear_right: blank(fallback),
  };
  for (const r of rows) {
    const k = r.corner as Corner;
    if (!(k in out)) continue;
    const o = r.depth_outer_tenths, m = r.depth_centre_tenths, i = r.depth_inner_tenths;
    out[k] = (o === m && m === i)
      ? { type: r.type as TType, even: o, outer: null, centre: null, inner: null, uneven: false }
      : { type: r.type as TType, even: null, outer: o, centre: m, inner: i, uneven: true };
  }
  return out;
};

const same = (a: C, b: C) => a.type === b.type && a.uneven === b.uneven && a.even === b.even
  && a.outer === b.outer && a.centre === b.centre && a.inner === b.inner;

export default function PhoneTyres({ jobCardId, defaultType, recorded = [], onThisCard = [], onQueued }: {
  jobCardId: string; defaultType?: string | null;
  /** What the CAR says, across visits — shown above the form. */
  recorded?: TyreCondition[];
  /** What THIS VISIT recorded — what the form opens on. */
  onThisCard?: OnThisCard[];
  onQueued?: () => void;
}) {
  const seed = (defaultType as TType) ?? 'summer_standard';
  const [base] = useState<Record<Corner, C>>(() => seedFrom(onThisCard, seed));
  const [s, setS] = useState<Record<Corner, C>>(() => seedFrom(onThisCard, seed));
  // A recorded corner collapses to its value; this is how it reopens.
  const [editing, setEditing] = useState<Partial<Record<Corner, boolean>>>({});
  const [queued, setQueued] = useState(false);
  const set = (c: Corner, p: Partial<C>) => setS((x) => ({ ...x, [c]: { ...x[c], ...p } }));
  const depths = (c: C) => c.uneven ? { outer: c.outer, centre: c.centre, inner: c.inner } : { outer: c.even, centre: c.even, inner: c.even };
  const ok = (c: C) => Object.values(depths(c)).every((v) => typeof v === 'number' && v > 0);
  const filled = CORNERS.filter(({ k }) => ok(s[k])).length;
  // What would actually be queued. See TyreCapture: `filled` is the honest answer to "how much of
  // this car is measured" and the wrong basis for a Save button once the form opens on real values.
  const changed = CORNERS.filter(({ k }) => ok(s[k]) && !same(s[k], base[k])).length;

  async function save() {
    await enqueueTyres({
      jobCardId,
      // ONLY WHAT CHANGED — the outbox writes through the same upsert, which re-dates measured_at.
      corners: CORNERS.filter(({ k }) => ok(s[k]) && !same(s[k], base[k])).map(({ k }) => ({
        corner: k, type: s[k].type, depths: depths(s[k]) as { outer: number; centre: number; inner: number },
      })),
    });
    setQueued(true);
    onQueued?.();
  }

  // 44px minimum: a gloved thumb on a phone, not a mouse.
  const chip = (on: boolean) => `min-h-[44px] min-w-[46px] text-sm font-semibold rounded-lg border ${on ? 'bg-accent text-white border-accent' : 'bg-surface border-line text-ink'}`;

  return (
    <section className="bg-surface border border-line rounded-xl p-4" data-testid="phone-tyres">
      <div className="flex items-baseline justify-between mb-1">
        <h2 className="text-sm font-semibold text-ink">Tyres</h2>
        <span className="text-xs text-muted" data-testid="phone-tyre-progress">{filled} of 4</span>
      </div>
      <TyreSummary tyres={recorded} />
      <p className="text-xs text-muted mb-3">Tap the tread depth. Only open a tyre up if it’s worn unevenly.</p>

      <div className="space-y-3">
        {CORNERS.map(({ k, l }) => {
          const c = s[k];
          return (
            <div key={k} className="bg-surface-muted rounded-lg p-3" data-testid={`ph-tyre-${k}`}>
              <div className="flex items-baseline justify-between mb-2">
                <span className="text-sm font-medium text-ink">{l}</span>
                {ok(c) && <span className="text-xs text-ok">{c.uneven ? `${mm(c.outer!)}/${mm(c.centre!)}/${mm(c.inner!)}` : `${mm(c.even!)}mm`}</span>}
              </div>
              {ok(c) && !editing[k] ? (
                <button type="button" onClick={() => setEditing((e) => ({ ...e, [k]: true }))}
                  data-testid={`ph-tyre-${k}-change`} className="text-xs text-accent underline min-h-[36px]">Change</button>
              ) : !c.uneven ? (
                <div className="flex flex-wrap gap-1.5">
                  {CHIPS.map((v) => (
                    <button key={v} type="button" onClick={() => set(k, { even: v })}
                      data-testid={`ph-tyre-${k}-chip-${v}`} className={chip(c.even === v)}>{mm(v)}</button>
                  ))}
                </div>
              ) : (
                <div className="space-y-2">
                  {([['outer', 'Outer'], ['centre', 'Centre'], ['inner', 'Inner']] as const).map(([f, lb]) => (
                    <div key={f}>
                      <p className="text-xs text-muted mb-1">{lb}</p>
                      <div className="flex flex-wrap gap-1.5">
                        {CHIPS.map((v) => (
                          <button key={v} type="button" onClick={() => set(k, { [f]: v } as Partial<C>)}
                            data-testid={`ph-tyre-${k}-${f}-${v}`} className={chip(c[f] === v)}>{mm(v)}</button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {(!ok(c) || editing[k]) && (
                <button type="button" onClick={() => set(k, { uneven: !c.uneven })} data-testid={`ph-tyre-${k}-uneven`}
                  className="mt-2 text-xs text-accent underline min-h-[36px]">
                  {c.uneven ? 'Same across the tyre' : 'Worn unevenly'}
                </button>
              )}
              <div className="flex flex-wrap gap-1.5 mt-1" role="radiogroup" aria-label={`${l} tyre type`}>
                {TYPES.map((t) => (
                  <button key={t.k} type="button" role="radio" aria-checked={c.type === t.k} onClick={() => set(k, { type: t.k })}
                    data-testid={`ph-tyre-${k}-type-${t.k}`}
                    className={`min-h-[36px] text-xs font-medium rounded-lg border px-2.5 ${c.type === t.k ? 'bg-ink text-white border-ink' : 'bg-surface border-line text-muted'}`}>
                    {t.l}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {queued && <p className="text-sm text-ok mt-3" data-testid="phone-tyres-queued">Saved. It’ll sync when you have signal.</p>}
      <button type="button" disabled={changed === 0} onClick={save} data-testid="phone-tyre-save"
        className="mt-3 w-full min-h-[48px] text-sm font-semibold bg-accent text-white rounded-lg disabled:opacity-50">
        {changed === 0 ? 'Nothing to save' : changed === 4 ? 'Save all four' : `Save ${changed}`}
      </button>
    </section>
  );
}
