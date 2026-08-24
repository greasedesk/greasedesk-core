/**
 * File: components/pwa/PhoneServiceSchedule.tsx
 * THE SERVICE COMPUTER, TRANSCRIBED IN THE BAY — the arrival reading, on the phone.
 *
 * The desktop card has had this since the arrival/departure split; the phone never did. Reading a
 * service computer is a bay job by definition — the screen is in the car — and the mechanic
 * standing at it was the one person who could not record what it said.
 *
 * ── THE ARRIVAL HALF ONLY, DELIBERATELY ─────────────────────────────────────────────────────────
 * There is no `stage` prop and no way to ask for one. The departure reading is what freezes onto
 * the invoice and drives next year's reminder, and this surface has nothing to guard it with: the
 * phone card is a flat scroll with no mileage-out, no tabs and no notion of where the card sits on
 * the spine. The desktop refuses the Completion stage until In-Job is done; here there is nothing
 * to refuse with, and importing that gating would mean a capture waiting on a reachability
 * computation that can be minutes stale in a dead-signal bay.
 *
 * If the phone ever gains a completion surface, mileage-out and the departure reading arrive
 * together as one deliberate thing, and that is the slice where this question gets answered.
 *
 * ── AND THE SAVE IS A DURABLE ENQUEUE, NOT A REQUEST ────────────────────────────────────────────
 * Same as every other capture here. The bay has no signal; the queue drains when it does.
 * Replay-safe with no id — ServiceScheduleReading is unique on (job_card_id, item_key).
 *
 * The rules are NOT restated: SCHEDULE_ITEMS, legsFor and the month handling all come from
 * lib/service-schedule, so a row offers exactly the legs its clock needs on both surfaces, and a
 * basis corrected in one place is corrected in both.
 */
import React, { useEffect, useRef, useState } from 'react';
import { SCHEDULE_ITEMS, legsFor, storedDateToMonth, type ScheduleKey } from '@/lib/service-schedule';

/**
 * WHAT THE BOX SHOWS. The countdown as recorded, or — for a row written before the countdown
 * column — the one implied by its stored target and the car's reading. Never blank when a target
 * exists: a blank row the form was seeded with is a CLEAR, and showing nothing here would delete
 * every historical reading on the next save. Same rule as the desktop panel, deliberately.
 */
const shownMiles = (r: { dueMileage: number | null; countdownMiles?: number | null } | undefined, countFrom?: number | null) => {
  if (r?.countdownMiles != null) return String(r.countdownMiles);
  if (r?.dueMileage != null && countFrom != null) return String(r.dueMileage - countFrom);
  return '';
};
import { enqueueSchedule } from '@/lib/pwa-outbox';

export type PhoneScheduleRow = { key: ScheduleKey; dueDate: string | null; dueMileage: number | null; countdownMiles?: number | null };

/** What the row records, said on the row — the same three words as the desktop. */
const BASIS_LABEL: Record<string, string> = {
  date: 'by that month',
  mileage: 'at that mileage',
  whichever_first: 'whichever comes first',
};

export default function PhoneServiceSchedule({ jobCardId, recorded = [], countFrom = null, motExpiry = null, onQueued }: {
  jobCardId: string;
  /** The car's mileage-in, which a countdown counts FROM. Null until somebody records it — the
   *  server then answers 409 (retryable in the outbox) rather than storing a raw number. Needed
   *  here too so a row written before the countdown column still shows its mileage leg: without it
   *  the box goes blank while the month stays, and a whichever_first row is refused as incomplete. */
  countFrom?: number | null;
  /** What this visit already recorded, so the form opens on it rather than blank. */
  recorded?: PhoneScheduleRow[];
  /** DVSA, read-only. NULL when we have no MOT date for this car. */
  motExpiry?: string | null;
  onQueued?: () => void;
}) {
  // SEEDED FROM WHAT IS RECORDED, for the same reason the tyre form is: a capture panel that opens
  // blank over stored values tells a mechanic their work was lost.
  const seed: Record<string, { month: string; miles: string }> = {};
  for (const s of SCHEDULE_ITEMS) {
    const r = recorded.find((x) => x.key === s.key);
    // Back to YYYY-MM: the stored 1st is an artefact of the column, not something to show.
    seed[s.key] = { month: storedDateToMonth(r?.dueDate) ?? '', miles: shownMiles(r, countFrom) };
  }
  const [rows, setRows] = useState(seed);
  const [queued, setQueued] = useState(false);
  // SAME STALE-FIRST-PAINT EXPOSURE AS PhoneTyres, and for the same reason: this surface paints
  // from IndexedDB before the network answers, so a useState initialiser can seed from a payload
  // that predates the field. Re-seeds on a genuinely different payload, never while dirty.
  const [dirty, setDirty] = useState(false);
  // As the desktop: what this form WAS HANDED, so a blank row can say which kind of blank it is.
  // It matters more here, not less — this screen is cache-first and can paint from a payload
  // stored before the car was even booked in.
  const [held, setHeld] = useState(() => new Set(recorded.map((r) => r.key)));
  const fingerprint = JSON.stringify(recorded);
  const seenRef = useRef(fingerprint);
  useEffect(() => {
    if (dirty || fingerprint === seenRef.current) return;
    seenRef.current = fingerprint;
    const fresh: Record<string, { month: string; miles: string }> = {};
    for (const it of SCHEDULE_ITEMS) {
      const r = recorded.find((x) => x.key === it.key);
      fresh[it.key] = { month: storedDateToMonth(r?.dueDate) ?? '', miles: shownMiles(r, countFrom) };
    }
    setRows(fresh);
    setHeld(new Set(recorded.map((r) => r.key)));
  }, [fingerprint, dirty, recorded]);

  const set = (k: string, patch: Partial<{ month: string; miles: string }>) => {
    setQueued(false); setDirty(true);
    setRows((r) => ({ ...r, [k]: { ...r[k], ...patch } }));
  };
  const filled = SCHEDULE_ITEMS.filter((s) => rows[s.key].month.trim() || rows[s.key].miles.trim()).length;

  async function save() {
    const entries = SCHEDULE_ITEMS.map((s) => ({
      key: s.key,
      dueMonth: rows[s.key].month.trim() || null,
      // MILES REMAINING, ALWAYS — the phone is at the car, reading the cluster. The server resolves
      // it against odometer-in; a card with no reading yet comes back 409, which is NOT terminal in
      // the outbox, so the capture waits for the mileage rather than being thrown away.
      dueMileage: null,
      countdownMiles: rows[s.key].miles.trim() ? Number(rows[s.key].miles.replace(/[^\d-]/g, '').replace(/(?!^)-/g, '')) : null,
      wasRecorded: held.has(s.key),
    }));
    await enqueueSchedule({ jobCardId, entries });
    // What the server WILL hold once this drains. There is no response to learn it from here, and
    // the next save may well be composed before the queue has moved — on a phone in a bay, quite
    // likely offline the whole time. Advancing it at enqueue is what makes a clear typed two
    // minutes later reach the writer as a clear.
    setHeld(new Set(entries.filter((x) => x.dueMonth != null || x.dueMileage != null || x.countdownMiles != null).map((x) => x.key)));
    setQueued(true);
    onQueued?.();
  }

  const field = 'min-h-[44px] px-2 bg-surface border border-line rounded-lg text-ink text-sm tabular-nums';

  return (
    <section className="bg-surface border border-line rounded-xl p-4" data-testid="phone-schedule">
      <div className="flex items-baseline justify-between gap-2 mb-1">
        <h2 className="text-sm font-semibold text-ink">Service schedule on arrival</h2>
        <span className="text-xs text-muted" data-testid="phone-schedule-progress">{filled} of {SCHEDULE_ITEMS.length}</span>
      </div>
      {/* SAID BY CONSEQUENCE, NOT BY PROVENANCE. This panel and "What you found" were the same
          shape — a thing plus a clock — and nothing on either screen said which was which. Where
          the information came from is the difference we designed in and the one thing the mechanic
          already knows; what they cannot see is what happens NEXT. So each panel now says that. */}
      <p className="text-xs text-muted mb-3">
        Off the car’s computer as it came in. Sets when it’s next due — the customer isn’t told about these.
      </p>

      {/* DVSA, READ-ONLY — shown so nobody retypes it as a row, which would print it twice on the
          invoice. The same treatment the desktop panel and the findings list give it. */}
      <p className="text-xs text-muted mb-3" data-testid="phone-schedule-mot">
        {motExpiry
          ? <>MOT expires <strong className="text-ink">{motExpiry}</strong> — from DVSA, already on the invoice</>
          : <>No MOT date from DVSA for this car</>}
      </p>

      <div className="space-y-3">
        {SCHEDULE_ITEMS.map((s) => {
          const row = rows[s.key];
          // ONLY THE LEGS THIS ITEM'S CLOCK NEEDS — legsFor, not a second copy of the rule.
          const legs = legsFor(s.basis);
          return (
            <div key={s.key} className="bg-surface-muted rounded-lg p-3" data-testid={`phone-schedule-row-${s.key}`}>
              <div className="flex items-baseline justify-between gap-2 mb-2">
                <span className="text-sm font-medium text-ink">{s.label}</span>
                <span className="text-[11px] text-muted" data-testid={`phone-schedule-basis-${s.key}`}>{BASIS_LABEL[s.basis]}</span>
              </div>
              {/* A FIXED TWO-COLUMN GRID, mileage always in the right-hand column. It was a
                  flex-wrap, so the mileage box sat on the RIGHT of an oil-service row (month
                  first) and on the LEFT of a pads row (no month at all) — the field moved
                  depending on which legs the item happened to have, which is the one thing a
                  column of numbers must not do. The desktop already solves this with placeholder
                  cells; this is the same fix, two columns instead of four. */}
              <div className="grid grid-cols-[1fr_7rem] gap-2">
                {legs.date ? (
                  <input type="month" value={row.month} onChange={(e) => set(s.key, { month: e.target.value })}
                    data-testid={`phone-schedule-month-${s.key}`} className={field} />
                ) : <span />}
                {legs.mileage ? (
                  <input inputMode="numeric" value={row.miles} placeholder="miles"
                    onChange={(e) => set(s.key, { miles: e.target.value.replace(/[^\d-]/g, '').replace(/(?!^)-/g, '').slice(0, 8) })}
                    data-testid={`phone-schedule-miles-${s.key}`} className={`${field} text-right`} />
                ) : <span />}
              </div>
            </div>
          );
        })}
      </div>

      {queued && <p className="text-sm text-ok mt-3" data-testid="phone-schedule-queued">Saved. It’ll sync when you have signal.</p>}
      <button type="button" disabled={filled === 0} onClick={save} data-testid="phone-schedule-save"
        className="mt-3 w-full min-h-[48px] text-sm font-semibold rounded-lg bg-accent text-white disabled:opacity-40">
        {filled === 0 ? 'Nothing to save' : `Save ${filled}`}
      </button>
    </section>
  );
}
