/**
 * File: components/pwa/PhoneObservations.tsx
 * SPOTTED IT, ON THE PHONE — the cheapest capture in the app, and the one that pays for itself.
 *
 * ── WHY THIS IS NOT THE DESKTOP COMPONENT ───────────────────────────────────────────────────────
 * The save is a durable ENQUEUE, because a bay has no signal. Replay-safe with no id: the partial
 * unique index on (group, vehicle, observation_key) WHERE closed_at IS NULL means a redelivered
 * envelope cannot give a garage two "wiper blades smearing" on one car.
 *
 * ── AND WHY THE ORDERING IS PART OF THE FEATURE ─────────────────────────────────────────────────
 * Seventeen chips at 390px is a visual search, and a visual search at a car is slower than typing
 * four words — which would make this worse than what it replaces. The list is ordered by this
 * garage's own history, so their six most common float to the top and the rest sit under More.
 *
 * Offline, the counts come from the cached payload; with none at all the catalogue's cold-start
 * order stands in. Degrading to "no ordering" is fine; degrading to "no list" would not be.
 */
import React, { useState } from 'react';
import { enqueueObservation } from '@/lib/pwa-outbox';
import { VISIBLE_BEFORE_MORE, BULB_GROUP_LABEL, bulbMembers, orderedTapList, isBulbTap, type Observation } from '@/lib/observations';

const ANSWERS = [
  { k: 'not_raised', l: 'Not raised yet' }, { k: 'declined', l: 'They declined' }, { k: 'agreed_later', l: 'Wants it later' },
] as const;

export default function PhoneObservations({ jobCardId, counts = {}, openKeys = [], onQueued }: {
  jobCardId: string;
  counts?: Record<string, number>;
  openKeys?: string[];
  onQueued?: () => void;
}) {
  const [chosen, setChosen] = useState<Observation | null>(null);
  const [bulbOpen, setBulbOpen] = useState(false);
  const [more, setMore] = useState(false);
  const [queued, setQueued] = useState<string[]>([]);

  const done = new Set([...openKeys, ...queued]);
  // ONE ordering rule, in lib/observations — see the note on the desktop surface.
  const withBulb = orderedTapList(counts);
  const visible = more ? withBulb : withBulb.slice(0, VISIBLE_BEFORE_MORE);

  async function save(obs: Observation, customerResponse: string) {
    await enqueueObservation({ jobCardId, observationKey: obs.key, customerResponse });
    setQueued((q) => [...q, obs.key]);
    setChosen(null); setBulbOpen(false);
    onQueued?.();
  }

  // 44px minimum: a gloved thumb, not a mouse.
  const chip = 'min-h-[44px] px-3 text-sm font-medium rounded-lg border bg-surface border-line text-ink';

  return (
    <section className="bg-surface border border-line rounded-xl p-4" data-testid="phone-observations">
      <h2 className="text-sm font-semibold text-ink mb-1">Spotted it</h2>
      <p className="text-xs text-muted mb-3">Tap what you noticed.</p>

      {/* The required answer, shown on its own so it cannot be tapped past. */}
      {chosen ? (
        <div data-testid="phone-observation-answer">
          <p className="text-sm font-medium text-ink mb-2">{chosen.description}</p>
          <p className="text-xs text-muted mb-2">Raised with the customer?</p>
          <div className="flex flex-wrap gap-2">
            {ANSWERS.map((a) => (
              <button key={a.k} type="button" onClick={() => save(chosen, a.k)}
                data-testid={`phone-observation-answer-${a.k}`} className={`${chip} min-h-[48px]`}>{a.l}</button>
            ))}
          </div>
          <button type="button" onClick={() => setChosen(null)} className="mt-2 text-xs text-muted underline min-h-[36px]">Back</button>
        </div>
      ) : bulbOpen ? (
        <div data-testid="phone-observation-bulbs">
          <p className="text-sm font-medium text-ink mb-2">Which one?</p>
          <div className="grid grid-cols-2 gap-2">
            {bulbMembers().map((o) => (
              <button key={o.key} type="button" disabled={done.has(o.key)} onClick={() => setChosen(o)}
                data-testid={`phone-observation-${o.key}`} className={`${chip} disabled:opacity-40`}>{o.label}</button>
            ))}
          </div>
          <button type="button" onClick={() => setBulbOpen(false)} className="mt-2 text-xs text-muted underline min-h-[36px]">Back</button>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {visible.map((o) => isBulbTap(o) ? (
              <button key="bulb" type="button" onClick={() => setBulbOpen(true)}
                data-testid="phone-observation-bulb-group" className={chip}>{BULB_GROUP_LABEL}</button>
            ) : (
              <button key={o.key} type="button" disabled={done.has(o.key)} onClick={() => setChosen(o)}
                data-testid={`phone-observation-${o.key}`} className={`${chip} disabled:opacity-40`}>
                {o.label}{done.has(o.key) ? ' ✓' : ''}
              </button>
            ))}
          </div>
          {withBulb.length > VISIBLE_BEFORE_MORE && (
            <button type="button" onClick={() => setMore((m) => !m)} data-testid="phone-observation-more"
              className="mt-2 text-xs text-accent underline min-h-[36px]">
              {more ? 'Fewer' : `More (${withBulb.length - VISIBLE_BEFORE_MORE})`}
            </button>
          )}
        </>
      )}

      {queued.length > 0 && !chosen && (
        <p className="text-sm text-ok mt-3" data-testid="phone-observations-queued">
          {queued.length} added. {queued.length === 1 ? 'It’ll' : 'They’ll'} sync when you have signal.
        </p>
      )}
    </section>
  );
}
