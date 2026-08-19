/**
 * File: components/jobcard/ObservationTaps.tsx
 * THE THINGS A MECHANIC NOTICES — tapped, not typed.
 *
 * A wiper blade is £15 and never gets sold, because writing four words costs more attention than
 * the sale is worth at the moment it is noticed. So the whole design goal is the number of taps.
 *
 * Two taps to a finding, three for a bulb, and then ONE MORE that cannot be removed: whether it was
 * raised with the customer. That last one is the boundary of the speed argument — a silent default
 * would record every finding as "not raised" and `declined`, the only response that is a lead,
 * would never appear. See lib/observations.
 *
 * The list is ordered by THIS GARAGE's own history, most-used first. That is not polish: seventeen
 * chips in authored order is a visual search, and a visual search is slower than typing.
 */
import React, { useState } from 'react';
import { VISIBLE_BEFORE_MORE, BULB_GROUP_LABEL, bulbMembers, orderedTapList, isBulbTap, type Observation } from '@/lib/observations';

const ANSWERS = [
  { k: 'not_raised', l: 'Not raised yet' }, { k: 'declined', l: 'They declined' }, { k: 'agreed_later', l: 'Wants it later' },
] as const;

type Props = {
  jobCardId: string;
  canEdit: boolean;
  /** This garage's own usage, for the ordering. Empty on day one, which is why the catalogue has a
   *  deliberate cold-start order rather than an alphabetical one. */
  counts?: Record<string, number>;
  /** Keys already open on this car — tapping one again would be a no-op, so it is shown as done. */
  openKeys?: string[];
  onSaved: () => void;
};

export default function ObservationTaps({ jobCardId, canEdit, counts = {}, openKeys = [], onSaved }: Props) {
  // Hooks before any early return — a panel that changes shape must not change hook count.
  const [chosen, setChosen] = useState<Observation | null>(null);
  const [bulbOpen, setBulbOpen] = useState(false);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState<string | null>(null);

  const open = new Set(openKeys);
  // ONE ordering rule, in lib/observations. It used to be written out here and again on the other
  // surface, which is two chances to disagree about what a mechanic sees.
  const withBulb = orderedTapList(counts);
  const visible = more ? withBulb : withBulb.slice(0, VISIBLE_BEFORE_MORE);

  async function save(obs: Observation, customerResponse: string) {
    setBusy(true); setErr(null);
    try {
      const r = await fetch('/api/observations', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobCardId, key: obs.key, customerResponse }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(j?.message ?? 'That didn’t save.'); return; }
      setJustSaved(obs.description);
      setChosen(null); setBulbOpen(false);
      onSaved();
    } catch { setErr('That didn’t save.'); }
    finally { setBusy(false); }
  }

  const chip = (on: boolean) =>
    `min-h-[44px] px-3 text-sm font-medium rounded-lg border ${on ? 'bg-accent text-white border-accent' : 'bg-surface border-line text-ink'}`;

  return (
    <section className="bg-surface border border-line rounded-xl p-4" data-testid="observation-taps">
      <h2 className="text-sm font-semibold text-ink mb-1">Spotted it</h2>
      <p className="text-xs text-muted mb-3">Tap what you noticed. Anything else goes in the findings form.</p>

      {/* STEP 2 — the answer. Shown INSTEAD of the list, so the one required tap is the only thing
          on screen and cannot be missed on the way past. */}
      {chosen ? (
        <div data-testid="observation-answer">
          <p className="text-sm font-medium text-ink mb-2">{chosen.description}</p>
          <p className="text-xs text-muted mb-2">Raised with the customer?</p>
          <div className="flex flex-wrap gap-2">
            {ANSWERS.map((a) => (
              <button key={a.k} type="button" disabled={busy} onClick={() => save(chosen, a.k)}
                data-testid={`observation-answer-${a.k}`} className={chip(false)}>{a.l}</button>
            ))}
          </div>
          <button type="button" onClick={() => setChosen(null)} className="mt-2 text-xs text-muted underline min-h-[36px]">
            Back
          </button>
        </div>
      ) : bulbOpen ? (
        <div data-testid="observation-bulbs">
          <p className="text-sm font-medium text-ink mb-2">Which one?</p>
          <div className="grid grid-cols-2 gap-2">
            {bulbMembers().map((o) => (
              <button key={o.key} type="button" disabled={!canEdit || open.has(o.key)} onClick={() => setChosen(o)}
                data-testid={`observation-${o.key}`} className={`${chip(false)} disabled:opacity-40`}>{o.label}</button>
            ))}
          </div>
          <button type="button" onClick={() => setBulbOpen(false)} className="mt-2 text-xs text-muted underline min-h-[36px]">
            Back
          </button>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {visible.map((o) => isBulbTap(o) ? (
              <button key="bulb" type="button" disabled={!canEdit} onClick={() => setBulbOpen(true)}
                data-testid="observation-bulb-group" className={chip(false)}>{BULB_GROUP_LABEL}</button>
            ) : (
              <button key={o.key} type="button" disabled={!canEdit || open.has(o.key)} onClick={() => setChosen(o)}
                data-testid={`observation-${o.key}`} className={`${chip(false)} disabled:opacity-40`}>
                {o.label}{open.has(o.key) ? ' ✓' : ''}
              </button>
            ))}
          </div>
          {withBulb.length > VISIBLE_BEFORE_MORE && (
            <button type="button" onClick={() => setMore((m) => !m)} data-testid="observation-more"
              className="mt-2 text-xs text-accent underline min-h-[36px]">
              {more ? 'Fewer' : `More (${withBulb.length - VISIBLE_BEFORE_MORE})`}
            </button>
          )}
        </>
      )}

      {err && <p className="text-sm text-danger mt-2" data-testid="observation-error">{err}</p>}
      {justSaved && !chosen && <p className="text-sm text-ok mt-2" data-testid="observation-saved">Added: {justSaved}</p>}
    </section>
  );
}
