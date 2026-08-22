/**
 * File: components/marketing/CarPanes.tsx
 * The middle and right panes of the call view: a car's history, its owner's figures, its open
 * findings, and one card's detail.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────────────────────────
 * Declines and values. No finding on any tenant has ever been declined — all 88 are `not_raised` —
 * and DueItemLine, the join that would give a finding a price, has never had a row. A panel built
 * for either would be built against a column with one value in it. What IS shown is what was
 * raised and when, and that nobody has answered: the honest answer to "why am I ringing you".
 */
import React from 'react';

export type CarHistoryCard = {
  cardId: string; date: string; status: string; odometerIn: number | null;
  invoiceNumber: string | null; issued: boolean; summary: string[]; grossPennies: number;
};
export type CarCustomer = {
  name: string | null; totalPennies: number; visits: number;
  firstVisit: string | null; averagePennies: number; cars: number;
};
export type CarFinding = {
  id: string; description: string; raisedOn: string;
  response: 'not_raised' | 'declined' | 'agreed_later' | 'wants_call'; answeredOn: string | null;
};
export type CarDetail = {
  vehicle: { id: string; registration: string; desc: string | null };
  history: CarHistoryCard[]; customer: CarCustomer | null; findings: CarFinding[];
};

const money = (p: number, locale: string) =>
  new Intl.NumberFormat(locale, { style: 'currency', currency: 'GBP' }).format(p / 100);
const day = (iso: string, locale: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** MIDDLE — the customer, then what was found, then every visit. */
export function CarHistoryPane({ detail, selectedCard, onPick, locale }: {
  detail: CarDetail; selectedCard: string | null; onPick: (cardId: string) => void; locale: string;
}) {
  const c = detail.customer;
  const unanswered = detail.findings.filter((f) => f.response === 'not_raised');
  return (
    <div className="space-y-4" data-testid="pane-history">
      {c && (
        // INC. VAT, SAID OUT LOUD. These are summed from the frozen invoice lines, which are gross
        // — the same figure the customer paid. Revenue reporting is net, and an unlabelled total
        // that disagreed with the dashboard by a fifth would be read as a bug in one of them.
        <div className="rounded-xl border border-line bg-surface p-3" data-testid="customer-figures">
          <div className="flex items-baseline justify-between gap-2 flex-wrap">
            <span className="text-sm font-semibold text-ink">{c.name ?? 'No owner on record'}</span>
            {c.cars > 1 && (
              <span className="text-xs text-muted" data-testid="customer-cars">{c.cars} cars with us</span>
            )}
          </div>
          <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-1 mt-2">
            {([['Total spent', money(c.totalPennies, locale)], ['Visits', String(c.visits)],
               ['First visit', c.firstVisit ? day(c.firstVisit, locale) : '—'],
               ['Average visit', money(c.averagePennies, locale)]] as const).map(([k, v]) => (
              <div key={k}>
                <dt className="text-[11px] text-muted">{k}</dt>
                <dd className="text-sm text-ink tabular-nums">{v}</dd>
              </div>
            ))}
          </dl>
          <p className="text-[11px] text-muted mt-1.5">Figures inc. VAT, across every car this customer owns.</p>
        </div>
      )}

      {unanswered.length > 0 && (
        <div className="rounded-xl border border-line bg-surface p-3" data-testid="findings-unanswered">
          <p className="text-sm font-semibold text-ink mb-1">
            {unanswered.length === 1 ? '1 finding nobody has answered' : `${unanswered.length} findings nobody has answered`}
          </p>
          <ul className="space-y-1">
            {unanswered.map((f) => (
              <li key={f.id} className="text-xs text-muted flex gap-2" data-testid={`finding-${f.id}`}>
                <span className="text-ink flex-1">{f.description}</span>
                <span className="tabular-nums whitespace-nowrap">raised {day(f.raisedOn, locale)}</span>
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-muted mt-1.5">Record what they say on the job card.</p>
        </div>
      )}

      <div>
        <p className="text-xs font-medium text-muted mb-1">
          {detail.history.length === 1 ? '1 visit' : `${detail.history.length} visits`}
        </p>
        {detail.history.length === 0 && <p className="text-sm text-muted italic">No job cards for this car yet.</p>}
        <ul>
          {detail.history.map((h) => (
            <li key={h.cardId}>
              <button type="button" onClick={() => onPick(h.cardId)}
                data-testid={`history-card-${h.cardId}`} data-selected={selectedCard === h.cardId}
                className={`w-full text-left py-2 px-2 rounded-lg border-b border-line last:border-0 ${
                  selectedCard === h.cardId ? 'bg-accent-soft' : 'hover:bg-surface-muted'}`}>
                <span className="flex items-baseline justify-between gap-2">
                  <span className="text-sm text-ink tabular-nums">{day(h.date, locale)}</span>
                  <span className="text-sm text-ink tabular-nums">{money(h.grossPennies, locale)}</span>
                </span>
                {/* FIRST LINE OF EACH DESCRIPTION, clamped. A catalogue line is Title + newline +
                    Description, so the untrimmed join runs past a thousand characters on the tail.
                    The whole thing is on the card in the pane to the right. */}
                <span className="block text-xs text-muted line-clamp-2 mt-0.5">
                  {h.summary.join(' · ') || (h.issued ? 'No lines on the invoice' : 'Nothing quoted yet')}
                </span>
                {!h.issued && <span className="text-[11px] text-warn">Not invoiced</span>}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** RIGHT — one card, in full. */
export function CardDetailPane({ card, locale }: { card: CarHistoryCard | null; locale: string }) {
  if (!card) {
    return <p className="text-sm text-muted italic" data-testid="pane-detail-empty">Pick a visit to see what was done.</p>;
  }
  return (
    <div className="space-y-3" data-testid="pane-detail">
      <div>
        <p className="text-sm font-semibold text-ink">{day(card.date, locale)}</p>
        <p className="text-xs text-muted">
          {card.invoiceNumber ? `Invoice ${card.invoiceNumber}` : 'No invoice raised'}
          {card.odometerIn != null && ` · ${card.odometerIn.toLocaleString(locale)} miles`}
        </p>
      </div>
      <div>
        <p className="text-xs font-medium text-muted mb-1">Work</p>
        {card.summary.length === 0 && <p className="text-sm text-muted italic">Nothing recorded.</p>}
        <ul className="space-y-1">
          {card.summary.map((line, i) => (
            <li key={i} className="text-sm text-ink">{line}</li>
          ))}
        </ul>
      </div>
      <p className="text-sm text-ink tabular-nums border-t border-line pt-2">
        {money(card.grossPennies, locale)} <span className="text-xs text-muted">inc. VAT</span>
      </p>
    </div>
  );
}
