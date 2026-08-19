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
import React, { useState } from 'react';
import { SCHEDULE_ITEMS, legsFor, storedDateToMonth, type ScheduleKey } from '@/lib/service-schedule';

export type ScheduleRow = { key: ScheduleKey; dueDate: string | null; dueMileage: number | null };

type Props = {
  jobCardId: string;
  canEdit: boolean;
  /** What is already recorded for this car, so the form opens on the current schedule. */
  recorded?: ScheduleRow[];
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

export default function ServiceSchedule({ jobCardId, canEdit, recorded = [], motExpiry = null, onSaved }: Props) {
  const seed: Record<string, { month: string; miles: string }> = {};
  for (const s of SCHEDULE_ITEMS) {
    const r = recorded.find((x) => x.key === s.key);
    // Back to YYYY-MM: the stored 1st is an artefact of the column, not something to show.
    seed[s.key] = { month: storedDateToMonth(r?.dueDate) ?? '', miles: r?.dueMileage != null ? String(r.dueMileage) : '' };
  }
  const [rows, setRows] = useState(seed);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const set = (k: string, patch: Partial<{ month: string; miles: string }>) =>
    setRows((r) => ({ ...r, [k]: { ...r[k], ...patch } }));

  async function save() {
    setBusy(true); setErr(null); setSaved(null);
    try {
      const entries = SCHEDULE_ITEMS.map((s) => ({
        key: s.key,
        dueMonth: rows[s.key].month.trim() || null,
        dueMileage: rows[s.key].miles.trim() ? Number(rows[s.key].miles.replace(/[^\d]/g, '')) : null,
      }));
      const r = await fetch('/api/service-schedule', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobCardId, entries }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(j?.message ?? 'The schedule didn’t save.'); return; }
      setSaved(j.cleared ? `Saved — ${j.written} recorded, ${j.cleared} cleared.` : `Saved — ${j.written} recorded.`);
      onSaved();
    } catch { setErr('The schedule didn’t save.'); }
    finally { setBusy(false); }
  }

  const field = 'min-h-[40px] px-2 bg-surface border border-line rounded-lg text-ink text-sm tabular-nums';

  return (
    <div className="bg-surface border border-line rounded-xl p-5" data-testid="service-schedule">
      <h3 className="text-sm font-semibold text-ink mb-1">Service schedule</h3>
      <p className="text-xs text-muted mb-3">
        Off the service computer. Each row asks for what that item is actually scheduled by — leave a
        row blank if it isn’t scheduled.
      </p>

      {/* DVSA, READ-ONLY. Shown so nobody retypes it as a row, which would print it on the invoice
          twice — the same treatment the findings panel gives it. */}
      <p className="text-xs text-muted mb-3" data-testid="schedule-mot">
        {motExpiry
          ? <>MOT expires <strong className="text-ink">{motExpiry}</strong> — from DVSA, already on the invoice</>
          : <>No MOT date from DVSA for this car</>}
      </p>

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
                <input inputMode="numeric" value={row.miles} disabled={!canEdit} placeholder="miles"
                  onChange={(e) => set(s.key, { miles: e.target.value.replace(/[^\d]/g, '').slice(0, 7) })}
                  data-testid={`schedule-miles-${s.key}`} className={`${field} w-24`} />
              ) : <span />}
              {/* DECLARED by the item, so it reads the same before and after anything is typed. */}
              <span className="text-xs text-muted min-w-[9rem]" data-testid={`schedule-basis-${s.key}`}>
                {BASIS_LABEL[s.basis]}
              </span>
            </div>
          );
        })}
      </div>

      <p className="text-xs text-muted mt-3">
        Anything else — auto transmission fluid, diesel additive — goes in as a finding below.
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
