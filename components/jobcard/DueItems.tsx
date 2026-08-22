/**
 * File: components/jobcard/DueItems.tsx
 * WHAT THE CAR NEEDS THAT NOBODY IS DOING TODAY — capture at intake, and the open list.
 *
 * ── THE THREE-STATE ANSWER HAS NO DEFAULT, ON PURPOSE ───────────────────────────────────────────
 * "Nobody asked them" and "they said no" are different facts and only the second is a lead. A
 * pre-selected radio would let a mechanic tap through at speed and record every finding as
 * not_raised, which would look like data while quietly emptying the marketing list — a failure
 * that is invisible precisely because the rows exist. So: three unselected buttons, and Save stays
 * disabled until one is pressed. The server refuses a missing answer too (lib/due-items), so a
 * client that forgot could not write a defaulted row either.
 *
 * The same shape guards the basis: what makes it due is CHOSEN, never inferred from which of the
 * date/mileage boxes happens to be filled.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { CLOSED_KINDS, CLOSED_KIND_LABEL, type ClosedKind } from '@/lib/due-item-closure';
import { useTranslation } from 'next-i18next';

export type DueItemView = {
  id: string; description: string;
  dueBasis: 'date' | 'mileage' | 'next_service' | 'whichever_first';
  dueDate: string | null; dueMileage: number | null;
  customerResponse: 'not_raised' | 'declined' | 'agreed_later' | 'wants_call';
  createdAt?: string;
  /** Which tapped observation this is, NULL when a human typed it — so the tap-list can show one
   *  already recorded rather than offering a tap that would be a no-op. */
  observationKey?: string | null;
  /** Derived (lib/due-items::closureOffer) — offered, never applied automatically. */
  closureOffer?: { offer: false; reason: 'no_lines' | 'work_outstanding' } | { offer: true; invoicedLines: number };
};

type Props = {
  jobCardId: string; items: DueItemView[]; canEdit: boolean;
  /** DVSA-sourced, READ-ONLY. Shown so nobody retypes it as a finding — see the note below. */
  motExpiry?: string | null;
};

const BASES = ['date', 'mileage', 'next_service', 'whichever_first'] as const;
const RESPONSES = ['not_raised', 'declined', 'agreed_later'] as const;

export default function DueItems({ jobCardId, items: seed, canEdit, motExpiry }: Props) {
  const { t } = useTranslation('jobcard');
  // SEEDED from the server render, then owned here. The card's generic refresh returns the pane's
  // own fields and never learned about findings; rather than widen that payload for one panel,
  // this re-reads its own list — the same shape PhotoStage already uses for its media.
  const [items, setItems] = useState<DueItemView[]>(seed);
  useEffect(() => { setItems(seed); }, [seed]);
  const reload = useCallback(async () => {
    const res = await fetch(`/api/due-items?jobCardId=${encodeURIComponent(jobCardId)}`, { cache: 'no-store' });
    if (res.ok) setItems(((await res.json()).items ?? []) as DueItemView[]);
  }, [jobCardId]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [desc, setDesc] = useState('');
  // NULL, not a first option. The absence IS the design — see the header.
  const [basis, setBasis] = useState<typeof BASES[number] | null>(null);
  const [response, setResponse] = useState<typeof RESPONSES[number] | null>(null);
  const [date, setDate] = useState('');
  const [mileage, setMileage] = useState('');

  const reset = () => { setDesc(''); setBasis(null); setResponse(null); setDate(''); setMileage(''); setErr(null); };

  // Mirrors refuseDueItem's shape so the button is honest about why it is disabled; the SERVER
  // still decides — this only spares a round trip.
  const needsDate = basis === 'date' || basis === 'whichever_first';
  const needsMileage = basis === 'mileage' || basis === 'whichever_first';
  const ready = desc.trim() !== '' && basis !== null && response !== null
    && (!needsDate || date !== '') && (!needsMileage || mileage.trim() !== '');

  async function save() {
    setBusy(true); setErr(null);
    try {
      const res = await fetch('/api/due-items', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobCardId, description: desc, dueBasis: basis, customerResponse: response,
          dueDate: date || undefined, dueMileage: mileage.trim() === '' ? undefined : Number(mileage),
        }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(d?.message || t('dueItems.saveError')); return; }
      reset(); setOpen(false); await reload();
    } finally { setBusy(false); }
  }

  // ── CLOSING NOW SAYS WHY ──────────────────────────────────────────────────────────────────
  // This sent `{ id }` and nothing else. The API had accepted an optional reason since the day it
  // was written and no caller ever passed one, so every closure a human made through this list
  // recorded neither a reason nor a card — and "the garage did it" became indistinguishable from
  // "the customer refused it" on the car's permanent history.
  const [closing, setClosing] = useState<string | null>(null);
  const [note, setNote] = useState('');
  // ── RECORDING WHAT THEY SAID, AFTER THE FACT ─────────────────────────────────────────────────
  // The create form asks for a response at the car, before anyone has spoken to the customer, so
  // `not raised yet` is the honest answer then — and it is what all 88 findings on the platform
  // say, because until now nothing could change one afterwards. The answer arrives on the phone.
  //
  // NO DEFAULT and no pre-selection, for the same reason the create form has none: a default here
  // would look like an answer somebody gave. `not_raised` is absent by construction — the server
  // refuses it too (lib/due-items::refuseResponse), because a finding cannot be un-asked.
  const [answering, setAnswering] = useState<string | null>(null);
  async function respond(id: string, response: 'declined' | 'agreed_later' | 'wants_call') {
    setBusy(true);
    try {
      const r = await fetch('/api/due-items', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'respond', id, response }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(d?.message || t('dueItems.saveError')); return; }
      setAnswering(null);
      await reload();
    } finally { setBusy(false); }
  }

  async function close(id: string, kind: ClosedKind) {
    setBusy(true);
    try {
      const r = await fetch('/api/due-items', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        // jobCardId ALWAYS, not only for `fixed`: it is true of every closure made from a card,
        // and the server is what insists on it for the one kind that cannot do without it.
        body: JSON.stringify({ action: 'close', id, closedKind: kind, closedReason: note.trim() || undefined, jobCardId }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(d?.message || t('dueItems.saveError')); return; }
      setClosing(null); setNote('');
      await reload();
    } finally { setBusy(false); }
  }

  const chip = (active: boolean) =>
    `text-sm rounded-lg px-3 py-2 border ${active ? 'bg-accent text-white border-accent' : 'bg-surface border-line text-ink'}`;

  return (
    <div className="bg-surface border border-line rounded-xl p-5" data-testid="due-items">
      <div className="flex items-center justify-between gap-2 mb-3">
        <h3 className="text-sm font-semibold text-ink">{t('dueItems.title')}</h3>
        {canEdit && !open && (
          <button type="button" onClick={() => setOpen(true)} data-testid="due-item-add"
            className="text-sm font-semibold bg-accent hover:bg-accent-hover text-white rounded-lg px-3 py-2">{t('dueItems.add')}</button>
        )}
      </div>

      {/* MOT EXPIRY IS ALREADY KNOWN — DVSA-sourced on the vehicle, and shown here READ-ONLY so
          nobody records it as a finding. The description field is freeform and always will be, so
          blocking the string would be theatre; removing the REASON to type it is what works. A
          second, hand-typed copy would drift from the authoritative one the moment the car is
          retested. */}
      {motExpiry && (
        <p className="text-xs text-muted mb-3 flex flex-wrap items-baseline gap-x-1.5" data-testid="due-items-mot">
          <span className="font-medium text-ink">{t('dueItems.motExpiry', { date: motExpiry })}</span>
          <span>{t('dueItems.motSource')}</span>
        </p>
      )}

      {items.length === 0 && !open && <p className="text-sm text-muted">{t('dueItems.empty')}</p>}

      {items.length > 0 && (
        <ul className="space-y-2 mb-3" data-testid="due-item-list">
          {items.map((it) => (
            <li key={it.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 bg-surface-muted rounded-lg px-3 py-2">
              <span className="text-sm font-medium text-ink">{it.description}</span>
              <span className="text-xs text-muted">{t(`dueItems.basis.${it.dueBasis}`, {
                date: it.dueDate ?? '', mileage: it.dueMileage != null ? it.dueMileage.toLocaleString('en-GB') : '',
              })}</span>
              {/* THE LEAD, named. `declined` is the one that becomes a reminder in October, so it
                  is the one the list makes visible rather than a neutral tag for all three. */}
              <span className={`text-xs font-medium rounded-full px-2 py-0.5 ${it.customerResponse === 'declined' ? 'bg-warn-soft text-warn' : 'bg-surface border border-line text-muted'}`}>
                {t(`dueItems.response.${it.customerResponse}`)}
              </span>
              {canEdit && answering !== it.id && closing !== it.id && (
                <button type="button" disabled={busy} onClick={() => { setAnswering(it.id); }}
                  className="text-xs underline text-accent disabled:opacity-50" data-testid={`due-item-answer-${it.id}`}>
                  {it.customerResponse === 'not_raised' ? 'Record their answer' : 'Change'}
                </button>
              )}
              {canEdit && answering === it.id && (
                <span className="flex items-center gap-1.5 flex-wrap" data-testid={`due-item-answers-${it.id}`}>
                  {/* THE SAME THREE WORDS THE CREATE FORM USES, minus "not raised": you cannot
                      un-ask a question. Order matches the create form so the vocabulary reads the
                      same in both places. */}
                  {([['declined', 'They declined'], ['agreed_later', 'Wants it later'], ['wants_call', 'Asked for a call']] as const).map(([k, label]) => (
                    <button key={k} type="button" disabled={busy} onClick={() => respond(it.id, k)}
                      data-testid={`due-item-answer-${k}-${it.id}`}
                      className="text-xs rounded-lg border border-line bg-surface px-2 py-1 text-ink disabled:opacity-50">
                      {label}
                    </button>
                  ))}
                  <button type="button" disabled={busy} onClick={() => setAnswering(null)}
                    className="text-xs underline text-muted">Cancel</button>
                </span>
              )}
              {canEdit && closing !== it.id && answering !== it.id && (
                <button type="button" disabled={busy} onClick={() => { setClosing(it.id); setNote(''); }}
                  data-testid={`due-item-close-${it.id}`}
                  className="ml-auto text-xs text-muted hover:text-ink underline">{t('dueItems.close')}</button>
              )}
              {canEdit && closing === it.id && (
                <div className="w-full mt-2 space-y-2" data-testid="due-item-close-panel">
                  {/* THREE OUTCOMES, NAMED. "We sorted it" is first because it is the one that
                      reaches the customer's document, and the one that had no way of being said. */}
                  <div className="flex flex-wrap gap-2">
                    {CLOSED_KINDS.map((k) => (
                      <button key={k} type="button" disabled={busy} onClick={() => close(it.id, k)}
                        data-testid={`due-item-kind-${k}`}
                        className={`text-xs font-semibold rounded-lg px-3 py-2 border ${k === 'fixed' ? 'bg-ok-soft text-ok border-ok' : 'bg-surface border-line text-ink'}`}>
                        {CLOSED_KIND_LABEL[k]}
                      </button>
                    ))}
                    <button type="button" disabled={busy} onClick={() => { setClosing(null); setNote(''); }}
                      className="text-xs text-muted underline px-2">{t('action.cancel')}</button>
                  </div>
                  <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300}
                    placeholder={t('dueItems.closeNote')} data-testid="due-item-close-note"
                    className="w-full min-h-[40px] px-2 bg-surface border border-line rounded-lg text-ink text-sm" />
                </div>
              )}
              {/* THE PROMPT, not the rule. Every line linked to this finding is on an issued
                  invoice, so the work is very likely finished — but "very likely" is not a reason
                  to close it silently. Discs fitted today and pads next month is one invoice and
                  two different answers, so a person confirms. */}
              {canEdit && it.closureOffer?.offer && (
                <div className="w-full mt-2 flex flex-wrap items-center gap-2 bg-ok-soft rounded-lg px-3 py-2"
                  data-testid={`due-closure-offer-${it.id}`}>
                  <span className="text-xs text-ok flex-1">{t('dueItems.closurePrompt')}</span>
                  {/* `fixed` BY CONSTRUCTION. This prompt only appears when every line linked to
                      the finding is on an ISSUED invoice — the garage did the work and billed it,
                      which is the definition of the kind. A human still confirms; what they cannot
                      do from here is close it as something else. */}
                  <button type="button" disabled={busy} onClick={() => close(it.id, 'fixed')}
                    data-testid="due-closure-confirm"
                    className="text-xs font-semibold bg-ok text-white rounded-lg px-3 py-1.5">{t('dueItems.closureConfirm')}</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {open && (
        <div className="space-y-3 border-t border-line pt-3" data-testid="due-item-form">
          <input value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={500} placeholder={t('dueItems.descPlaceholder')}
            className="w-full p-2.5 bg-surface border border-line rounded-lg text-ink text-sm" data-testid="due-item-desc" />

          <div>
            <p className="text-xs text-muted mb-1">{t('dueItems.basisLabel')}</p>
            <div className="flex flex-wrap gap-2">
              {BASES.map((b) => (
                <button key={b} type="button" onClick={() => setBasis(b)} className={chip(basis === b)} data-testid={`due-basis-${b}`}>
                  {t(`dueItems.basisOpt.${b}`)}
                </button>
              ))}
            </div>
            {needsDate && (
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} data-testid="due-item-date"
                className="mt-2 mr-2 p-2.5 bg-surface border border-line rounded-lg text-ink text-sm" />
            )}
            {needsMileage && (
              <input inputMode="numeric" value={mileage} onChange={(e) => setMileage(e.target.value.replace(/[^\d]/g, ''))}
                placeholder={t('dueItems.mileagePlaceholder')} data-testid="due-item-mileage"
                className="mt-2 p-2.5 bg-surface border border-line rounded-lg text-ink text-sm max-w-[10rem]" />
            )}
          </div>

          <div>
            <p className="text-xs text-muted mb-1">{t('dueItems.responseLabel')}</p>
            <div className="flex flex-wrap gap-2">
              {RESPONSES.map((r) => (
                <button key={r} type="button" onClick={() => setResponse(r)} className={chip(response === r)} data-testid={`due-response-${r}`}>
                  {t(`dueItems.response.${r}`)}
                </button>
              ))}
            </div>
          </div>

          {err && <p className="text-sm text-danger">{err}</p>}
          <div className="flex gap-2">
            <button type="button" disabled={!ready || busy} onClick={save} data-testid="due-item-save"
              className="text-sm font-semibold bg-accent hover:bg-accent-hover text-white rounded-lg px-4 py-2.5 disabled:opacity-50">
              {busy ? t('dueItems.saving') : t('dueItems.save')}
            </button>
            <button type="button" disabled={busy} onClick={() => { reset(); setOpen(false); }}
              className="text-sm bg-surface-muted text-ink rounded-lg px-4 py-2.5">{t('dueItems.cancel')}</button>
          </div>
        </div>
      )}
    </div>
  );
}
