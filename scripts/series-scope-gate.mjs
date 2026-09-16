/**
 * File: scripts/series-scope-gate.mjs
 * @gate-requires: db, server
 *
 * WHICH INVOICES COUNT — one rule per question, every series stated, and nobody spelling it again.
 *
 * ── WHAT THIS IS FOR ────────────────────────────────────────────────────────────────────────────
 * `series: 'chargeable'` was written thirteen times in thirteen files. A fourth series (a car sold
 * out of stock) needs three different answers — it IS a debt, is NOT workshop revenue, and counts
 * for VAT only when qualifying — and thirteen copies of one literal could not say that. Two gave the
 * wrong answer on the first sale; lib/credit-note.ts had predicted it in a comment.
 *
 * ── THREE KINDS OF CLAUSE ───────────────────────────────────────────────────────────────────────
 *  · each rule states EVERY series, and the rules that must disagree DO — the failure mode is two
 *    identical-looking rules being "tidied" into one, which is right until the day it is not
 *  · no series literal remains outside the module unless DECLARED here with what it is. Enumerated
 *    from the source, both ways: a new literal fails, and so does a declaration for one that has gone
 *  · on real invoices: a sale is owed, a retail buyer is never overdue and an account buyer can be,
 *    and a tile and the list it opens still agree once the list is scoped
 *
 * FIXTURES ON ZZ ONLY, prefix ZZSS, swept before and after.
 */
import './_gate-preflight.mjs';
const { gatePrisma, describeError, ZZ_GROUP, gateOrigin, serverReady } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');
const { readFileSync, readdirSync, statSync } = await import('node:fs');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const R = '/Users/hugh/Developer/greasedesk-core';
const PREFIX = 'ZZSS';
const SC = await import(`${R}/lib/invoice-series-scope.ts`);
const NUM = await import(`${R}/lib/invoice-number.ts`);

let prisma;
let browser = null;
try {
  // ════════════════════════════════════════════════════════════════════════════════════════════
  console.log('— EVERY RULE STATES EVERY SERIES —');
  const series = [...NUM.INVOICE_SERIES].sort();
  for (const [name, rule] of Object.entries(SC.SERIES_RULES)) {
    check(`${name} names all ${series.length} series`, JSON.stringify(Object.keys(rule).sort()) === JSON.stringify(series),
      Object.entries(rule).map(([k, v]) => `${k}=${v ? 'in' : 'out'}`).join(' '));
  }

  console.log('\n— THE ANSWERS, AS RULED —');
  const RULED = {
    IS_DEBT: { chargeable: true, warranty: false, historical: false, vehicle_sale: true },
    IN_ISSUED_LIST: { chargeable: true, warranty: false, historical: false, vehicle_sale: true },
    IN_WORKSHOP_TAKINGS: { chargeable: true, warranty: false, historical: false, vehicle_sale: false },
    IN_WORKSHOP_LEDGER: { chargeable: true, warranty: true, historical: true, vehicle_sale: false },
    USES_CHARGEABLE_COUNTER: { chargeable: true, warranty: false, historical: false, vehicle_sale: false },
    TRACKS_AGREED_QUOTE: { chargeable: true, warranty: false, historical: false, vehicle_sale: false },
  };
  check('every rule is pinned here, and nothing is pinned that is not a rule',
    JSON.stringify(Object.keys(RULED).sort()) === JSON.stringify(Object.keys(SC.SERIES_RULES).sort()));
  for (const [name, want] of Object.entries(RULED)) {
    const got = SC.SERIES_RULES[name] ?? {};
    const diff = Object.keys(want).filter((k) => got[k] !== want[k]);
    check(`${name} gives the ruled answer for every series`, diff.length === 0, diff.length ? `differs on ${diff.join(', ')}` : 'as ruled');
  }

  /**
   * THE CLAUSE AGAINST TIDYING. Rules that genuinely differ look alike on most series; merging two of
   * them is right on the day it is done and wrong the first time they part. These must stay apart.
   */
  console.log('\n— THE RULES THAT MUST DISAGREE, DO —');
  check('a car sale is a DEBT but not workshop TAKINGS', SC.IS_DEBT.vehicle_sale === true && SC.IN_WORKSHOP_TAKINGS.vehicle_sale === false,
    'a sold car not yet paid for is owed, and is not workshop revenue');
  check('  …a DEBT but not in the workshop LEDGER', SC.IS_DEBT.vehicle_sale === true && SC.IN_WORKSHOP_LEDGER.vehicle_sale === false);
  check('warranty is in the LEDGER but not in TAKINGS', SC.IN_WORKSHOP_LEDGER.warranty === true && SC.IN_WORKSHOP_TAKINGS.warranty === false,
    'its parts cost is real drag; it takes no money');

  console.log('\n— THE HELPERS FAIL CLOSED —');
  check('an unknown series string is never counted', SC.allows(SC.IS_DEBT, 'part_exchange') === false && SC.allows(SC.IS_DEBT, undefined) === false && SC.allows(SC.IS_DEBT, 'toString') === false);
  check('  …while a known one is', SC.allows(SC.IS_DEBT, 'vehicle_sale') === true);
  check('the where fragment is exactly the included series', JSON.stringify(SC.seriesWhere(SC.IS_DEBT).series.in.sort()) === JSON.stringify(['chargeable', 'vehicle_sale']));

  // ════════════════════════════════════════════════════════════════════════════════════════════
  console.log('\n— NOBODY SPELLS IT AGAIN —');
  /**
   * ENUMERATED FROM THE SOURCE TREE, not from a list of files I remembered — the completeness rule.
   * Read as text (a NUL byte makes grep print nothing), comments stripped (a note naming a series is
   * not a filter). Keyed by file and matched text, not line numbers, which move.
   */
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => '\n'.repeat((m.match(/\n/g) ?? []).length)).replace(/^\s*\/\/.*$/gm, '');
  // @anchored-ok: a SOURCE-CODE pattern — it finds series literals written in TypeScript files, it is not a key looked up in data
  const LIT = /series\s*:\s*'(chargeable|warranty|historical|vehicle_sale)'|series\s*[!=]==?\s*'(chargeable|warranty|historical|vehicle_sale)'/g;
  const walk = (d) => readdirSync(d).flatMap((f) => { const p = `${d}/${f}`; return statSync(p).isDirectory() ? walk(p) : [p]; });
  const found = new Map();
  for (const root of ['lib', 'pages', 'components']) {
    for (const abs of walk(`${R}/${root}`)) {
      // @anchored-ok: a REPO FILESYSTEM path in the tree walk, not a URL or an API route
      if (!/\.(ts|tsx)$/.test(abs) || abs.includes('/lib/demo/') || abs.endsWith('lib/invoice-series-scope.ts')) continue;
      const rel = abs.slice(R.length + 1);
      for (const m of strip(readFileSync(abs, 'utf8')).matchAll(LIT)) {
        const key = `${rel} | ${m[0].replace(/\s+/g, ' ')}`;
        found.set(key, (found.get(key) ?? 0) + 1);
      }
    }
  }
  /**
   * WHAT EACH REMAINING LITERAL IS. Four kinds only:
   *   KIND  — asks whether a document IS one particular series (warranty settles at £0, historical is
   *           a record); an identity, not a question of which invoices count. Each was checked for
   *           what it answers for a car sale, and that answer is written beside it.
   *   TYPE  — a TypeScript union, not a filter.
   *   DATA  — a value written into an audit row.
   *   LATER — a scope question that moves into the module in a named later step.
   */
  const DECLARED = {
    'lib/charged-labour.ts | series === \'warranty\'': [2, 'KIND — warranty revenue is £0 and its hours are rework; a car sale is already outside this ledger'],
    'lib/invoice-payment-intent.ts | series === \'warranty\'': [1, 'KIND — warranty is not payable by card; a car sale is a debt and IS payable'],
    'lib/invoice-pay-link.ts | series === \'warranty\'': [1, 'KIND — as above: no pay link on warranty; a car sale gets one'],
    'lib/historical-invoice.ts | series !== \'historical\'': [1, 'KIND — the refusal applies only to historical records'],
    'lib/dashboard-tiles.ts | series: \'warranty\'': [1, 'KIND — the warranty tile counts warranty invoices by definition'],
    'lib/invoice-doc.ts | series: \'chargeable\'': [1, 'TYPE — the document’s series union'],
    'lib/invoice-pdf.tsx | series === \'warranty\'': [2, 'KIND — the warranty badge and £0 layout; a car sale uses lib/margin-scheme instead'],
    'lib/credit-note.ts | series === \'chargeable\'': [1, 'LATER — declared-supply rule moves into the module in step 4 (credit notes)'],
    'lib/invoice-list-filters.ts | series: \'warranty\'': [1, 'KIND — the list filter NAMED warranty'],
    'lib/invoice-list-filters.ts | series: \'historical\'': [1, 'KIND — the list filter NAMED historical'],
    // The invoice query's literal went in step 3 (VAT_RETURN_TREATMENT decides every invoice now); this one
    // joins CREDIT NOTES to the invoices they correct, and moves with credit notes in step 4.
    'lib/vat-summary.ts | series: \'chargeable\'': [1, 'LATER — the credit-note join; moves with credit notes in step 4'],
    'lib/invoice-issue.ts | series: \'chargeable\'': [2, 'KIND — the chargeable mint naming the series it is about to issue; and a parameter TYPE'],
    'lib/invoice-issue.ts | series === \'warranty\'': [1, 'KIND — the warranty goodwill freeze; a car sale freezes its one line like chargeable work'],
    'pages/admin/settings/invoicing.tsx | series: \'warranty\'': [1, 'KIND — has the WARRANTY counter been used'],
    'pages/admin/invoices/index.tsx | series: \'chargeable\'': [1, 'TYPE — the row’s series union'],
    'pages/admin/invoices/index.tsx | series === \'warranty\'': [1, 'KIND — the warranty chip'],
    'pages/admin/invoices/index.tsx | series === \'historical\'': [1, 'KIND — the historical chip'],
    'pages/admin/invoices/index.tsx | series !== \'historical\'': [1, 'KIND — a historical record is never re-sent; a car sale can be'],
    'pages/admin/invoices/[id].tsx | series: \'chargeable\'': [1, 'TYPE — the page props’ series union'],
    'pages/admin/invoices/[id].tsx | series !== \'warranty\'': [3, 'KIND — warranty’s £0 presentation; a car sale presents through lib/margin-scheme'],
    'pages/admin/invoices/[id].tsx | series !== \'historical\'': [2, 'KIND — no unmark/void actions on a historical record; a car sale has them'],
    'pages/admin/invoices/[id].tsx | series === \'warranty\'': [2, 'KIND — the warranty banner and amount-due block'],
    'pages/admin/invoices/[id].tsx | series !== \'vehicle_sale\'': [1, 'KIND — a car sale is dated by the sale, so the issue-date editor is not offered'],
    'pages/admin/invoices/[id].tsx | series === \'vehicle_sale\'': [1, 'KIND — and the page says why, in its place'],
    'pages/api/invoice-date-issued.ts | series === \'vehicle_sale\'': [1, 'KIND — the endpoint refuses to move a car sale’s date away from its disposal’s'],
    'pages/api/invoice-unlock.ts | series === \'warranty\'': [1, 'KIND — warranty re-freezes its goodwill shape; a car sale re-freezes its line'],
    'pages/api/historical-import.ts | series: \'chargeable\'': [1, 'DATA — the series recorded in a duplicate-cleanup audit diff'],
    'pages/api/jobcard-status.ts | series === \'warranty\'': [1, 'KIND — warranty is not payable; a car sale is'],
    'pages/api/company.ts | series: \'warranty\'': [1, 'KIND — has the WARRANTY counter been used'],
  };
  const undeclared = [...found].filter(([k, n]) => !DECLARED[k] || DECLARED[k][0] !== n).map(([k, n]) => `${k} ×${n}${DECLARED[k] ? ` (declared ×${DECLARED[k][0]})` : ''}`);
  const stale = Object.keys(DECLARED).filter((k) => !found.has(k));
  check('no series literal outside the module that is not declared with what it is', undeclared.length === 0,
    undeclared.length ? `\n    ${undeclared.join('\n    ')}\n    Use a rule from lib/invoice-series-scope, or declare it here as KIND/TYPE/DATA/LATER with its car-sale answer` : `${found.size} kinds of literal, all declared`);
  check('  …and no declaration describes a literal that has gone', stale.length === 0, stale.join(', ') || 'the register matches the code');
  check('  …and the scan can still see: it finds the LATER literals it has not yet removed', found.has("lib/vat-summary.ts | series: 'chargeable'") && found.has("lib/credit-note.ts | series === 'chargeable'"),
    'a sweep that matches nothing is indistinguishable from one that is broken');

  // ════════════════════════════════════════════════════════════════════════════════════════════
  prisma = await gatePrisma();
  const SALE = await import(`${R}/lib/stock-sale.ts`);
  const LF = await import(`${R}/lib/invoice-list-filters.ts`);
  const TILES = await import(`${R}/lib/dashboard-tiles.ts`);
  const { notVoided } = await import(`${R}/lib/invoice-void.ts`);

  const sweep = async () => {
    const vs = await prisma.vehicle.findMany({ where: { group_id: ZZ_GROUP, registration: { startsWith: PREFIX } }, select: { id: true, identity_id: true } });
    const ids = vs.map((v) => v.id);
    if (ids.length) {
      const cards = (await prisma.jobCard.findMany({ where: { vehicle_id: { in: ids } }, select: { id: true } })).map((c) => c.id);
      const invs = (await prisma.invoice.findMany({ where: { job_card_id: { in: cards } }, select: { id: true } })).map((i) => i.id);
      await prisma.invoiceLine.deleteMany({ where: { invoice_id: { in: invs } } });
      await prisma.invoice.deleteMany({ where: { id: { in: invs } } });
      await prisma.jobCardItem.deleteMany({ where: { job_card_id: { in: cards } } });
      await prisma.jobCard.deleteMany({ where: { id: { in: cards } } });
      const its = (await prisma.stockItem.findMany({ where: { vehicle_id: { in: ids } }, select: { id: true } })).map((i) => i.id);
      await prisma.stockCostSnapshot.deleteMany({ where: { stock_item_id: { in: its } } });
      await prisma.stockDisposal.deleteMany({ where: { stock_item_id: { in: its } } });
      await prisma.stockItem.deleteMany({ where: { id: { in: its } } });
      await prisma.vehicle.deleteMany({ where: { id: { in: ids } } });
      const idents = vs.map((v) => v.identity_id).filter(Boolean);
      if (idents.length) await prisma.vehicleIdentity.deleteMany({ where: { id: { in: idents }, vehicles: { none: {} } } });
    }
    await prisma.customer.deleteMany({ where: { group_id: ZZ_GROUP, name: { startsWith: PREFIX }, ownerships: { none: {} }, job_cards: { none: {} } } });
    return ids.length;
  };
  const swept = await sweep();
  if (swept) console.log(`\n  (swept ${swept} fixture car(s) left by an earlier run)`);

  const site = await prisma.site.findFirst({ where: { group_id: ZZ_GROUP }, select: { id: true } });
  const user = await prisma.user.findFirst({ where: { group_id: ZZ_GROUP }, select: { id: true } });
  const siteIds = (await prisma.site.findMany({ where: { group_id: ZZ_GROUP }, select: { id: true } })).map((s) => s.id);
  const NONE = '00000000-0000-0000-0000-000000000000';
  let n = 0;
  const sell = async (buyer) => {
    n += 1;
    const reg = `${PREFIX}${String(n).padStart(2, '0')}`;
    const v = await prisma.vehicle.create({ data: { group_id: ZZ_GROUP, registration: reg, registration_normalized: reg, make: 'MINI', model: 'One', year: 2011 }, select: { id: true } });
    const it = await prisma.stockItem.create({ data: { group_id: ZZ_GROUP, vehicle_id: v.id, acquired_at: new Date('2026-03-01'), status: 'advertised',
      purchase_pence: 300000, vat_status: 'margin', source: 'auction', created_by_user_id: user.id }, select: { id: true } });
    const r = await SALE.sellCar({ groupId: ZZ_GROUP, userId: user.id, siteId: site.id, stockItemId: it.id, soldAt: new Date(), salePence: 450000, buyer });
    return 'invoiceId' in r ? r.invoiceId : NONE;
  };

  console.log('\n— A SALE IS OWED, AND FALLS DUE LIKE WORKSHOP WORK —');
  const account = await prisma.customer.create({ data: { group_id: ZZ_GROUP, site_id: site.id, name: `${PREFIX} Account Buyer`, address: '1 Trade Park', account_terms_days: 30 }, select: { id: true } });
  const invAcc = await sell({ customerId: account.id });
  const invRet = await sell({ name: `${PREFIX} Retail Buyer`, address: '2 High Street' });
  check('both sales minted', invAcc !== NONE && invRet !== NONE);
  const acc = await prisma.invoice.findUnique({ where: { id: invAcc }, select: { issued_at: true, due_date: true } });
  const ret = await prisma.invoice.findUnique({ where: { id: invRet }, select: { due_date: true } });
  const days = acc?.due_date && acc?.issued_at ? Math.round((acc.due_date - acc.issued_at) / 86_400_000) : null;
  /** THE SAME RULE AS WORKSHOP WORK. A sale invoice used to be minted with no due date at all, so even
   *  with the list widened an account buyer could never have shown as late. */
  check('an ACCOUNT buyer’s sale gets their terms as a due date', days === 30, `due ${days} day(s) after issue`);
  check('  …and a RETAIL buyer’s gets none — like retail workshop work', ret?.due_date === null, String(ret?.due_date));

  const inList = async (key, scope = null, range = null) => (await prisma.invoice.findMany({
    where: { group_id: ZZ_GROUP, site_id: { in: siteIds }, ...LF.listWhere(key, range, scope).where },
    select: { id: true },
  })).map((r) => r.id);
  const unpaid = await inList('unpaid');
  check('both unpaid sales are on the UNPAID list', unpaid.includes(invAcc) && unpaid.includes(invRet), 'a car sold and not yet paid for is money owed');
  const tileNow = new Date();
  const debtors = await TILES.TILE_COMPUTES.debtors({ groupId: ZZ_GROUP, siteIds, from: tileNow, to: tileNow, now: tileNow });
  check('  …and the DEBTORS tile counts exactly what the list it opens shows', debtors.count === unpaid.length, `tile ${debtors.count}, list ${unpaid.length}`);

  await prisma.invoice.update({ where: { id: invAcc }, data: { due_date: new Date(Date.now() - 86_400_000) } });
  const overdue = await inList('overdue');
  check('an account buyer past their terms is OVERDUE', overdue.includes(invAcc));
  check('  …a retail buyer never is', !overdue.includes(invRet));

  console.log('\n— A TILE AND THE LIST IT OPENS STILL AGREE —');
  const monthFrom = new Date(Date.UTC(tileNow.getUTCFullYear(), tileNow.getUTCMonth(), 1));
  const monthTo = new Date(Date.UTC(tileNow.getUTCFullYear(), tileNow.getUTCMonth() + 1, 1));
  const range = { from: monthFrom, to: monthTo };
  const issuedAll = await inList('issued', null, range);
  const issuedWorkshop = await inList('issued', 'workshop', range);
  check('the period list shows the car sales', issuedAll.includes(invAcc) && issuedAll.includes(invRet), 'an invoice is an invoice');
  check('  …opened from a workshop tile it does not', !issuedWorkshop.includes(invAcc) && !issuedWorkshop.includes(invRet));
  const ivp = await TILES.TILE_COMPUTES.issuedVsPaid({ groupId: ZZ_GROUP, siteIds, from: monthFrom, to: monthTo, now: tileNow });
  const workshopNotVoid = (await prisma.invoice.count({ where: { group_id: ZZ_GROUP, site_id: { in: siteIds }, ...LF.listWhere('issued', range, 'workshop').where, ...notVoided } }));
  /**
   * WITHOUT THE SCOPE THIS FAILS: the tile leaves car sales out and the list it opens would put them
   * in. Voids compared out on both sides — the tile excludes them, the list deliberately keeps them.
   */
  check('the Issued tile’s count equals the scoped list it opens', ivp.issuedCount === workshopNotVoid, `tile ${ivp.issuedCount}, scoped list ${workshopNotVoid}`);
  check('  …and the unscoped list is larger by the car sales, so the scope is doing the work', issuedAll.length >= issuedWorkshop.length + 2,
    `${issuedAll.length} vs ${issuedWorkshop.length}`);
  /**
   * NARROWS, NEVER REPLACES — proved on a key whose series lies OUTSIDE the scope. The first version of
   * this clause used `unpaid`, where overwriting and narrowing happen to give the same rows, so it
   * could not fail (red-proof: 0 of 43). `warranty` under the workshop scope must be EMPTY; a spread
   * that overwrote the key's own series would turn it into the chargeable list.
   */
  const scopedWarranty = await inList('warranty', 'workshop');
  const chargeableExists = await prisma.invoice.count({ where: { group_id: ZZ_GROUP, site_id: { in: siteIds }, series: 'chargeable' } });
  check('a scope NARROWS a key that already names a series, never replaces it',
    scopedWarranty.length === 0 && chargeableExists > 0,
    `warranty list under the workshop scope: ${scopedWarranty.length} row(s), with ${chargeableExists} chargeable invoice(s) there to leak in`);

  console.log('\n— THE GARAGE’S NUMBERING IS NOT LOCKED BY A CAR SALE —');
  const counterUsed = await prisma.invoice.count({ where: { group_id: ZZ_GROUP, ...SC.seriesWhere(SC.USES_CHARGEABLE_COUNTER) } });
  const plainChargeable = await prisma.invoice.count({ where: { group_id: ZZ_GROUP, series: 'chargeable' } });
  const sales = await prisma.invoice.count({ where: { group_id: ZZ_GROUP, series: 'vehicle_sale' } });
  check('the counter guard counts chargeable invoices only, with sales present to be wrongly counted', counterUsed === plainChargeable && sales >= 2,
    `${counterUsed} counted, ${sales} sale invoice(s) ignored`);

  // ════════════════════════════════════════════════════════════════════════════════════════════
  console.log('\n— THE WAY A PERSON ARRIVES: FROM THE TILE —');
  const dash = readFileSync(`${R}/pages/admin/dashboard.tsx`, 'utf8');
  const hrefs = [...dash.matchAll(/href=\{?[`"]\/admin\/invoices\?status=(\w+)([^`"]*)[`"]/g)].map((m) => ({ status: m[1], scoped: /scope=workshop/.test(m[2]) }));
  check('the Revenue, Issued, Paid and Pending links carry the workshop scope',
    hrefs.filter((h) => ['paid', 'issued', 'pending'].includes(h.status)).every((h) => h.scoped) && hrefs.filter((h) => ['paid', 'issued', 'pending'].includes(h.status)).length === 4,
    JSON.stringify(hrefs));
  check('  …and Debtors does NOT — car sales are owed, and its list must show them', hrefs.some((h) => h.status === 'unpaid' && !h.scoped));

  const ready = await serverReady();
  check('the dev server serves pages before we drive it', ready.ok, `HTTP ${ready.status}`);
  browser = await chromium.launch({ channel: 'chrome' });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const origin = gateOrigin();
  await page.goto(`${origin}/admin/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', 'owner@zzgategarage.test');
  await page.fill('input[type="password"]', 'GateGarage!2026');
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }), page.click('button[type="submit"]')]);
  const api = async (qs) => ((await (await ctx.request.get(`${origin}/api/invoices?${qs}`)).json()).invoices ?? []).map((r) => r.id);
  const apiUnpaid = await api('status=unpaid');
  const apiUnpaidWorkshop = await api('status=unpaid&scope=workshop');
  check('the list API shows the unpaid sale', apiUnpaid.includes(invRet));
  check('  …and honours the workshop scope a tile sends', !apiUnpaidWorkshop.includes(invRet) && apiUnpaidWorkshop.length < apiUnpaid.length);
  const apiJunk = await api('status=unpaid&scope=everything');
  check('  …while an unknown scope is ignored, never guessed at', JSON.stringify([...apiJunk].sort()) === JSON.stringify([...apiUnpaid].sort()));
  await page.goto(`${origin}/admin/invoices?status=unpaid&scope=workshop`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="workshop-scope-banner"]', { timeout: 20000 }).catch(() => {});
  const banner = await page.locator('[data-testid="workshop-scope-banner"]').textContent().catch(() => null);
  check('the list SAYS it is workshop-only when a tile opened it', !!banner && /Car sales are on the stock page/.test(banner), (banner ?? 'NO BANNER').slice(0, 80));

} catch (e) {
  check('run completed', false, describeError(e).slice(0, 300));
} finally {
  await browser?.close().catch(() => {});
  if (prisma) {
    try {
      const vs = await prisma.vehicle.findMany({ where: { group_id: ZZ_GROUP, registration: { startsWith: PREFIX } }, select: { id: true, identity_id: true } });
      const ids = vs.map((v) => v.id);
      if (ids.length) {
        const cards = (await prisma.jobCard.findMany({ where: { vehicle_id: { in: ids } }, select: { id: true } })).map((c) => c.id);
        const invs = (await prisma.invoice.findMany({ where: { job_card_id: { in: cards } }, select: { id: true } })).map((i) => i.id);
        await prisma.invoiceLine.deleteMany({ where: { invoice_id: { in: invs } } });
        await prisma.invoice.deleteMany({ where: { id: { in: invs } } });
        await prisma.jobCardItem.deleteMany({ where: { job_card_id: { in: cards } } });
        await prisma.jobCard.deleteMany({ where: { id: { in: cards } } });
        const its = (await prisma.stockItem.findMany({ where: { vehicle_id: { in: ids } }, select: { id: true } })).map((i) => i.id);
        await prisma.stockCostSnapshot.deleteMany({ where: { stock_item_id: { in: its } } });
        await prisma.stockDisposal.deleteMany({ where: { stock_item_id: { in: its } } });
        await prisma.stockItem.deleteMany({ where: { id: { in: its } } });
        await prisma.vehicle.deleteMany({ where: { id: { in: ids } } });
        const idents = vs.map((v) => v.identity_id).filter(Boolean);
        if (idents.length) await prisma.vehicleIdentity.deleteMany({ where: { id: { in: idents }, vehicles: { none: {} } } });
      }
      await prisma.customer.deleteMany({ where: { group_id: ZZ_GROUP, name: { startsWith: PREFIX }, ownerships: { none: {} }, job_cards: { none: {} } } });
      const leftV = await prisma.vehicle.count({ where: { group_id: ZZ_GROUP, registration: { startsWith: PREFIX } } });
      const leftC = await prisma.customer.count({ where: { group_id: ZZ_GROUP, name: { startsWith: PREFIX } } });
      check('teardown left ZZ with none of this gate’s cars or customers', leftV === 0 && leftC === 0, `${ids.length} car(s); ${leftV} car(s), ${leftC} customer(s) left`);
    } catch (e) { check('teardown completed', false, describeError(e).slice(0, 200)); }
  }
}
console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
await prisma?.$disconnect();
process.exit(out.includes('F') ? 1 : 0);
