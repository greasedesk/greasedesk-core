/**
 * File: components/jobcard/IntakeChecklist.tsx
 * THE FOUR INTAKE PROMPTS on the Intake tab — asked, never enforced.
 *
 * Every control here lets the mechanic proceed. There is no disabled Next button, no blocked
 * stage: the only consequence of leaving something undone is that the escalation names it
 * (lib/intake-escalation). A hard
 * gate would be worked around within a week and the data would look captured when it wasn't.
 *
 * States come from the SERVER already resolved (lib/intake-items) — prompted, done, skipped — so
 * the screen cannot disagree with what the escalation will report.
 */
import React, { useState } from 'react';
import { useTranslation } from 'next-i18next';
import { OIL_LEVELS } from '@/lib/oil-level';
import type { IntakeItem } from '@/lib/intake-items';

export type IntakeItemView = {
  /** DERIVED from lib/intake-items, not restated. The four names used to be written out here, so
   *  adding a fifth item compiled everywhere except the one comparison that needed it — the union
   *  had quietly become a second source of truth. */
  item: IntakeItem;
  prompted: boolean; done: boolean; skipped: boolean; skipReason: string | null;
};

type Props = {
  jobCardId: string;
  items: IntakeItemView[];
  canEdit: boolean;
  nothingFoundAt: string | null;
  /** The reading already on this card, so the chips show which one is selected. NULL = not checked. */
  oilLevel?: string | null;
  /** Jump to the Quote tab, where findings are recorded. */
  onGoToFindings: () => void;
  onChanged: () => void;
};

const CHIPS = ['equipment_fault', 'customer_waiting'] as const;

export default function IntakeChecklist({ jobCardId, items, canEdit, nothingFoundAt, oilLevel = null, onGoToFindings, onChanged }: Props) {
  const { t } = useTranslation('jobcard');
  const [busy, setBusy] = useState<string | null>(null);
  const [skipOpen, setSkipOpen] = useState<string | null>(null);
  /** Items re-opened to correct. See the oil row: re-recording is what closes the advisory. */
  const [reopen, setReopen] = useState<Record<string, boolean>>({});
  const [reason, setReason] = useState('');

  const prompted = items.filter((i) => i.prompted);
  if (prompted.length === 0) return null; // nothing switched on for this site → no panel at all

  async function post(body: Record<string, unknown>, key: string) {
    setBusy(key);
    try {
      await fetch('/api/intake-items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobCardId, ...body }) });
      onChanged();
    } finally { setBusy(null); setSkipOpen(null); setReason(''); }
  }

  const outstanding = prompted.filter((i) => !i.done).length;

  return (
    <div className="bg-surface border border-line rounded-xl p-5" data-testid="intake-checklist">
      <div className="flex items-baseline justify-between gap-2 mb-3">
        <h3 className="text-sm font-semibold text-ink">{t('intake.title')}</h3>
        <span className={`text-xs font-medium ${outstanding === 0 ? 'text-ok' : 'text-muted'}`}>
          {t('intake.progress', { done: prompted.length - outstanding, total: prompted.length })}
        </span>
      </div>

      <ul className="space-y-2">
        {prompted.map((it) => (
          <li key={it.item} className="flex flex-wrap items-center gap-2 bg-surface-muted rounded-lg px-3 py-2"
            data-testid={`intake-item-${it.item}`}>
            <span aria-hidden className={`inline-flex items-center justify-center w-5 h-5 rounded-full text-xs shrink-0 ${it.done ? 'bg-ok text-white' : it.skipped ? 'bg-warn text-white' : 'bg-surface border border-line text-muted'}`}>
              {it.done ? '✓' : it.skipped ? '!' : '·'}
            </span>
            <span className={`text-sm ${it.done ? 'text-muted' : 'text-ink font-medium'}`}>{t(`intake.item.${it.item}`)}</span>

            {/* A SKIP IS SPENT once the thing is done — the server derives `skipped` against `done`,
                so this row simply stops showing it. */}
            {it.skipped && (
              <span className="text-xs text-warn" data-testid={`intake-skipped-${it.item}`}>
                {it.skipReason ? t('intake.skippedWithReason', { reason: it.skipReason }) : t('intake.skippedNoReason')}
              </span>
            )}

            {/* THE READING, AFTER IT IS TAKEN. The chip row renders only while the item is NOT
                done, and recording a level marks it done — so `oilLevel === lv` could never
                highlight anything, and the reading a mechanic had just taken became invisible the
                instant they took it. The tick said "something happened"; nothing said what. */}
            {it.item === 'oil_level' && it.done && oilLevel && !reopen[it.item] && (
              <>
                <span className="text-xs text-ok" data-testid="oil-level-recorded">{t(`intake.oilLevel.${oilLevel}`)}</span>
                {/* THE WAY BACK IN — and the only route to the closure that already exists. Topping
                    the oil up and re-recording a healthy level is what closes the advisory
                    (/api/intake-items), and until now nothing could reach it. */}
                {canEdit && (
                  <button type="button" onClick={() => setReopen((r) => ({ ...r, [it.item]: true }))}
                    data-testid="oil-level-change" className="text-xs text-accent underline">{t('action.change')}</button>
                )}
              </>
            )}

            {canEdit && (!it.done || reopen[it.item]) && skipOpen !== it.item && (
              <span className="ml-auto flex flex-wrap gap-2">
                {/* ONE TAP, and the most important control here: a clean car must be able to satisfy
                    the findings prompt without a skip, or every properly-checked clean car becomes
                    a false escalation and the admin stops reading. */}
                {/* THE DIPSTICK. Five readings, always recorded — "between" satisfies the item
                    exactly as "below min" does, because the item is "did you check", not "was
                    there a problem". Three of the five raise a finding; over-max is the one a
                    yes/no question cannot see. */}
                {it.item === 'oil_level' && (
                  <div className="flex flex-wrap gap-1.5 w-full" data-testid="oil-level-chips">
                    {OIL_LEVELS.map((lv) => (
                      <button key={lv} type="button" disabled={busy !== null}
                        onClick={() => post({ action: 'oil_level', level: lv }, `oil-${lv}`)}
                        data-testid={`oil-level-${lv}`}
                        className={`min-h-[44px] px-3 text-sm font-medium rounded-lg border ${
                          oilLevel === lv ? 'bg-accent text-white border-accent' : 'bg-surface border-line text-ink'}`}>
                        {t(`intake.oilLevel.${lv}`)}
                      </button>
                    ))}
                  </div>
                )}
                {it.item === 'findings' && (
                  <>
                    <button type="button" disabled={busy !== null} onClick={() => post({ action: 'nothing_found' }, 'nf')}
                      data-testid="intake-nothing-found"
                      className="text-sm font-semibold bg-ok-soft text-ok rounded-lg px-3 py-2 disabled:opacity-50">
                      {t('intake.nothingFound')}
                    </button>
                    <button type="button" onClick={onGoToFindings} data-testid="intake-record-finding"
                      className="text-sm font-semibold bg-accent hover:bg-accent-hover text-white rounded-lg px-3 py-2">
                      {t('intake.recordFinding')}
                    </button>
                  </>
                )}
                {/* A TICK, NOT AN UPLOAD. The scan runs on an external tool and its report is
                    emailed elsewhere; asking for a photo of a screen was what made this item
                    impossible to complete. Beside Skip, so the two honest answers sit together. */}
                {it.item === 'diag_scan' && !it.done && (
                  <button type="button" disabled={busy !== null} onClick={() => post({ action: 'diag_scan' }, 'ds')}
                    data-testid="intake-diag-scan-done"
                    className="text-sm font-semibold bg-ok-soft text-ok rounded-lg px-3 py-2 disabled:opacity-50">
                    {t('intake.diagScanDone')}
                  </button>
                )}
                {!it.skipped && (
                  <button type="button" disabled={busy !== null} onClick={() => { setSkipOpen(it.item); setReason(''); }}
                    data-testid={`intake-skip-${it.item}`}
                    className="text-sm bg-surface border border-line text-muted rounded-lg px-3 py-2">
                    {t('intake.skip')}
                  </button>
                )}
              </span>
            )}

            {/* Undoable for the same reason the findings affirmative is: a mis-tap must not be
                permanent, and the audit keeps both events. */}
            {canEdit && it.item === 'diag_scan' && it.done && (
              <button type="button" disabled={busy !== null} onClick={() => post({ action: 'undo_diag_scan' }, 'undo-ds')}
                data-testid="intake-undo-diag-scan"
                className="ml-auto text-xs text-muted hover:text-ink underline">{t('intake.undoDiagScan')}</button>
            )}

            {/* The affirmative is undoable — a mis-tap must not be permanent, and the audit keeps both. */}
            {canEdit && it.item === 'findings' && it.done && nothingFoundAt && (
              <button type="button" disabled={busy !== null} onClick={() => post({ action: 'undo_nothing_found' }, 'undo')}
                data-testid="intake-undo-nothing-found"
                className="ml-auto text-xs text-muted hover:text-ink underline">{t('intake.undoNothingFound')}</button>
            )}

            {skipOpen === it.item && (
              <div className="w-full mt-2 space-y-2" data-testid={`intake-skip-form-${it.item}`}>
                {/* TWO TAPPABLE REASONS, fixed in code. "Scanner is broken" and "in a hurry" are
                    different facts and the email is far more useful when it says which — but a
                    REQUIRED category on a phone in a workshop is ceremony, so these prefill the box
                    and the box stays optional. */}
                <div className="flex flex-wrap gap-2">
                  {CHIPS.map((c) => (
                    <button key={c} type="button" onClick={() => setReason(t(`intake.reason.${c}`))}
                      data-testid={`intake-chip-${c}`}
                      className="text-xs rounded-full border border-line bg-surface px-3 py-1.5 text-ink">
                      {t(`intake.reason.${c}`)}
                    </button>
                  ))}
                </div>
                <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300}
                  placeholder={t('intake.reasonPlaceholder')} data-testid="intake-skip-reason"
                  className="w-full p-2 text-sm bg-surface border border-line rounded-lg text-ink" />
                <div className="flex gap-2">
                  <button type="button" disabled={busy !== null} onClick={() => post({ action: 'skip', item: it.item, reason }, 'skip')}
                    data-testid="intake-skip-confirm"
                    className="text-sm font-semibold bg-warn text-white rounded-lg px-3 py-2 disabled:opacity-50">{t('intake.skipConfirm')}</button>
                  <button type="button" onClick={() => { setSkipOpen(null); setReason(''); }}
                    className="text-sm bg-surface-muted text-ink rounded-lg px-3 py-2">{t('intake.cancel')}</button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted mt-3">{t('intake.footnote')}</p>
    </div>
  );
}
