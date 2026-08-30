/**
 * File: scripts/refund-surfaces-gate.mjs
 * The garage sees what the customer sees — in the same words, not a paraphrase.
 *
 * ── THE ASSERTION THAT MATTERS ──────────────────────────────────────────────────────────────────
 * Not "both surfaces mention a refund". BYTE-IDENTICAL text, pulled from the two rendered pages and
 * compared. When a customer rings quoting their link, the person answering must be reading the same
 * sentence back — "refunded in full" versus "£50 returned" turns the call into establishing whether
 * the two of you are even looking at the same thing.
 *
 * That is only achievable because the COPY is shared (lib/invoice-refund-state::refundLines), not
 * just the state. Sharing RefundState alone would still let four surfaces word it four ways.
 *
 * ── FIXTURES ────────────────────────────────────────────────────────────────────────────────────
 * ZZ only. A pay link is minted while the invoice is still open (offersPayLink refuses a refunded
 * one — correctly), then paid and refunded, which is the real sequence. Everything is removed and
 * the invoice cache is CAPTURED AND RESTORED, never recomputed.
 */
import './_gate-preflight.mjs';
const { serverReady, describeError } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { prisma } = await import('../lib/db.ts');
const { refundLines, refundState } = await import('../lib/invoice-refund-state.ts');
const { buildInvoiceDoc } = await import('../lib/invoice-doc.ts');
const { mintInvoicePayLink } = await import('../lib/invoice-pay-link.ts');
const { reconcileInvoice } = await import('../lib/payments.ts');
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
// PORT 3000, the port `npm run dev` uses. This defaulted to 3111 — not a decision, just whatever
// the author had running that afternoon. Six gates carried defaults like it, so six gates skipped
// on every machine but one; both of the two tested pass unchanged against 3000. GATE_BASE still
// overrides, which is what a genuinely different server is for.
const B = process.env.GATE_BASE ?? 'http://localhost:3000';
const MARK = 're_surf_';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };

let invId = null, cacheBefore, payId = null, linkId = null, browser = null;
const madeRefunds = [];
try {
  if (await prisma.refund.count({ where: { refund_id: { startsWith: MARK } } })) throw new Error('REFUSING: leftovers');

  // ── 1. ONE FORMATTER, SO THE DATE CANNOT DIVERGE ───────────────────────────────────────────
  console.log('\n— the shared copy —');
  const s = refundState({ receivedPennies: 5000, refunds: [{ amount_pennies: 5000, collected_at: new Date('2026-08-16T23:40:00Z') }] });
  const a = refundLines(s, { money: (p) => `£${(p / 100).toFixed(2)}`, locale: 'en-GB' });
  const b = refundLines(s, { money: (p) => `£${(p / 100).toFixed(2)}`, locale: 'en-GB' });
  check('the same state yields the same sentences', a.headline === b.headline && a.detail === b.detail);
  check('a late-evening refund does not drift a day', /16 August 2026/.test(a.headline),
    'the date is formatted INSIDE refundLines, in UTC — the customer page used to format without a timeZone and the admin page with one');
  check('the wording is audience-neutral', !/your statement/i.test(a.detail) && /a bank statement/.test(a.detail),
    '"your statement" is wrong on the garage screen; forking the wording would lose the guarantee');
  check('none yields nothing at all', refundLines(refundState({ receivedPennies: 100, refunds: [] }), { money: (p) => `${p}`, locale: 'en-GB' }) === null);

  // ── 2. SET UP A REAL REFUNDED INVOICE ──────────────────────────────────────────────────────
  const inv = await prisma.invoice.findFirst({
    where: { group_id: ZZ, status: 'issued', series: 'chargeable', lines: { some: {} } },
    select: { id: true, site_id: true, job_card_id: true }, orderBy: { created_at: 'desc' },
  });
  if (!inv) throw new Error('no open ZZ invoice');
  invId = inv.id;
  cacheBefore = (await prisma.invoice.findUnique({ where: { id: invId }, select: { amount_paid_pennies: true } })).amount_paid_pennies;

  const doc0 = await buildInvoiceDoc(invId, ZZ);
  const link = await mintInvoicePayLink({ doc: doc0, groupId: ZZ, recipient: 'gate', createdByUserId: null });
  if (!link) throw new Error('link refused');
  linkId = link.id;
  const gross = doc0.vatRegistered ? doc0.totals.grossPennies : doc0.totals.netPennies;

  payId = (await prisma.payment.create({
    data: { group_id: ZZ, invoice_id: invId, site_id: inv.site_id, provider: 'stripe', status: 'succeeded',
      amount_pennies: gross, currency: 'GBP', source_ref: `${MARK}pi`, collected_at: new Date() },
    select: { id: true },
  })).id;
  await prisma.$transaction(async (tx) => { await reconcileInvoice(tx, invId); });

  const addRefund = async (id, amount) => {
    await prisma.$transaction(async (tx) => {
      await tx.refund.create({ data: { group_id: ZZ, payment_id: payId, amount_pennies: amount, currency: 'GBP', refund_id: id, source_ref: id, collected_at: new Date() } });
      await reconcileInvoice(tx, invId);
    });
    madeRefunds.push(id);
  };

  // The dev server disposes inactive pages and serves 404s while it rebuilds one; a gate that
  // drives a page that was never served dies as a bare selector timeout 25s later. Warm it and
  // say so — see serverReady in _gate-preflight.
  const ready = await serverReady();
  check('the dev server serves pages before we drive it', ready.ok, `HTTP ${ready.status} after ${ready.attempts} attempt(s)`);
  browser = await chromium.launch({ channel: 'chrome' });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  // Garage side needs a session; ZZ's owner is the gate account used across the suite.
  await page.goto(`${B}/admin/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', 'owner@zzgategarage.test');
  await page.fill('input[type="password"]', 'GateGarage!2026');
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }), page.click('button[type="submit"]')]);

  const cust = await ctx.newPage();
  const custUrl = link.url.replace(/^https?:\/\/[^/]+/, B);
  const textOf = async (p, id) => (await p.locator(`[data-testid="${id}"]`).count())
    ? (await p.locator(`[data-testid="${id}"]`).first().innerText()).trim() : null;

  for (const [label, amount] of [['PARTIAL', Math.floor(gross / 3)], ['FULL', gross - Math.floor(gross / 3)]]) {
    await addRefund(`${MARK}${label}`, amount);
    console.log(`\n— ${label} refund, on both screens —`);

    await cust.goto(custUrl, { waitUntil: 'domcontentloaded' });
    await cust.waitForSelector('[data-testid="refund-headline"]', { timeout: 25000 });
    const cH = await textOf(cust, 'refund-headline'), cD = await textOf(cust, 'refund-detail');

    await page.goto(`${B}/admin/invoices/${invId}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="admin-refund-state"]', { timeout: 25000 });
    const gH = await textOf(page, 'refund-headline'), gD = await textOf(page, 'refund-detail');

    check(`${label}: the customer is told something`, !!cH, cH);
    check(`${label}: the garage is told something`, !!gH, gH);
    // THE POINT OF THE WHOLE SLICE.
    check(`${label}: the HEADLINES are byte-identical`, cH === gH,
      cH === gH ? 'the same sentence, not a paraphrase' : `customer: ${JSON.stringify(cH)} / garage: ${JSON.stringify(gH)}`);
    check(`${label}: the DETAIL lines are byte-identical`, cD === gD,
      cD === gD ? '' : `customer: ${JSON.stringify(cD)} / garage: ${JSON.stringify(gD)}`);

    // And the badge does not still say "Paid".
    const badge = await textOf(page, 'detail-status-badge');
    check(`${label}: the garage badge stops saying Paid`, badge !== 'Paid' && /Refund/i.test(badge ?? ''), badge);
  }

  // ── 3. THE JOB CARD AND THE LIST SAY IT TOO ────────────────────────────────────────────────
  console.log('\n— the other two surfaces —');
  await page.goto(`${B}/admin/jobcards/${inv.job_card_id}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Invoice', exact: false }).first().click().catch(() => {});
  await page.waitForSelector('[data-testid="card-refund-state"]', { timeout: 25000 }).catch(() => {});
  const cardH = await textOf(page, 'refund-headline');
  check('the job card shows the SAME headline', cardH === (await (async () => {
    const d = await buildInvoiceDoc(invId, ZZ);
    return refundLines(d.refund, { money: (p) => new Intl.NumberFormat(d.locale, { style: 'currency', currency: d.currency }).format(p / 100), locale: d.locale }).headline;
  })()), cardH);

  // ONE read of the body. The first version called r.json() twice — a Response can only be read
  // once, so the fallback silently produced undefined and the row was "not found".
  const payload = await page.evaluate(async (b) => {
    const r = await fetch(`${b}/api/invoices?status=all&q=`, { cache: 'no-store' });
    return r.json();
  }, B).catch(() => null);
  const listRows = Array.isArray(payload) ? payload : (payload?.rows ?? payload?.invoices ?? null);
  const listRow = Array.isArray(listRows) ? listRows.find((x) => x.id === invId) : null;
  check('the list reports the refund kind', listRow ? listRow.refundKind === 'full' : false,
    listRow ? `refundKind=${listRow.refundKind}` : 'row not found in the list payload');
} catch (e) {
  check('run completed', false, describeError(e).slice(0, 300));
} finally {
  await browser?.close().catch(() => {});
  if (madeRefunds.length) {
    const d = await prisma.refund.deleteMany({ where: { refund_id: { in: madeRefunds } } });
    check('teardown removed the fixture refunds', d.count === madeRefunds.length, `${d.count} of ${madeRefunds.length}`);
  }
  if (payId) await prisma.payment.delete({ where: { id: payId } }).catch(() => {});
  if (linkId) await prisma.customerMagicLink.deleteMany({ where: { id: linkId } });
  if (invId) {
    await prisma.invoice.update({ where: { id: invId }, data: { amount_paid_pennies: cacheBefore ?? null } });
    const now = (await prisma.invoice.findUnique({ where: { id: invId }, select: { amount_paid_pennies: true } })).amount_paid_pennies;
    check('teardown restored the invoice cache exactly', now === (cacheBefore ?? null), `${JSON.stringify(cacheBefore)} → ${JSON.stringify(now)}`);
  }
  check('no fixture row survives', (await prisma.refund.count({ where: { refund_id: { startsWith: MARK } } })) === 0
    && (await prisma.payment.count({ where: { source_ref: { startsWith: MARK } } })) === 0);
  console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
  await prisma.$disconnect();
  process.exit(out.includes('F') ? 1 : 0);
}
