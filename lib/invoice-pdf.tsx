/**
 * File: lib/invoice-pdf.tsx
 * The A4 invoice PDF — a faithful print of lib/invoice-doc's InvoiceDoc (the same data the view
 * renders, so screen and paper can never disagree). Clean text header from the issue snapshots —
 * the logo + template designer arrive in a later slice. @react-pdf/renderer: pure JS, no headless
 * browser, serverless-friendly. Strings via tServer (same locale JSON as the client). Server-only.
 */
import React from 'react';
import { Document, Page, Text, View, StyleSheet, Image, renderToBuffer } from '@react-pdf/renderer';
import type { InvoiceDoc } from '@/lib/invoice-doc';
import { formatMoney } from '@/lib/format-money';
import { tServer } from '@/lib/server-i18n';

const S = StyleSheet.create({
  page: { padding: 48, fontSize: 10, fontFamily: 'Helvetica', color: '#111827' },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', paddingBottom: 16, borderBottomWidth: 1, borderBottomColor: '#e5e7eb' },
  companyName: { fontSize: 14, fontFamily: 'Helvetica-Bold' },
  muted: { color: '#6b7280' },
  docTitle: { fontSize: 18, fontFamily: 'Helvetica-Bold', textAlign: 'right' },
  number: { fontSize: 11, textAlign: 'right', marginTop: 2 },
  numberSecondary: { fontSize: 8, textAlign: 'right', marginTop: 1, color: '#666' },
  badge: { fontSize: 8, textAlign: 'right', marginTop: 4, color: '#6b7280' },
  partiesRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: '#e5e7eb' },
  label: { fontSize: 7, textTransform: 'uppercase', color: '#6b7280', marginBottom: 3, letterSpacing: 0.5 },
  tableHead: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#e5e7eb', paddingVertical: 6, marginTop: 16 },
  th: { fontSize: 7, textTransform: 'uppercase', color: '#6b7280', letterSpacing: 0.5 },
  row: { flexDirection: 'row', borderBottomWidth: 0.5, borderBottomColor: '#f3f4f6', paddingVertical: 6 },
  cDesc: { flex: 5, paddingRight: 8 },
  cQty: { flex: 1, textAlign: 'right' },
  cPrice: { flex: 2, textAlign: 'right' },
  cRate: { flex: 1.5, textAlign: 'right' },
  cNet: { flex: 2, textAlign: 'right' },
  totalsWrap: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 12 },
  totals: { width: 200 },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2 },
  grand: { borderTopWidth: 1, borderTopColor: '#e5e7eb', marginTop: 4, paddingTop: 4, fontFamily: 'Helvetica-Bold', fontSize: 12 },
  footer: { position: 'absolute', bottom: 32, left: 48, right: 48, textAlign: 'center', fontSize: 8, color: '#9ca3af' },
});

function InvoicePdf({ doc, logo }: { doc: InvoiceDoc; logo: Buffer | null }) {
  const t = (key: string, vars?: Record<string, string | number>) => tServer(doc.locale, 'invoice', key, vars);
  const fmt = (p: number) => formatMoney(p, { currency: doc.currency, locale: doc.locale });
  const reg = doc.vatRegistered;
  const isPaidState = doc.status === 'paid' || doc.status === 'paid_pending';
  const warranty = doc.series === 'warranty';
  // NO VAT anywhere on a warranty document (lines at net retail, goodwill line zeroes the total
  // before VAT would arise); totals collapse to the loud AMOUNT DUE £0.00.
  const showVat = reg && !warranty;
  return (
    <Document title={`${t('title')} ${(doc as any).displayNumber || doc.number}`}>
      <Page size="A4" style={S.page}>
        {logo ? (
          // Tenant logo, auto-placed top-centre (no position controls — banked with the designer).
          <View style={{ alignItems: 'center', marginBottom: 14 }}>
            <Image src={{ data: logo, format: doc.logoFormat === 'png' ? 'png' : 'jpg' }} style={{ maxHeight: 56, maxWidth: 180, objectFit: 'contain' }} />
          </View>
        ) : null}
        <View style={S.headerRow}>
          <View style={{ maxWidth: 260 }}>
            <Text style={S.companyName}>{doc.company.name}</Text>
            {doc.company.address ? <Text style={S.muted}>{doc.company.address}</Text> : null}
            {reg && doc.company.vatNumber ? <Text style={S.muted}>{t('vatNumber', { label: doc.taxLabel })} {doc.company.vatNumber}</Text> : null}
          </View>
          <View>
            <Text style={S.docTitle}>{t('title').toUpperCase()}</Text>
            {/* Imported: the customer's own document number leads; ours is printed beneath so the
                two can be reconciled without hunting. */}
            <Text style={S.number}>{(doc as any).displayNumber || doc.number}</Text>
            {(doc as any).secondaryNumber && (
              <Text style={S.numberSecondary}>GreaseDesk {(doc as any).secondaryNumber}</Text>
            )}
            <Text style={S.badge}>{t('issued')}: {doc.issuedAt.toLocaleDateString(doc.locale)}</Text>
            {doc.series === 'warranty' ? <Text style={S.badge}>{t('warrantyBadge')}</Text> : null}
            {/* Pending NEVER wears the confirmed PAID face — settlement isn't final yet. */}
            {doc.status === 'paid' ? <Text style={S.badge}>{t('paidBadge')}</Text> : null}
            {doc.status === 'paid_pending' ? <Text style={S.badge}>{t('pendingBadge')}</Text> : null}
          </View>
        </View>

        <View style={S.partiesRow}>
          <View style={{ maxWidth: 260 }}>
            <Text style={S.label}>{t('billTo')}</Text>
            <Text>{doc.customer.name}</Text>
            {doc.customer.address ? <Text style={S.muted}>{doc.customer.address}</Text> : null}
          </View>
          {(doc.vehicle.reg || doc.vehicle.desc || doc.vehicle.vin || doc.vehicle.mileage != null) ? (
            // Stacked Registration / VIN / Mileage (TMBS layout) — absent fields omit their line.
            <View>
              <Text style={[S.label, { textAlign: 'right' }]}>{t('vehicle')}</Text>
              {doc.vehicle.reg ? <Text style={{ textAlign: 'right' }}>{t('vehicleBlock.registration')}: {doc.vehicle.reg}</Text> : null}
              {doc.vehicle.desc ? <Text style={[S.muted, { textAlign: 'right' }]}>{doc.vehicle.desc}</Text> : null}
              {doc.vehicle.vin ? <Text style={[S.muted, { textAlign: 'right' }]}>{t('vehicleBlock.vin')}: {doc.vehicle.vin}</Text> : null}
              {doc.vehicle.mileage != null ? <Text style={[S.muted, { textAlign: 'right' }]}>{t('vehicleBlock.mileage')}: {doc.vehicle.mileage.toLocaleString(doc.locale)}</Text> : null}
            </View>
          ) : null}
        </View>

        <View style={S.tableHead}>
          <Text style={[S.th, S.cDesc]}>{t('cols.description')}</Text>
          <Text style={[S.th, S.cQty]}>{t('cols.qty')}</Text>
          <Text style={[S.th, S.cPrice]}>{t('cols.unitPrice')}</Text>
          {showVat ? <Text style={[S.th, S.cRate]}>{t('cols.vatRate', { label: doc.taxLabel })}</Text> : null}
          <Text style={[S.th, S.cNet]}>{showVat ? t('cols.net') : t('cols.amount')}</Text>
        </View>
        {doc.lines.map((l, i) => (
          <View key={i} style={S.row} wrap={false}>
            <Text style={S.cDesc}>{l.description}</Text>
            <Text style={S.cQty}>{l.qty}</Text>
            <Text style={S.cPrice}>{fmt(l.unitPricePennies)}</Text>
            {showVat ? <Text style={S.cRate}>{l.vatRate}%</Text> : null}
            <Text style={S.cNet}>{fmt(l.netPennies)}</Text>
          </View>
        ))}

        <View style={S.totalsWrap}>
          <View style={S.totals}>
            {warranty ? (
              /* The LOUDEST figure on the document — a customer must never read the goods value
                 above as money owed. */
              <View style={[S.totalRow, S.grand, { fontSize: 16 }]}><Text>{t('amountDue').toUpperCase()}</Text><Text>{fmt(0)}</Text></View>
            ) : reg ? (
              <>
                <View style={S.totalRow}><Text style={S.muted}>{t('subtotal', { label: doc.taxLabel })}</Text><Text>{fmt(doc.totals.netPennies)}</Text></View>
                {doc.totals.breakdown.map((b) => (
                  <View key={b.rate} style={S.totalRow}><Text style={S.muted}>{t('vatAt', { rate: b.rate, label: doc.taxLabel })}</Text><Text>{fmt(b.vatPennies)}</Text></View>
                ))}
                <View style={S.totalRow}><Text style={S.muted}>{t('totalVat', { label: doc.taxLabel })}</Text><Text>{fmt(doc.totals.vatPennies)}</Text></View>
                <View style={[S.totalRow, S.grand]}><Text>{t('grandTotal')}</Text><Text>{fmt(doc.totals.grossPennies)}</Text></View>
              </>
            ) : (
              <View style={[S.totalRow, S.grand]}><Text>{t('total')}</Text><Text>{fmt(doc.totals.netPennies)}</Text></View>
            )}
            {/* Status-aware footer (Xero-style): marked/confirmed paid → Less Amount Paid + date +
                AMOUNT DUE 0. Unpaid renders nothing here — the terms block below covers it.
                Warranty already renders AMOUNT DUE 0 above — never twice. */}
            {isPaidState && !warranty ? (
              <>
                <View style={S.totalRow}>
                  <Text style={S.muted}>{t('lessAmountPaid')}{doc.datePaid ? ` (${doc.datePaid.toLocaleDateString(doc.locale, { timeZone: 'UTC' })})` : ''}</Text>
                  <Text>{fmt(-(reg ? doc.totals.grossPennies : doc.totals.netPennies))}</Text>
                </View>
                <View style={[S.totalRow, S.grand]}><Text>{t('amountDue')}</Text><Text>{fmt(0)}</Text></View>
              </>
            ) : null}
          </View>
        </View>

        {doc.footerText ? (
          // Payment terms / footer block (Invoicing tab) — multi-line, verbatim.
          <Text style={[S.muted, { marginTop: 18, fontSize: 8, lineHeight: 1.5 }]}>{doc.footerText}</Text>
        ) : null}

        {!reg && !warranty ? <Text style={[S.muted, { marginTop: 12 }]}>{t('notRegistered', { label: doc.taxLabel })}</Text> : null}
        <Text style={S.footer} fixed>{doc.company.name} — {t('title')} {doc.number}</Text>
      </Page>
    </Document>
  );
}

export async function renderInvoicePdf(doc: InvoiceDoc): Promise<Buffer> {
  let logo: Buffer | null = null;
  if (doc.logoUrl) {
    try {
      const r = await fetch(doc.logoUrl);
      if (r.ok) logo = Buffer.from(await r.arrayBuffer());
    } catch { /* logo is decoration — never fail the document for it */ }
  }
  return await renderToBuffer(<InvoicePdf doc={doc} logo={logo} />);
}
