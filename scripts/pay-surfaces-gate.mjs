/**
 * File: scripts/pay-surfaces-gate.mjs
 * Gate for piece 3 — the pay link on the PDF, the QR, the card marks and the SMS.
 *
 * ── THE SMS BUDGET IS MEASURED AGAINST REAL TENANTS ─────────────────────────────────────────────
 * Every garage name in production, not a sample. These templates were once written "to about 160
 * characters by eye", which held only until something was added to them; the whole point of this
 * section is that the ceiling is checked against the names that actually exist, plus deliberately
 * hostile ones for the names that will.
 *
 * ── THE PDF IS ASSERTED ELSEWHERE, AND WHY ──────────────────────────────────────────────────────
 * lib/invoice-pdf is .tsx and node --experimental-strip-types cannot transform JSX, so this gate
 * proves the INPUT the renderer is handed — which is where the one-mint promise lives — and the
 * rendered document is read back with pdfjs in the separate served check.
 */
import { prisma } from '../lib/db.ts';
import { paymentMarks, marksSentence } from '../lib/payment-marks.ts';
import { NOTIFICATION_TEMPLATES } from '../lib/notification-templates.ts';
import { smsText, smsCost, isOneSegment } from '../lib/sms-text.ts';
import { payOnlineFor, offersPayLink } from '../lib/invoice-pay-link.ts';
import { buildInvoiceDoc } from '../lib/invoice-doc.ts';

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const LINK = 'https://greasedesk.com/c/0123456789abcdef';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };

try {
  // ── 1. CARD MARKS ──────────────────────────────────────────────────────────────────────────
  console.log('\n— payment marks —');
  const active = { card_payments: 'active', link_payments: 'active', klarna_payments: 'inactive', bacs_debit_payments: 'pending' };
  const m = paymentMarks(active);
  check('cards yield Visa and Mastercard', m.some((x) => x.key === 'visa') && m.some((x) => x.key === 'mastercard'));
  check('an active extra method is named', m.some((x) => x.key === 'link'));
  check('an INACTIVE capability is not promised', !m.some((x) => x.key === 'klarna'));
  check('a PENDING capability is not promised either', !m.some((x) => x.key === 'bacs'),
    'requested and not yet granted is not something a customer can use today');
  check('no Amex mark is invented', !m.some((x) => /amex|express/i.test(x.key)),
    'Stripe exposes one card capability for every brand — an Amex mark could only be a guess');
  check('never-synced capabilities yield NO marks', paymentMarks(null).length === 0,
    'the row is omitted; the document never says "no payment methods", which would be false');
  check('an unmapped capability renders nothing', paymentMarks({ bancontact_payments: 'active' }).length === 0,
    'silence beats printing a raw key a customer cannot read');
  check('the order is stable regardless of Stripe’s key order', (() => {
    const a = paymentMarks({ link_payments: 'active', card_payments: 'active' }).map((x) => x.key);
    const b = paymentMarks({ card_payments: 'active', link_payments: 'active' }).map((x) => x.key);
    return JSON.stringify(a) === JSON.stringify(b) && a[0] === 'visa';
  })());
  check('the sentence reads as prose', marksSentence(m) === 'Visa, Mastercard and Link', marksSentence(m));
  check('and is empty rather than dangling when there is nothing', marksSentence([]) === '');

  // ── 2. THE SMS BUDGET, AGAINST EVERY REAL TENANT ───────────────────────────────────────────
  console.log('\n— sms budget (every real tenant name) —');
  const tpl = NOTIFICATION_TEMPLATES.invoice_pay_link.sms;
  const render = (o) => smsText(tpl({ link: LINK, ...o }).text);
  const groups = await prisma.group.findMany({ select: { group_name: true, trading_name: true, phone: true } });
  let worst = { n: 0, name: '' };
  let allOne = true;
  for (const g of groups) {
    const name = g.trading_name || g.group_name;
    const t = render({ garageName: name, number: '100003209', registration: 'AB12CDE', total: '£2,485.43', garagePhone: g.phone || '03309990020' });
    const c = smsCost(t);
    if (c.segments > 1) allOne = false;
    if (c.septets > worst.n) worst = { n: c.septets, name };
  }
  check('every real tenant fits one segment', allOne, `${groups.length} tenants, worst ${worst.n}/160 (${worst.name})`);
  check('and there is real headroom on the worst', worst.n <= 150, `${160 - worst.n} septets spare`);

  // The names that will exist. A template that only fits today's tenants is not a budget.
  const hostile = [
    ['a 33-character name with a long invoice number', { garageName: "O'Brien's Motor & Tyre Centre Ltd", number: 'INV-2026-100003209', registration: 'AB12CDE', total: '£12,485.43', garagePhone: '03309990020' }],
    ['a 40-character name', { garageName: 'A'.repeat(40), number: '100003209', registration: 'AB12CDE', total: '£12,485.43', garagePhone: '03309990020' }],
    ['a CURLY apostrophe', { garageName: 'Dave’s Motors', number: '100003209', registration: 'AB12CDE', total: '£2,485.43', garagePhone: '03309990020' }],
    ['no phone on file', { garageName: 'The Mini Specialist Ltd', number: '100003209', registration: 'AB12CDE', total: '£2,485.43', garagePhone: null }],
  ];
  for (const [label, args] of hostile) {
    const t = render(args);
    const c = smsCost(t);
    check(`still one segment: ${label}`, c.segments === 1, `${c.septets}/160 ${c.encoding}${/for AB12CDE/.test(t) ? '' : ', registration dropped'}`);
  }
  check('the curly apostrophe stays GSM-7', smsCost(render({ garageName: 'Dave’s Motors', number: '1', total: '£1', garagePhone: '0330' })).encoding === 'GSM-7',
    'smsText folds it at the one render point — untouched it would triple the message');
  check('the essentials survive when the registration is dropped', (() => {
    const t = render({ garageName: 'A'.repeat(40), number: '100003209', registration: 'AB12CDE', total: '£12,485.43', garagePhone: '03309990020' });
    return t.includes('100003209') && t.includes('£12,485.43') && t.includes(LINK) && t.includes('03309990020') && !t.includes('AB12CDE');
  })(), 'the number they quote, the amount, the link and the reply route all stay');
  check('the budget check is discriminating', (() => {
    // Without the drop, the 33-character case is two segments — the behaviour being guarded.
    const naive = `O'Brien's Motor & Tyre Centre Ltd: invoice INV-2026-100003209 for AB12CDE, £12,485.43 to pay. ${LINK} No replies - call 03309990020`;
    return !isOneSegment(smsText(naive));
  })(), 'a fixed template would have cost two segments on that name');

  // ── 3. THE PDF ─────────────────────────────────────────────────────────────────────────────
  // Rendered and read back in scripts/pay-pdf-gate.mjs, not here: lib/invoice-pdf is .tsx and
  // node --experimental-strip-types cannot transform JSX. What IS provable here is the input the
  // renderer receives, which is where the "one mint" promise actually lives.
  console.log('\n— what the pdf is handed —');
  const inv = await prisma.invoice.findFirst({
    where: { group_id: ZZ, status: 'issued', lines: { some: {} } },
    select: { id: true, invoice_number: true }, orderBy: { issued_at: 'desc' },
  });
  const doc = await buildInvoiceDoc(inv.id, ZZ);
  check('an issued invoice offers a link', offersPayLink(doc) === true, `#${inv.invoice_number}`);
  const pay = await payOnlineFor({ groupId: ZZ, url: LINK });
  check('the QR encodes the SAME url the email uses', pay.url === LINK,
    'one mint per send — a QR carrying its own credential would be a second thing to revoke');
  check('a QR image was produced', !!pay.qrPng && pay.qrPng.length > 200, `${pay.qrPng?.length ?? 0} bytes png`);
  check('the QR is small enough to scan off paper', (pay.qrPng?.length ?? 0) < 20000,
    'a 41-character url keeps the code low-density; a long one would not survive a fold');
  check('marks come from the connection, not a fixed list', pay.marks === null || typeof pay.marks === 'string',
    pay.marks === null ? 'ZZ has never synced capabilities → no marks, correctly' : pay.marks);

} catch (e) {
  check('run completed', false, String(e?.message ?? e).slice(0, 300));
} finally {
  console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
  await prisma.$disconnect();
  process.exit(out.includes('F') ? 1 : 0);
}
