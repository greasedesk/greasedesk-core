/**
 * File: components/pwa/PhoneIntakeChecklist.tsx
 * THE FOUR PROMPTS, ON THE PHONE — because an escalation must not name items nobody was asked for.
 *
 * The checklist existed only on the desktop, where the mechanic is not standing. That is worse than
 * it sounds: the escalation reports "prompted and not done", so it would have emailed a manager
 * about a scan nobody was ever prompted to take. A false positive, and false positives are how the
 * whole escalation design dies — the same argument that made the "nothing found" affirmative
 * necessary, one level up.
 *
 * These two actions post directly rather than through the outbox: both are tiny, and a skip that
 * never arrived is a skip that simply did not happen — the item stays not-done, which is the safe
 * direction. A queued FINDING is a lost measurement; a queued skip is a lost non-event.
 */
import React, { useState } from 'react';

const LABEL: Record<string, string> = {
  findings: 'Check what the car needs',
  mileage_vin: 'Record mileage and VIN',
  walkaround: 'Walkaround video',
  diag_scan: 'Diagnostic scan',
};
const CHIPS = ['Equipment fault', 'Customer waiting'];

type Item = { item: string; prompted: boolean; done: boolean; skipped: boolean; skipReason: string | null };

export default function PhoneIntakeChecklist({ jobCardId, items, nothingFoundAt, onChanged }: {
  jobCardId: string; items: Item[]; nothingFoundAt: string | null; onChanged?: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [skipOpen, setSkipOpen] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const prompted = items.filter((i) => i.prompted);
  if (!prompted.length) return null;
  const outstanding = prompted.filter((i) => !i.done).length;

  async function post(body: Record<string, unknown>, key: string) {
    setBusy(key);
    try {
      await fetch('/api/intake-items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobCardId, ...body }) });
      onChanged?.();
    } finally { setBusy(null); setSkipOpen(null); setReason(''); }
  }

  return (
    <section className="bg-surface border border-line rounded-xl p-4" data-testid="phone-checklist">
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="text-sm font-semibold text-ink">Before the car goes in</h2>
        <span className={`text-xs ${outstanding === 0 ? 'text-ok' : 'text-muted'}`}>{prompted.length - outstanding} of {prompted.length}</span>
      </div>
      <ul className="space-y-2">
        {prompted.map((it) => (
          <li key={it.item} className="bg-surface-muted rounded-lg p-3" data-testid={`ph-item-${it.item}`}>
            <div className="flex items-center gap-2">
              <span aria-hidden className={`inline-flex items-center justify-center w-5 h-5 rounded-full text-xs shrink-0 ${it.done ? 'bg-ok text-white' : it.skipped ? 'bg-warn text-white' : 'bg-surface border border-line text-muted'}`}>
                {it.done ? '✓' : it.skipped ? '!' : '·'}
              </span>
              <span className={`text-sm ${it.done ? 'text-muted' : 'text-ink font-medium'}`}>{LABEL[it.item] ?? it.item}</span>
            </div>
            {it.skipped && <p className="text-xs text-warn mt-1">{it.skipReason ? `skipped — ${it.skipReason}` : 'skipped, no reason given'}</p>}

            {!it.done && skipOpen !== it.item && (
              <div className="flex flex-wrap gap-2 mt-2">
                {/* ONE TAP for the clean car — the affirmative that keeps the escalation believable. */}
                {it.item === 'findings' && (
                  <button type="button" disabled={busy !== null} onClick={() => post({ action: 'nothing_found' }, 'nf')}
                    data-testid="ph-nothing-found"
                    className="min-h-[44px] px-3 text-sm font-semibold bg-ok-soft text-ok rounded-lg">Nothing found</button>
                )}
                {!it.skipped && (
                  <button type="button" disabled={busy !== null} onClick={() => { setSkipOpen(it.item); setReason(''); }}
                    data-testid={`ph-skip-${it.item}`}
                    className="min-h-[44px] px-3 text-sm bg-surface border border-line text-muted rounded-lg">Skip</button>
                )}
              </div>
            )}
            {it.done && it.item === 'findings' && nothingFoundAt && (
              <button type="button" disabled={busy !== null} onClick={() => post({ action: 'undo_nothing_found' }, 'undo')}
                className="mt-1 text-xs text-muted underline">undo “nothing found”</button>
            )}

            {skipOpen === it.item && (
              <div className="mt-2 space-y-2">
                <div className="flex flex-wrap gap-1.5">
                  {CHIPS.map((c) => (
                    <button key={c} type="button" onClick={() => setReason(c)} data-testid={`ph-chip-${c.split(' ')[0].toLowerCase()}`}
                      className="min-h-[36px] text-xs rounded-full border border-line bg-surface px-3 text-ink">{c}</button>
                  ))}
                </div>
                <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="Optional — why?"
                  data-testid="ph-skip-reason" className="w-full min-h-[44px] p-2.5 text-sm bg-surface border border-line rounded-lg text-ink" />
                <div className="flex gap-2">
                  <button type="button" disabled={busy !== null} onClick={() => post({ action: 'skip', item: it.item, reason }, 'skip')}
                    data-testid="ph-skip-confirm" className="min-h-[44px] px-3 text-sm font-semibold bg-warn text-white rounded-lg">Skip this</button>
                  <button type="button" onClick={() => setSkipOpen(null)} className="min-h-[44px] px-3 text-sm bg-surface-muted text-ink rounded-lg">Cancel</button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted mt-3">Nothing here blocks the job. Anything left undone is emailed to the manager.</p>
    </section>
  );
}
