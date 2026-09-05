/**
 * File: lib/invoice-pdf.tsx
 * The A4 invoice PDF — a faithful print of lib/invoice-doc's InvoiceDoc (the same data the view
 * renders, so screen and paper can never disagree). Clean text header from the issue snapshots —
 * the logo + template designer arrive in a later slice. @react-pdf/renderer: pure JS, no headless
 * browser, serverless-friendly. Strings via tServer (same locale JSON as the client). Server-only.
 */
import React from 'react';
import { CREDIT_LINE, CREDIT_HREF } from '@/lib/product-credit';
import { Document, Page, Text, View, StyleSheet, Image, Link, renderToBuffer } from '@react-pdf/renderer';
import type { InvoiceDoc } from '@/lib/invoice-doc';
import { formatMoney } from '@/lib/format-money';
import { tServer } from '@/lib/server-i18n';
import { showVatTotalLine } from '@/lib/invoice';

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
  footer: { position: 'absolute', bottom: 26, left: 48, right: 48, textAlign: 'center', fontSize: 8, color: '#9ca3af' },
  // A shade quieter than the identification line above it: present, not competing.
  credit: { textAlign: 'center', fontSize: 7, color: '#b6bcc6', textDecoration: 'none', marginTop: 2 },
  // ── PAY ONLINE. Xero's placement: a prompt beside the amount due where the eye already is, and
  // the QR + marks in a block at the foot for someone holding a printed copy. Two placements, one
  // URL — see lib/invoice-pay-link for why the mint is single.
  payInline: { marginTop: 6, fontSize: 9, fontFamily: 'Helvetica-Bold', color: '#2563eb', textAlign: 'right' },
  payBlock: { marginTop: 20, paddingTop: 12, borderTopWidth: 1, borderTopColor: '#e5e7eb', flexDirection: 'row', alignItems: 'center' },
  payQr: { width: 68, height: 68, marginRight: 14 },
  payHead: { fontSize: 10, fontFamily: 'Helvetica-Bold', marginBottom: 3 },
  payMarks: { fontSize: 8, color: '#6b7280', marginBottom: 4 },
  payUrl: { fontSize: 8, color: '#2563eb' },
  // VOID: a diagonal stamp across the page, and a stated reason under the header. Deliberately
  // loud — this document is RETAINED and remains producible (VATREC5010), so the copy itself has
  // to carry the fact that it was retired. Rendering is never refused.
  voidMark: { position: 'absolute', top: 300, left: 0, right: 0, textAlign: 'center', fontSize: 96,
              fontFamily: 'Helvetica-Bold', color: '#dc2626', opacity: 0.18, transform: 'rotate(-28deg)' },
  voidNote: { marginTop: 8, padding: 8, borderWidth: 1, borderColor: '#dc2626', color: '#dc2626', fontSize: 9 },
});

/**
 * The pay-online grain, resolved by the CALLER and handed in. Deliberately not derived here: the
 * link must be MINTED ONCE and shared by the email, this PDF and the SMS (lib/invoice-pay-link), so
 * a renderer that minted its own would hand the customer a second credential for the same invoice.
 * Absent = the document carries no payment prompt at all, which is the right answer for a receipt,
 * a void, an unlocked invoice and a £0 document.
 */
export type PayOnline = { url: string; qrPng: Buffer | null; marks: string | null };

function InvoicePdf({ doc, logo, pay }: { doc: InvoiceDoc; logo: Buffer | null; pay: PayOnline | null }) {
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
        {doc.status === 'void' ? <Text style={S.voidMark} fixed>{t('voidWatermark')}</Text> : null}
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
            {doc.status === 'void' ? <Text style={S.badge}>{t('voidBadge')}</Text> : null}
          </View>
        </View>

        {/* ── AMENDED AFTER ISSUE ────────────────────────────────────────────────────────────
            The invoice keeps its NUMBER through a correction, so the customer can be holding two
            documents with the same reference and different totals. This line is what tells them
            which one they are looking at, and it is the piece of friction the ruling deliberately
            keeps: it protects the garage in a dispute far more than it costs them.
            Deliberately on the face of the document, not in the footer. */}
        {doc.amendedAt ? (
          <View style={S.voidNote}>
            <Text>{t('amendedNotice', {
              when: new Date(doc.amendedAt).toLocaleDateString(doc.locale),
              from: doc.amendedFromPennies == null ? '—' : fmt(doc.amendedFromPennies),
            })}</Text>
            {doc.amendmentCount > 1 ? (
              <Text style={{ marginTop: 4, fontSize: 8 }}>{t('amendedCount', { n: doc.amendmentCount })}</Text>
            ) : null}
          </View>
        ) : null}
        {/* THE REASON, on the face of the document. The watermark says it is void; this says why,
            which is the half VATREC5010 actually asks for. */}
        {doc.status === 'void' ? (
          <View style={S.voidNote}>
            <Text>{t('voidNotice', {
              when: doc.voidedAt ? doc.voidedAt.toLocaleDateString(doc.locale) : '—',
              reason: doc.voidReason || t('voidNoReason'),
            })}</Text>
            {/* AMENDED REASONS SHOW BOTH. The retained document must not present a tidied-up
                explanation as if it were the one recorded at the time. */}
            {doc.voidReasonOriginal ? (
              <Text style={{ marginTop: 4, fontSize: 8 }}>
                {t('voidAmended', {
                  when: doc.voidAmendedAt ? new Date(doc.voidAmendedAt).toLocaleDateString(doc.locale) : '—',
                  original: doc.voidReasonOriginal,
                })}
              </Text>
            ) : null}
          </View>
        ) : null}

        <View style={S.partiesRow}>
          <View style={{ maxWidth: 260 }}>
            <Text style={S.label}>{t('billTo')}</Text>
            <Text>{doc.addressee.name}</Text>
            {doc.addressee.address ? <Text style={S.muted}>{doc.addressee.address}</Text> : null}
            {/* WHOSE CAR IT WAS. Only when the bill is not theirs — an accounts department paying
                for a fleet cannot attribute a bill it cannot tie to an employee. */}
            {doc.addressee.onBehalfOf ? <Text style={S.muted}>{t('billForCustomer', { name: doc.addressee.onBehalfOf })}</Text> : null}
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
                {showVatTotalLine(doc.totals) && (
                  <View style={S.totalRow}><Text style={S.muted}>{t('totalVat', { label: doc.taxLabel })}</Text><Text>{fmt(doc.totals.vatPennies)}</Text></View>
                )}
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
            {/* Beside the figure, where the eye already is. Only when there is something to pay:
                offersPayLink has already refused receipts, voids and unlocked documents, so the
                presence of a link IS the permission to say this. */}
            {pay ? <Text style={S.payInline}>{t('payOnline')}</Text> : null}
          </View>
        </View>

        {/* ── ADVISORY, BELOW THE TOTAL ─────────────────────────────────────────────────────────
            NOTHING ABOVE THE TOTAL EXCEPT WHAT IS BEING CHARGED FOR. This block used to sit above
            the line items, where an advisory sits adjacent to priced rows and can read as one —
            "front discs due at 60,000 miles" a few lines above a figure invites exactly the wrong
            inference. Below the total, under a heading that says it is not charged for, it cannot.

            ── AND WHY MOVING IT IS NOT A BREACH OF FREEZE-AT-ISSUE ────────────────────────────
            FREEZE-AT-ISSUE GOVERNS CONTENT, NOT LAYOUT. What must never change is what the
            customer was TOLD: the figures, the particulars, the advice itself — and none of that
            moves here. `due_items_snapshot` is the frozen artefact and it is untouched; only where
            the renderer puts it changes.

            The retrospective effect is an IMPROVEMENT rather than a liberty: a reprint of an older
            invoice now shows the same advice where it can no longer be mistaken for a charge. A
            document that says the same thing more clearly has not lied about its past.

            Deliberately NOT frozen as a layout version on the row. That column would accumulate
            variants forever to protect something nobody is harmed by. */}
        {/* WHAT WAS SORTED COMES FIRST. A customer reading "coolant below the minimum mark" wants
            to know it was dealt with before they read what is still outstanding — and until today
            the top-up printed as an advisory on the very invoice for the visit that fixed it. */}
        {doc.workDoneBlock ? (
          <View style={{ marginTop: 14 }}>
            <Text style={[S.label, { marginBottom: 3 }]}>{t('workDone.heading')}</Text>
            {doc.workDoneBlock.split('\n').map((line, i) => (
              <Text key={i} style={S.muted}>{line}</Text>
            ))}
          </View>
        ) : null}

        {/* ── THE OLD SHAPE, RENDERED AS IT WAS ISSUED ──────────────────────────────────────
            A document minted before 21 Aug 2026 holds all three categories in one list under one
            heading. Freeze-at-issue governs CONTENT, so it keeps both its text and the heading it
            was issued with — relabelling it "What your car needs" would put tread depths under a
            heading that does not describe them, on a document a customer already has. */}
        {doc.combinedBlocks ? (
          <View style={{ marginTop: 14 }}>
            <Text style={[S.label, { marginBottom: 3 }]}>{t('advisory.heading')}</Text>
            {(doc.dueItemsBlock ?? '').split('\n').map((line, i) => (
              <Text key={i} style={S.muted}>{line}</Text>
            ))}
          </View>
        ) : (
          <>
            {doc.dueItemsBlock ? (
              <View style={{ marginTop: 14 }}>
                <Text style={[S.label, { marginBottom: 3 }]}>{t('needs.heading')}</Text>
                {doc.dueItemsBlock.split('\n').map((line, i) => (
                  <Text key={i} style={S.muted}>{line}</Text>
                ))}
              </View>
            ) : null}
            {doc.measuredBlock ? (
              <View style={{ marginTop: 14 }}>
                <Text style={[S.label, { marginBottom: 3 }]}>{t('measured.heading')}</Text>
                {doc.measuredBlock.split('\n').map((line, i) => (
                  <Text key={i} style={S.muted}>{line}</Text>
                ))}
              </View>
            ) : null}
          </>
        )}

        {doc.footerText ? (
          // Payment terms / footer block (Invoicing tab) — multi-line, verbatim.
          <Text style={[S.muted, { marginTop: 18, fontSize: 8, lineHeight: 1.5 }]}>{doc.footerText}</Text>
        ) : null}

        {!reg && !warranty ? <Text style={[S.muted, { marginTop: 12 }]}>{t('notRegistered', { label: doc.taxLabel })}</Text> : null}

        {/* ── THE RUNNING FOOTER IS DECLARED BEFORE THE PAY BLOCK, ON PURPOSE ──────────────────
            It is absolutely positioned, so its place in this file changes nothing visually — but
            it DOES change the order of text runs in the content stream, and that is the whole
            fix below. Do not move it back under the pay block. */}
        {/* TWO LINES, ONE FIXED BLOCK. The first is the RUNNING IDENTIFICATION and is not
            decoration: on page 3 of a long invoice it is the only thing saying whose document
            this is and which one. The second is the maker's mark (lib/product-credit).

            A <Link>, not a <Text>: react-pdf links carry an annotation URI, so a click never
            depends on the text layer — which matters here for the reason documented below the pay
            block. Adjacent text runs are emitted with no separator, so a selection starting at
            greasedesk.com would run on into whatever follows. The annotation sidesteps it, and the
            pay URL keeps its place as the last text on the page. */}
        <View style={S.footer} fixed>
          <Text>{doc.company.name} — {t('title')} {doc.number}</Text>
          <Link src={CREDIT_HREF} style={S.credit}>{CREDIT_LINE}</Link>
        </View>

        {/* THE PAY BLOCK, LAST. For someone holding a printed copy: a URL they must retype is a
            URL they will not use, so the QR carries the same link the email button does.
            Marks come from the garage's real capabilities, never a fixed set.

            ── WHY THE URL IS THE LAST TEXT ON THE PAGE ──────────────────────────────────────
            react-pdf emits sibling <Text> blocks as ADJACENT runs with no end-of-line marker and
            strips every whitespace-only or edge-whitespace run, so nothing can be inserted between
            them. Selecting the URL therefore copied straight on into whatever followed it: the
            first real QR test yielded ".../c/9HdTuMm5S0U4f4p-Visa", which 404s, while the page
            LOOKED perfect. Five separator strategies were measured — trailing space, leading space,
            a space-only Text, an embedded newline, reordering within the block — and every one was
            stripped. The only thing that works is having nothing follow the URL at all, which is
            why the marks are printed ABOVE it and the running footer is declared above too.

            <Link> on top of that: clicking uses the annotation URI and bypasses the text layer
            entirely, so a digital reader never depends on selection being clean. */}
        {pay ? (
          <View style={S.payBlock}>
            {pay.qrPng ? <Image style={S.payQr} src={{ data: pay.qrPng, format: 'png' }} /> : null}
            <View style={{ flex: 1 }}>
              <Text style={S.payHead}>{t('payOnline')}</Text>
              {pay.marks ? <Text style={S.payMarks}>{pay.marks}</Text> : null}
              <Link src={pay.url} style={S.payUrl}>{pay.url}</Link>
            </View>
          </View>
        ) : null}
      </Page>
    </Document>
  );
}

export async function renderInvoicePdf(doc: InvoiceDoc, pay: PayOnline | null = null): Promise<Buffer> {
  let logo: Buffer | null = null;
  if (doc.logoUrl) {
    try {
      const r = await fetch(doc.logoUrl);
      if (r.ok) logo = Buffer.from(await r.arrayBuffer());
    } catch { /* logo is decoration — never fail the document for it */ }
  }
  return await renderToBuffer(<InvoicePdf doc={doc} logo={logo} pay={pay} />);
}
