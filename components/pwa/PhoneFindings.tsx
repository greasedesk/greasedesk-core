/**
 * File: components/pwa/PhoneFindings.tsx
 * WHAT THE CAR NEEDS — recorded at the car, on the phone, offline-safe.
 *
 * The three-state answer keeps its no-default rule here exactly as on the desktop: nothing is
 * pre-selected and Save stays disabled until someone chooses. A phone is where tapping through at
 * speed is most tempting, so this is the surface where a default would do the most damage — every
 * finding silently `not_raised` and the lead list quietly empty.
 *
 * Writes go through the OUTBOX with a capture-time id, so a dead-signal bay costs nothing and a
 * redelivery upserts rather than duplicating (pages/api/due-items).
 */
import React, { useState } from 'react';
import { enqueueDueItem } from '@/lib/pwa-outbox';

const BASES = [
  { k: 'next_service', l: 'Next service' }, { k: 'mileage', l: 'At a mileage' },
  { k: 'date', l: 'By a date' }, { k: 'whichever_first', l: 'Miles or date' },
] as const;
const ANSWERS = [
  { k: 'not_raised', l: 'Not raised yet' }, { k: 'declined', l: 'They declined' }, { k: 'agreed_later', l: 'Wants it later' },
] as const;

type Basis = typeof BASES[number]['k'];
type Answer = typeof ANSWERS[number]['k'];

export default function PhoneFindings({ jobCardId, existing, motExpiry, onQueued }: {
  jobCardId: string; existing: Array<{ id: string; description: string; timing?: string }>;
  motExpiry?: string | null; onQueued?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [desc, setDesc] = useState('');
  const [basis, setBasis] = useState<Basis | null>(null);      // NULL — see the header
  const [answer, setAnswer] = useState<Answer | null>(null);   // NULL — see the header
  const [mileage, setMileage] = useState('');
  const [date, setDate] = useState('');
  const [queued, setQueued] = useState<string[]>([]);

  const needsMileage = basis === 'mileage' || basis === 'whichever_first';
  const needsDate = basis === 'date' || basis === 'whichever_first';
  const ready = desc.trim() !== '' && basis !== null && answer !== null
    && (!needsMileage || mileage.trim() !== '') && (!needsDate || date !== '');

  async function save() {
    await enqueueDueItem({
      jobCardId, description: desc.trim(), dueBasis: basis as string, customerResponse: answer as string,
      ...(needsMileage ? { dueMileage: Number(mileage) } : {}),
      ...(needsDate ? { dueDate: date } : {}),
    });
    setQueued((q) => [...q, desc.trim()]);
    setDesc(''); setBasis(null); setAnswer(null); setMileage(''); setDate(''); setOpen(false);
    onQueued?.();
  }

  const chip = (on: boolean) => `min-h-[44px] text-sm font-semibold rounded-lg border px-3 ${on ? 'bg-accent text-white border-accent' : 'bg-surface border-line text-ink'}`;

  return (
    <section className="bg-surface border border-line rounded-xl p-4" data-testid="phone-findings">
      {/* "What this car needs" described the service-schedule panel equally well, which is why the
          two read as duplicates on a phone. Named for whose observation it is, and subtitled with
          where it ends up — the axis that actually separates them. */}
      <h2 className="text-sm font-semibold text-ink mb-1">What you found</h2>
      <p className="text-xs text-muted mb-2">Goes on the customer’s report and their invoice.</p>
      {/* THE MOT IS ALREADY KNOWN — shown so nobody retypes a DVSA fact into a finding. */}
      {motExpiry && <p className="text-xs text-muted mb-2" data-testid="phone-mot">MOT expires {motExpiry} — from DVSA, no need to record it</p>}

      {(existing.length > 0 || queued.length > 0) && (
        <ul className="space-y-1 mb-3" data-testid="phone-findings-list">
          {existing.map((e) => (
            <li key={e.id} className="text-sm text-ink">• {e.description}{e.timing ? <span className="text-xs text-muted"> {e.timing}</span> : null}</li>
          ))}
          {queued.map((q, i) => (
            <li key={`q${i}`} className="text-sm text-muted">• {q} <span className="text-xs">(saving…)</span></li>
          ))}
        </ul>
      )}
      {existing.length === 0 && queued.length === 0 && !open && <p className="text-sm text-muted mb-3">Nothing recorded yet.</p>}

      {!open ? (
        <button type="button" onClick={() => setOpen(true)} data-testid="phone-finding-add"
          className="w-full min-h-[48px] text-sm font-semibold bg-accent text-white rounded-lg">+ Record a finding</button>
      ) : (
        <div className="space-y-3">
          <input value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={500} placeholder="What does it need?"
            data-testid="phone-finding-desc" className="w-full min-h-[48px] p-3 bg-surface border border-line rounded-lg text-ink text-sm" />

          <div>
            <p className="text-xs text-muted mb-1">What makes it due?</p>
            <div className="flex flex-wrap gap-1.5">
              {BASES.map((b) => (
                <button key={b.k} type="button" onClick={() => setBasis(b.k)} data-testid={`phone-basis-${b.k}`} className={chip(basis === b.k)}>{b.l}</button>
              ))}
            </div>
            {needsMileage && (
              <input inputMode="numeric" value={mileage} onChange={(e) => setMileage(e.target.value.replace(/[^\d]/g, ''))}
                placeholder="e.g. 60000" data-testid="phone-finding-mileage"
                className="mt-2 w-full min-h-[48px] p-3 bg-surface border border-line rounded-lg text-ink text-sm" />
            )}
            {needsDate && (
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} data-testid="phone-finding-date"
                className="mt-2 w-full min-h-[48px] p-3 bg-surface border border-line rounded-lg text-ink text-sm" />
            )}
          </div>

          <div>
            <p className="text-xs text-muted mb-1">Has the customer been told?</p>
            <div className="flex flex-wrap gap-1.5">
              {ANSWERS.map((a) => (
                <button key={a.k} type="button" onClick={() => setAnswer(a.k)} data-testid={`phone-answer-${a.k}`} className={chip(answer === a.k)}>{a.l}</button>
              ))}
            </div>
          </div>

          <div className="flex gap-2">
            <button type="button" disabled={!ready} onClick={save} data-testid="phone-finding-save"
              className="flex-1 min-h-[48px] text-sm font-semibold bg-accent text-white rounded-lg disabled:opacity-50">Record it</button>
            <button type="button" onClick={() => setOpen(false)}
              className="min-h-[48px] px-4 text-sm bg-surface-muted text-ink rounded-lg">Cancel</button>
          </div>
        </div>
      )}
    </section>
  );
}
