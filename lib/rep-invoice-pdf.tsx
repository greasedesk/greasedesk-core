/**
 * File: lib/rep-invoice-pdf.tsx
 * THE REP'S INVOICE, ON PAPER. @react-pdf/renderer, same machinery as lib/invoice-pdf.
 *
 * ── A SIBLING, NOT A BRANCH OF lib/invoice-pdf ──────────────────────────────────────────────────
 * That renderer is typed to InvoiceDoc and hardcodes OUR role as the issuer. Here the roles are the
 * other way round: the REP issues, we are the customer. Adding a mode to that file would have put
 * an `if` inside every block of a document that has to be right, so this is its own renderer
 * reading its own doc type — and it reads the SHARED VAT RULE rather than a copy of it.
 *
 * ── RENDERED ONCE, EVER ─────────────────────────────────────────────────────────────────────────
 * The output is stored as bytes and hashed at submission. Nothing calls this again for a document
 * that exists: re-rendering somebody else's accounting record from current data would be forging
 * their books, which is the whole reason RepInvoice holds a bytea instead of rebuilding like a
 * garage invoice does. lib/rep-invoice::refuseIfSubmitted is the predicate that says so.
 */
import React from 'react';
import { Document, Page, Text, View, StyleSheet, renderToBuffer } from '@react-pdf/renderer';
import type { RepInvoiceDoc } from '@/lib/rep-invoice';
import { showVatTotalLine } from '@/lib/invoice';
import { formatMoney } from '@/lib/format-money';

const S = StyleSheet.create({
  page: { padding: 48, fontSize: 10, fontFamily: 'Helvetica', color: '#111827' },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', paddingBottom: 16, borderBottomWidth: 1, borderBottomColor: '#e5e7eb' },
  issuerName: { fontSize: 14, fontFamily: 'Helvetica-Bold' },
  muted: { color: '#6b7280' },
  docTitle: { fontSize: 18, fontFamily: 'Helvetica-Bold', textAlign: 'right' },
  number: { fontSize: 11, textAlign: 'right', marginTop: 2 },
  meta: { fontSize: 9, textAlign: 'right', marginTop: 1, color: '#6b7280' },
  partiesRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: '#e5e7eb' },
  label: { fontSize: 7, textTransform: 'uppercase', color: '#6b7280', marginBottom: 3, letterSpacing: 0.5 },
  tableHead: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#e5e7eb', paddingVertical: 6, marginTop: 16 },
  th: { fontSize: 7, textTransform: 'uppercase', color: '#6b7280', letterSpacing: 0.5 },
  row: { flexDirection: 'row', borderBottomWidth: 0.5, borderBottomColor: '#f3f4f6', paddingVertical: 6 },
  cDesc: { flex: 6, paddingRight: 8 },
  cPeriod: { flex: 2 },
  cAmt: { flex: 2, textAlign: 'right' },
  arrears: { fontSize: 7, color: '#b45309' },
  totalsWrap: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 12 },
  totals: { width: 220 },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2 },
  grand: { borderTopWidth: 1, borderTopColor: '#e5e7eb', marginTop: 4, paddingTop: 4, fontFamily: 'Helvetica-Bold', fontSize: 12 },
  payBlock: { marginTop: 24, paddingTop: 12, borderTopWidth: 1, borderTopColor: '#e5e7eb' },
  payHead: { fontSize: 8, textTransform: 'uppercase', color: '#6b7280', letterSpacing: 0.5, marginBottom: 4 },
  missing: { color: '#6b7280', fontStyle: 'italic' },
  footer: { position: 'absolute', bottom: 26, left: 48, right: 48, textAlign: 'center', fontSize: 8, color: '#9ca3af' },
});

const d = (x: Date) => x.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

export function RepInvoicePdf({ doc }: { doc: RepInvoiceDoc }) {
  // formatMoney takes PENNIES and an options object — it does the division itself.
  const money = (p: number) => formatMoney(p, { currency: doc.currency, locale: 'en-GB' });
  // THE SHARED RULE, NOT A COPY. showVatTotalLine collapses the duplicate on a single-rate document
  // — a rep invoice is always single-rate, so this is always false, and reading the rule rather
  // than hardcoding false is what keeps this renderer honest if that ever changes.
  const showVatBreakdown = showVatTotalLine({ breakdown: doc.vatApplied ? [{ rate: (doc.vatRateBp ?? 0) / 100, netPennies: doc.subtotalPennies, vatPennies: doc.vatPennies ?? 0 }] : [] });
  return (
    <Document>
      <Page size="A4" style={S.page}>
        <View style={S.headerRow}>
          <View>
            <Text style={S.issuerName}>{doc.from.tradingName}</Text>
            <Text style={S.muted}>{doc.from.address}</Text>
            {doc.from.contact ? <Text style={S.muted}>{doc.from.contact}</Text> : null}
            {doc.from.vatNumber ? <Text style={S.muted}>VAT No. {doc.from.vatNumber}</Text> : null}
          </View>
          <View>
            <Text style={S.docTitle}>Invoice</Text>
            <Text style={S.number}>{doc.number}</Text>
            <Text style={S.meta}>Date {d(doc.invoiceDate)}</Text>
            {/* NO TAX POINT LINE ON A DOCUMENT THAT IS NOT A VAT INVOICE. Printing one anyway would
                state a fact that does not exist for an unregistered supplier. */}
            {doc.taxPoint ? <Text style={S.meta}>Tax point {d(doc.taxPoint)}</Text> : null}
          </View>
        </View>

        <View style={S.partiesRow}>
          <View>
            <Text style={S.label}>Invoice to</Text>
            <Text>{doc.to.name}</Text>
            <Text style={S.muted}>{doc.to.address}</Text>
            <Text style={S.muted}>Company No. {doc.to.companyNumber}</Text>
          </View>
        </View>

        <View style={S.tableHead}>
          <Text style={[S.th, S.cDesc]}>Sales Commission</Text>
          <Text style={[S.th, S.cPeriod]}>Period</Text>
          <Text style={[S.th, S.cAmt]}>Amount</Text>
        </View>
        {doc.lines.map((l, i) => (
          <View style={S.row} key={i}>
            <View style={S.cDesc}>
              <Text>{l.description}</Text>
              {/* ARREARS CARRY THEIR ORIGINAL PERIOD, said in words. A line from an earlier month
                  in this run's invoice is not a mistake, and the rep's accountant needs to know. */}
              {l.isArrears ? <Text style={S.arrears}>Arrears — {l.period}</Text> : null}
            </View>
            <Text style={S.cPeriod}>{l.period}</Text>
            <Text style={S.cAmt}>{money(l.amountPennies)}</Text>
          </View>
        ))}

        <View style={S.totalsWrap}>
          <View style={S.totals}>
            <View style={S.totalRow}><Text style={S.muted}>Subtotal</Text><Text>{money(doc.subtotalPennies)}</Text></View>
            {doc.vatApplied ? (
              <View style={S.totalRow}>
                <Text style={S.muted}>VAT at {(doc.vatRateBp ?? 0) / 100}%</Text>
                <Text>{money(doc.vatPennies ?? 0)}</Text>
              </View>
            ) : null}
            {showVatBreakdown ? <View style={S.totalRow}><Text style={S.muted}>VAT total</Text><Text>{money(doc.vatPennies ?? 0)}</Text></View> : null}
            <View style={[S.totalRow, S.grand]}><Text>Total</Text><Text>{money(doc.totalPennies)}</Text></View>
          </View>
        </View>

        <View style={S.payBlock}>
          <Text style={S.payHead}>Payment details</Text>
          {doc.payTo ? (
            <>
              <Text>{doc.payTo.accountName}</Text>
              <Text style={S.muted}>Sort code {doc.payTo.sortCode} · Account {doc.payTo.accountNumber}</Text>
            </>
          ) : (
            // HONEST NULL ON PAPER. Not a blank block that reads as filled in, and never a zeroed
            // account: the document says the details are missing, because they are.
            <Text style={S.missing}>No bank details recorded — GreaseDesk will contact you.</Text>
          )}
        </View>

        <Text style={S.footer} fixed>Sales Commission invoice · {doc.number}</Text>
      </Page>
    </Document>
  );
}

export async function renderRepInvoicePdf(doc: RepInvoiceDoc): Promise<Buffer> {
  return await renderToBuffer(<RepInvoicePdf doc={doc} />);
}
