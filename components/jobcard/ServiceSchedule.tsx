/**
 * File: components/jobcard/ServiceSchedule.tsx
 * THE SERVICE COMPUTER, TRANSCRIBED — a named form, not free text.
 *
 * The fourth capture shape. Observations are noticed, tyres and battery are measured, and these are
 * READ OFF A SCREEN and typed in, each with a date, a mileage, or both, exactly as the garage's own
 * proforma recorded them.
 *
 * ── NAMED ROWS, NOT A NOTES BOX ─────────────────────────────────────────────────────────────────
 * These are the specific items that feed next year's reminders. A notes box captures the words and
 * loses the clock, and a reminder cannot be built from a sentence — which is the whole reason this
 * is a form at all rather than one more free-text finding.
 *
 * ── EACH ROW SHOWS ITS OWN CLOCK, AND NOTHING IS INFERRED ───────────────────────────────────────
 * The basis is DECLARED per item in lib/service-schedule, so a row offers only the fields its clock
 * needs: pads take a mileage, brake fluid and the vehicle check take a month, an oil service takes
 * both. Offering two fields on every row showed what the model permits rather than what the item
 * is, invited a wrong answer, and left the form guessing at the basis afterwards.
 *
 * ── AND A DATE LEG IS A MONTH, NOT A DAY ────────────────────────────────────────────────────────
 * A service computer says "11/2025". A dd/mm/yyyy picker forces a day nobody has, and that day then
 * prints on a frozen invoice as though somebody chose it. `type="month"` asks for what is known.
 *
 * ── THE MOT IS SHOWN AND NOT EDITABLE ───────────────────────────────────────────────────────────
 * It comes from DVSA and already prints as the first line of every invoice advisory block. A row
 * here would print it twice. So it is confirmation that we have it, and it stores nothing.
 */
import React, { useEffect, useRef, useState } from 'react';
import { SCHEDULE_ITEMS, legsFor, storedDateToMonth, type ScheduleKey } from '@/lib/service-schedule';

export type ScheduleRow = { key: ScheduleKey; dueDate: string | null; dueMileage: number | null; countdownMiles?: number | null };

type Props = {
  jobCardId: string;
  canEdit: boolean;
  /**
   * WHICH READING THIS IS. `arrival` on Intake writes a visit measurement; `departure` on
   * Completion writes what the car needs next, and is the only one the invoice ever reads.
   */
  stage: 'arrival' | 'departure';
  /** What is already recorded for this car, so the form opens on the current schedule. */
  recorded?: ScheduleRow[];
  /** On Completion only: what the computer said when the car came in, shown beside each row so the
   *  after reading is a comparison rather than a blank form. */
  onArrival?: ScheduleRow[];
  /**
   * THE READING A COUNTDOWN COUNTS FROM — mileage IN on arrival, mileage OUT on departure. NULL
   * when it has not been taken yet, which is ordinary: this panel and the odometer box sit on the
   * same tab in no fixed order, and mileage-out is deliberately empty by default.
   */
  countFrom?: number | null;
  /** DVSA, read-only. NULL when we have no MOT date for this car. */
  motExpiry?: string | null;
  onSaved: () => void;
};

/** What the row records, said on the row. Fixed by the item, so it never changes as you type. */
const BASIS_LABEL: Record<string, string> = {
  date: 'by that month',
  mileage: 'at that mileage',
  whichever_first: 'whichever comes first',
};

export default function ServiceSchedule({ jobCardId, canEdit, stage, recorded = [], onArrival = [], countFrom = null, motExpiry = null, onSaved }: Props) {
  // ── WHAT THE SCREEN SHOWS, NOT WHAT THE MODEL STORES ─────────────────────────────────────────
  // A MINI cluster shows distance REMAINING — "1,240 mi", or "-240 mi" with "Service overdue" —
  // and never the odometer the service falls due at. Other computers show the target. The panel
  // asks which, once, because a given car's screen uses one convention for all of its items; and
  // a bare "240" is otherwise ambiguous between "due at 240" and "240 to go".
  /**
   * MILES REMAINING, AND THERE IS NO OTHER OPTION. The toggle is gone: a service computer shows
   * distance remaining, and offering a second convention is what let 54 rows across the live tenant
   * store an interval as though it were a target — "due at 14,000 miles" on a car reading 117,735.
   *
   * A ROW THAT PREDATES THE COUNTDOWN COLUMN STILL HAS TO SHOW SOMETHING, and blank is the one
   * thing it must not show: a blank row the form was seeded with is a CLEAR, so displaying nothing
   * here would delete every historical reading on the next save. That is the exact failure that
   * destroyed five readings on D13DSK. So the countdown is DERIVED from the stored target and the
   * current reading, which round-trips exactly — countFrom + (due − countFrom) is due — and shows
   * the honest figure, however absurd: a target of 14,000 on a car at 115,964 reads as −101,964,
   * which is what the stored data actually says.
   */
  const shownFor = (r: ScheduleRow | undefined) => {
    if (r?.countdownMiles != null) return String(r.countdownMiles);
    if (r?.dueMileage != null && countFrom != null) return String(r.dueMileage - countFrom);
    return '';
  };
  const seedFrom = (rs: ScheduleRow[]) => {
    const out: Record<string, { month: string; miles: string }> = {};
    for (const s of SCHEDULE_ITEMS) {
      const r = rs.find((x) => x.key === s.key);
      // Back to YYYY-MM: the stored 1st is an artefact of the column, not something to show.
      out[s.key] = { month: storedDateToMonth(r?.dueDate) ?? '', miles: shownFor(r) };
    }
    return out;
  };
  /** The target a row arrived with, kept so a row we cannot express as a countdown — no reading to
   *  count from — is sent back UNCHANGED rather than as a blank the writer would read as a clear. */
  const seededDue: Record<string, number | null> = {};
  for (const s of SCHEDULE_ITEMS) seededDue[s.key] = recorded.find((x) => x.key === s.key)?.dueMileage ?? null;
  const [rows, setRows] = useState(() => seedFrom(recorded));
  const [dirty, setDirty] = useState(false);
  // WHAT THE FORM WAS HANDED, kept beside what it now holds. The save reports this per row so the
  // writer can tell "I emptied it" from "I never had it" — see classifyEntry. Derived from the
  // seed and re-derived with it, NEVER from the inputs: the inputs are what the question is about.
  const [held, setHeld] = useState(() => new Set(recorded.map((r) => r.key)));
  // ── SEEDED ONCE IS NOT SEEDED ────────────────────────────────────────────────────────────────
  // A tab switch UNMOUNTS this pane, so `useState(seed)` runs again on the way back — against
  // whatever the parent is holding. When the parent held the page-load value, the form came back
  // EMPTY after a successful save, and saving an empty schedule form DELETES: five readings on a
  // real card went that way (TMBS D13DSK, 21 Aug). Two halves, both required — the parent
  // reconciles the prop through /api/jobcard-pane, and this re-seeds when it changes.
  // `dirty` is the whole safety of it: never overwrite something half-typed.
  const fingerprint = JSON.stringify(recorded.map((r) => [r.key, r.dueDate, r.dueMileage, r.countdownMiles ?? null]));
  const seenRef = useRef(fingerprint);
  useEffect(() => {
    if (dirty || fingerprint === seenRef.current) return;
    seenRef.current = fingerprint;
    setRows(seedFrom(recorded));
    setHeld(new Set(recorded.map((r) => r.key)));
  }, [fingerprint, dirty, recorded]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  /** '' → null, '-' → null (mid-typing), otherwise the number. A lone minus is not a reading. */
  const numeric = (v: string): number | null => {
    const t = v.trim();
    if (t === '' || t === '-') return null;
    const n = Number(t);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  };
  const countdownUsable = countFrom != null;
  const noReadingYet = stage === 'arrival'
    ? 'Record the mileage in first — a countdown needs a reading to count from.'
    : 'Record the mileage out first — a countdown needs a reading to count from.';

  const set = (k: string, patch: Partial<{ month: string; miles: string }>) => {
    setDirty(true);
    setRows((r) => ({ ...r, [k]: { ...r[k], ...patch } }));
  };

  async function save() {
    setBusy(true); setErr(null); setSaved(null);
    try {
      const entries = SCHEDULE_ITEMS.map((s) => ({
        key: s.key,
        dueMonth: rows[s.key].month.trim() || null,
        // ALWAYS A COUNTDOWN — the server derives the target, so the stored pair is arithmetic and
        // cannot disagree. The one exception is a card with no reading to count from: there the
        // mileage box is disabled, and the row goes back with the target it ARRIVED with so a save
        // of the date leg cannot silently blank a mileage nobody touched.
        // WITH NO READING TO COUNT FROM, two different rows go two different ways. One the user
        // TYPED into is sent as a countdown and the server refuses it — 409, "record the mileage
        // first", which is a next step rather than a rejection and is retryable in the outbox.
        // One they did not touch goes back with the target it ARRIVED with, so saving the date leg
        // on a card with no mileage-out cannot silently blank a reading nobody was asked about.
        dueMileage: countdownUsable || numeric(rows[s.key].miles) != null ? null : seededDue[s.key],
        countdownMiles: numeric(rows[s.key].miles),
        wasRecorded: held.has(s.key),
      }));
      const r = await fetch('/api/service-schedule', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobCardId, stage, entries }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(j?.message ?? 'The schedule didn’t save.'); return; }
      // WHAT THE SERVER NOW HOLDS, said by the server having just written it. Without this, `held`
      // stays at the last seed until refreshCard lands — and refreshCard fails QUIETLY by design,
      // so a user who saved rows and then emptied one would have the clear silently skipped. The
      // whole rule turns on this set being right at the moment of the NEXT save.
      setHeld(new Set(entries.filter((x) => x.dueMonth != null || x.dueMileage != null || x.countdownMiles != null).map((x) => x.key)));
      const parts = [`${j.written} recorded`];
      if (j.cleared) parts.push(`${j.cleared} cleared`);
      // Never silent. A skip is the writer declining to delete something it was not told about,
      // and a person who meant to clear a row needs to see that it did not happen.
      if (j.skipped) parts.push(`${j.skipped} left alone (blank, and not loaded from a saved reading)`);
      setSaved(`Saved — ${parts.join(', ')}.`);
      // What was typed is now what is stored, so this is no longer half-typed work to protect.
      // Without this the guard would latch on for the life of the mount and the reconciled prop
      // could never land — the fix would hold for one save and then behave exactly as before.
      setDirty(false);
      onSaved();
    } catch { setErr('The schedule didn’t save.'); }
    finally { setBusy(false); }
  }

  const field = 'min-h-[40px] px-2 bg-surface border border-line rounded-lg text-ink text-sm tabular-nums';

  return (
    <div className="bg-surface border border-line rounded-xl p-5" data-testid="service-schedule">
      <h3 className="text-sm font-semibold text-ink mb-1">
        {stage === 'arrival' ? 'Service schedule on arrival' : 'Service schedule — what’s next'}
      </h3>
      <p className="text-xs text-muted mb-3">
        {stage === 'arrival'
          ? 'Off the service computer as the car came in — what was already due. Leave a row blank if it isn’t scheduled.'
          : 'Off the service computer after the work. This is what goes on the invoice and drives next year’s reminder.'}
      </p>

      {/* DVSA, READ-ONLY. Shown so nobody retypes it as a row, which would print it on the invoice
          twice — the same treatment the findings panel gives it. */}
      <p className="text-xs text-muted mb-3" data-testid="schedule-mot">
        {motExpiry
          ? <>MOT expires <strong className="text-ink">{motExpiry}</strong> — from DVSA, already on the invoice</>
          : <>No MOT date from DVSA for this car</>}
      </p>

      {/* ── WHICH WAY THE SCREEN COUNTS ─────────────────────────────────────────────────────────
          One control for the panel, not one per row: a given car's cluster uses one convention for
          everything on it. Defaults to `target` so nothing changes for a garage whose computer
          shows targets — and to `countdown` when the row was SAVED as one, so it reopens the way
          it was entered. */}
      {/* ── WHAT THE BOX MEANS, STATED ONCE ────────────────────────────────────────────────────
          There used to be a toggle here — "a due mileage" or "miles remaining" — because some
          service computers show a target. It is gone: two conventions on one form is how 54 rows
          on the live tenant came to hold an interval as a target, and nothing on the row said
          which had been meant. One convention, said out loud, and the arithmetic shown per row. */}
      <div className="flex items-center gap-2 mb-3 flex-wrap" data-testid="schedule-units-note">
        <span className="text-xs text-muted">Miles remaining, as the computer shows them</span>
        {countdownUsable ? (
          <span className="text-xs text-muted" data-testid="schedule-count-from">
            counting from <strong className="text-ink tabular-nums">{countFrom!.toLocaleString('en-GB')}</strong>
          </span>
        ) : (
          // A NEXT STEP, NOT A REJECTION. The empty mileage-out box is the ordinary state of a card
          // mid-job, so this reads as the thing to do rather than as something gone wrong.
          <span className="text-xs text-muted" data-testid="schedule-no-reading">{noReadingYet}</span>
        )}
      </div>

      <div className="space-y-2">
        {SCHEDULE_ITEMS.map((s) => {
          const row = rows[s.key];
          // ONLY THE LEGS THIS ITEM'S CLOCK NEEDS. A pad row has no month field to fill in wrongly.
          const legs = legsFor(s.basis);
          return (
            <div key={s.key} className="grid grid-cols-1 sm:grid-cols-[1fr_auto_auto_auto] gap-2 items-center"
              data-testid={`schedule-row-${s.key}`}>
              <span className="text-sm text-ink">{s.label}</span>
              {legs.date ? (
                <input type="month" value={row.month} disabled={!canEdit}
                  onChange={(e) => set(s.key, { month: e.target.value })}
                  data-testid={`schedule-month-${s.key}`} className={field} />
              ) : <span />}
              {legs.mileage ? (
                <input inputMode="text" value={row.miles} disabled={!canEdit}
                  placeholder="miles remaining"
                  // A LEADING MINUS IS DATA HERE. It used to be stripped, so a mechanic copying
                  // "-240" off the cluster got 240 — a service due at 240 miles, silently. The
                  // minus is only meaningful against a countdown, so a target still cannot take one.
                  onChange={(e) => set(s.key, {
                    miles: e.target.value.replace(/[^\d-]/g, '').replace(/(?!^)-/g, '').slice(0, 8),
                  })}
                  data-testid={`schedule-miles-${s.key}`} className={`${field} w-28`} />
              ) : <span />}
              {/* DECLARED by the item, so it reads the same before and after anything is typed.
                  On Completion it also carries what the car arrived with, so the mechanic is
                  correcting a number rather than recalling one. */}
              <span className="text-xs text-muted min-w-[9rem]" data-testid={`schedule-basis-${s.key}`}>
                {BASIS_LABEL[s.basis]}
                {/* THE ARITHMETIC, SHOWN. A wrong odometer is otherwise invisible until a customer
                    is reminded at a mileage the car passed months ago; here it is one glance.
                    Advisory only — the SERVER does the conversion that gets stored. */}
                {legs.mileage && countFrom != null && (() => {
                  const n = numeric(row.miles);
                  if (n == null) return null;
                  const target = countFrom + n;
                  return (
                    <em className="not-italic block text-[11px] opacity-70" data-testid={`schedule-working-${s.key}`}>
                      {n > 0 ? `+${n.toLocaleString('en-GB')}` : n.toLocaleString('en-GB')} → {target < 0
                        ? 'before the car had any mileage — check the figures'
                        : <>due at <strong className="text-ink tabular-nums">{target.toLocaleString('en-GB')}</strong>{n < 0 ? ' — already overdue' : ''}</>}
                    </em>
                  );
                })()}
                {stage === 'departure' && (() => {
                  const a = onArrival.find((x) => x.key === s.key);
                  if (!a) return null;
                  const bits = [a.dueMileage != null ? `${a.dueMileage.toLocaleString('en-GB')} mi` : null,
                                storedDateToMonth(a.dueDate)].filter(Boolean);
                  return <em className="not-italic block text-[11px] opacity-70" data-testid={`schedule-arrival-${s.key}`}>on arrival: {bits.join(' · ')}</em>;
                })()}
              </span>
            </div>
          );
        })}
      </div>

      <p className="text-xs text-muted mt-3">
        {stage === 'arrival'
          ? 'This is kept with the visit, not printed. Anything else — auto transmission fluid, diesel additive — goes in as a finding below.'
          : 'Anything else — auto transmission fluid, diesel additive — goes in as a finding.'}
      </p>

      {err && <p className="text-sm text-danger mt-2" data-testid="schedule-error">{err}</p>}
      {saved && <p className="text-sm text-ok mt-2" data-testid="schedule-saved">{saved}</p>}

      <button type="button" disabled={!canEdit || busy} onClick={save} data-testid="schedule-save"
        className="mt-3 min-h-[40px] px-4 text-sm font-semibold bg-accent text-white rounded-lg disabled:opacity-50">
        {busy ? 'Saving…' : 'Save schedule'}
      </button>
    </div>
  );
}
