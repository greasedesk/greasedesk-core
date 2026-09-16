/**
 * File: components/DocumentLines.tsx
 * THE line table + totals block, rendered by BOTH the invoice view and the customer quote page.
 * One component, so the document a customer accepts and the document they are billed cannot drift
 * in how they present figures. The maths is already shared (lib/invoice::invoiceTotals); this is the
 * presentation half of the same promise.
 *
 * Labels are PASSED IN rather than resolved here: the invoice view is inside the admin i18n
 * namespace, the customer page is public and unauthenticated. Sharing the markup must not drag the
 * public page into the admin translation bundle.
 */
import React from 'react';
import { formatMoney } from '@/lib/format-money';
import { showVatTotalLine } from '@/lib/invoice';
import { singleTotalPennies, MARGIN_SCHEME_STATEMENT, type VatPresentation } from '@/lib/margin-scheme';

export type DocumentLine = {
  description: string;
  qty: number;
  unitPricePennies: number;
  vatRate: number;
  netPennies: number;
};

export type DocumentTotals = {
  breakdown: Array<{ rate: number; netPennies: number; vatPennies: number }>;
  netPennies: number;
  vatPennies: number;
  grossPennies: number;
};

export type DocumentLabels = {
  description: string;
  qty: string;
  unitPrice: string;
  vatRate: string;  // already interpolated with the tax label
  net: string;
  amount: string;
  subtotal: string;
  vatAt: (rate: number) => string;
  totalVat: string;
  grandTotal: string;
  total: string;
};

type Props = {
  lines: DocumentLine[];
  totals: DocumentTotals;
  /** Drives whether VAT columns/rows appear at all — frozen per document, never inferred live. */
  showVat: boolean;
  /** How VAT may be presented (lib/margin-scheme). Absent = 'normal', which is every quote and
   *  every garage invoice. A margin sale suppresses the VAT COLUMN as well as the totals. */
  vatPresentation?: VatPresentation;
  currency: string;
  locale: string;
  labels: DocumentLabels;
  /** Extra rows under the totals (e.g. the invoice's "less amount paid"). */
  children?: React.ReactNode;
};

export default function DocumentLines({ lines, totals, showVat, vatPresentation, currency, locale, labels, children }: Props) {
  // The VAT COLUMN goes with the totals. A row reading "20%" beside a margin total would be the
  // same false statement in a smaller font.
  const showVatCols = showVat && vatPresentation !== 'margin_scheme';
  const fmt = (p: number) => formatMoney(p, { currency, locale });
  return (
    <>
      <div className="py-5 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-muted text-xs uppercase tracking-wide border-b border-line">
              <th className="text-left font-medium py-2">{labels.description}</th>
              <th className="text-right font-medium py-2 px-2">{labels.qty}</th>
              <th className="text-right font-medium py-2 px-2">{labels.unitPrice}</th>
              {showVatCols && <th className="text-right font-medium py-2 px-2">{labels.vatRate}</th>}
              <th className="text-right font-medium py-2">{showVatCols ? labels.net : labels.amount}</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i} className="border-b border-line/60">
                <td className="py-2 text-ink whitespace-pre-line">{l.description}</td>
                <td className="py-2 px-2 text-right text-ink tabular-nums">{l.qty}</td>
                <td className="py-2 px-2 text-right text-ink tabular-nums">{fmt(l.unitPricePennies)}</td>
                {showVatCols && <td className="py-2 px-2 text-right text-muted tabular-nums">{l.vatRate}%</td>}
                <td className="py-2 text-right text-ink tabular-nums">{fmt(l.netPennies)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="pt-4 border-t border-line flex justify-end">
        <div className="w-full sm:w-72 text-sm space-y-1">
          {vatPresentation === 'margin_scheme' ? (
            /* ── A MARGIN SALE SHOWS ONE FIGURE AND NO VAT (lib/margin-scheme) ────────────────
               This is the page a customer opens from their link. The VAT exists inside the price
               and was accounted for on the MARGIN; showing it would state a figure never charged.
               The single total is the GROSS, not the net — the money actually handed over. */
            <>
              <div className="flex justify-between text-base font-semibold"><span className="text-ink">{labels.total}</span><span className="text-ink tabular-nums" data-testid="margin-total">{fmt(singleTotalPennies('margin_scheme', totals))}</span></div>
              <p className="text-xs text-muted pt-2" data-testid="margin-scheme-statement">{MARGIN_SCHEME_STATEMENT}</p>
            </>
          ) : showVat ? (
            <>
              <div className="flex justify-between"><span className="text-muted">{labels.subtotal}</span><span className="text-ink tabular-nums">{fmt(totals.netPennies)}</span></div>
              {totals.breakdown.map((b) => (
                <div key={b.rate} data-testid="vat-rate-line" className="flex justify-between"><span className="text-muted">{labels.vatAt(b.rate)}</span><span className="text-ink tabular-nums">{fmt(b.vatPennies)}</span></div>
              ))}
              {showVatTotalLine(totals) && (
                <div data-testid="vat-total-line" className="flex justify-between"><span className="text-muted">{labels.totalVat}</span><span className="text-ink tabular-nums">{fmt(totals.vatPennies)}</span></div>
              )}
              <div className="flex justify-between text-base font-semibold border-t border-line pt-1"><span className="text-ink">{labels.grandTotal}</span><span className="text-ink tabular-nums">{fmt(totals.grossPennies)}</span></div>
            </>
          ) : (
            <div className="flex justify-between text-base font-semibold"><span className="text-ink">{labels.total}</span><span className="text-ink tabular-nums">{fmt(totals.netPennies)}</span></div>
          )}
          {children}
        </div>
      </div>
    </>
  );
}
