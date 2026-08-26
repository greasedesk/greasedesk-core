/**
 * File: components/pwa/PhoneIntakeChecklist.tsx
 * THE FOUR PROMPTS, ON THE PHONE — because an escalation must not name items nobody was asked for.
 *
 * The checklist existed only on the desktop, where the mechanic is not standing. That is worse than
 * it sounds: the escalation (lib/intake-escalation) reports "prompted and not done", so it emails a manager
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
  oil_level: 'Check oil level',
  findings: 'Check what the car needs',
  mileage_vin: 'Record mileage and VIN',
  walkaround: 'Walkaround video',
  diag_scan: 'Diagnostic scan',
};
const CHIPS = ['Equipment fault', 'Customer waiting'];
const OIL = [
  ['below_min', 'Below min'], ['at_min', 'At min'], ['between', 'Between'],
  ['at_max', 'At max'], ['above_max', 'Over max'],
] as const;

type Item = { item: string; prompted: boolean; done: boolean; skipped: boolean; skipReason: string | null };

export default function PhoneIntakeChecklist({ jobCardId, items, nothingFoundAt, oilLevel = null, onChanged }: {
  jobCardId: string; items: Item[]; nothingFoundAt: string | null;
  /** The reading already on this card, so the chips show which one is selected. */
  oilLevel?: string | null;
  onChanged?: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [skipOpen, setSkipOpen] = useState<string | null>(null);
  /** Items a mechanic has re-opened to correct. Never pre-populated: a done item stays done-looking. */
  const [reopen, setReopen] = useState<Record<string, boolean>>({});
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
            {/* WHAT WAS RECORDED, once it is. The chip row renders only while the item is NOT
                done, and recording a level marks it done — so the selected-chip highlight beside
                it could never appear, and the reading a mechanic had just taken became invisible
                the instant they took it. The tick said "something happened"; nothing said what. */}
            {it.item === 'oil_level' && it.done && oilLevel && !reopen[it.item] && (
              <p className="text-xs text-ok mt-1 flex items-center gap-2" data-testid="ph-oil-recorded">
                {OIL.find(([lv]) => lv === oilLevel)?.[1] ?? oilLevel}
                {/* ── THE WAY BACK IN, WHICH IS ALSO THE WAY TO CLOSE THE ADVISORY ─────────────
                    Recording a level marks the item done, and the chips render only while it is
                    NOT done — so after topping the oil up there was no way to say so, and the
                    "Oil level at the minimum mark" finding stayed open and printed on the invoice
                    for a visit where the garage had fixed it.
                    The mechanism was already there: /api/intake-items closes the open oil finding
                    with 'Re-checked and within range' and the card id the moment a healthy level
                    is recorded. It was simply unreachable. This is the door. */}
                <button type="button" onClick={() => setReopen((r) => ({ ...r, [it.item]: true }))}
                  data-testid="ph-oil-change" className="text-xs text-accent underline">Change</button>
              </p>
            )}

            {(!it.done || reopen[it.item]) && skipOpen !== it.item && (
              <div className="flex flex-wrap gap-2 mt-2">
                {/* ONE TAP for the clean car — the affirmative that keeps the escalation believable. */}
                {/* THE DIPSTICK, on the phone — the surface the mechanic is actually holding when
                    the bonnet is open. Always recorded; three of the five raise a finding. */}
                {it.item === 'oil_level' && (
                  <div className="flex flex-wrap gap-1.5 w-full" data-testid="ph-oil-chips">
                    {OIL.map(([lv, label]) => (
                      <button key={lv} type="button" disabled={busy !== null}
                        onClick={() => post({ action: 'oil_level', level: lv }, `oil-${lv}`)}
                        data-testid={`ph-oil-${lv}`}
                        className={`min-h-[44px] px-3 text-sm font-semibold rounded-lg border ${
                          oilLevel === lv ? 'bg-accent text-white border-accent' : 'bg-surface border-line text-ink'}`}>
                        {label}
                      </button>
                    ))}
                  </div>
                )}
                {it.item === 'findings' && (
                  <button type="button" disabled={busy !== null} onClick={() => post({ action: 'nothing_found' }, 'nf')}
                    data-testid="ph-nothing-found"
                    className="min-h-[44px] px-3 text-sm font-semibold bg-ok-soft text-ok rounded-lg">Nothing found</button>
                )}
                {/* A TICK, NOT AN UPLOAD — the scan runs on an external tool and its report is
                    emailed elsewhere. This is the surface it will actually be confirmed on: the
                    scanner is at the car, and so is the phone. */}
                {it.item === 'diag_scan' && (
                  <button type="button" disabled={busy !== null} onClick={() => post({ action: 'diag_scan' }, 'ds')}
                    data-testid="intake-diag-scan-done"
                    className="min-h-[44px] px-3 text-sm font-semibold bg-ok-soft text-ok rounded-lg">Scan run and sent</button>
                )}
                {!it.skipped && (
                  <button type="button" disabled={busy !== null} onClick={() => { setSkipOpen(it.item); setReason(''); }}
                    data-testid={`ph-skip-${it.item}`}
                    className="min-h-[44px] px-3 text-sm bg-surface border border-line text-muted rounded-lg">Skip</button>
                )}
              </div>
            )}
            {it.done && it.item === 'diag_scan' && (
              <button type="button" disabled={busy !== null} onClick={() => post({ action: 'undo_diag_scan' }, 'undo-ds')}
                data-testid="intake-undo-diag-scan"
                className="mt-1 text-xs text-muted underline">undo “scan run and sent”</button>
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
