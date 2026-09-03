/**
 * File: scripts/billed-party-gate.mjs
 * WHO THE INVOICE IS ADDRESSED TO, WHEN THAT IS NOT THE PERSON WHOSE CAR IT IS.
 * @gate-requires: server:3000, db
 *
 * ── WHY ─────────────────────────────────────────────────────────────────────────────────────────
 * A garage bills an employer for an employee's company car every week and had NO path to it. The
 * one field that looked like the path — Customer.account_name, "Account name (if different)" — was
 * written to the database by the Customer Details tab and read by NOTHING on any document. Eight
 * rows carried it, all eight written by the demo generator; no real garage ever used a field that
 * renders nowhere. A garage that tried unlocked a valid invoice, typed the company in, re-issued,
 * and got the original back, because the addressee is a snapshot frozen at mint.
 *
 * ── WHAT THIS GATE HOLDS ────────────────────────────────────────────────────────────────────────
 * 1. The billed party is resolved in ONE place, beside the company identity it mirrors.
 * 2. Setting an account does NOT change what the existing columns mean. customer_name_snapshot
 *    stays the person, on every document ever issued, and the account rides in its own pair.
 * 3. An account name with no account address prints NO address — never the person's home one.
 *    Addressing "Bramhope Haulage Ltd" at an employee's house is a worse document than one with
 *    no address at all, and it is the failure a `??` fallback produces without anybody choosing it.
 * 4. The document names BOTH parties, in a browser, on the served page — the employer's accounts
 *    department has to know which employee's car this was.
 * 5. The credit note carries the same pair, or the two documents stop reading as a pair.
 *
 * NOT IN SCOPE (slice two): correcting the addressee on an invoice already minted. This gate must
 * stay green when that lands; it asserts nothing about the register or any correction path.
 *
 * Fixtures on ZZ Gate Garage only. Never TMBS.
 */
import './_gate-preflight.mjs';
const { gatePrisma, explainIfClientStale, zzSite, serverReady, describeError } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');
const { readFileSync } = await import('node:fs');
const INV = await import('../lib/invoice.ts');
const { issueInvoiceForCard } = await import('../lib/invoice-issue.ts');
const prisma = await gatePrisma();

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
// FIXTURE NAMES THE SCANS BELOW WILL NEVER LOOK FOR. Every scan in this file matches a property
// access or a JSX shape; none matches a person or a company, so a collision cannot green a check.
const PERSON = 'Kessler Detail Fixture';
const FIRM = 'Bramhope Haulage Limited';
const FIRM_ADDR = 'Unit 7, Alder Way, Leeds LS16 9QT';
const REG = 'ZZ19BPY';
const REG2 = 'ZZ19BPZ';
const RETAIL = 'Ashdown Retail Fixture';

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };

const BASE = process.env.GATE_BASE ?? 'http://localhost:3000';
let fix = null, browser = null;

try {
  const stale = await prisma.customer.count({ where: { group_id: ZZ, name: { in: [PERSON, RETAIL] } } });
  if (stale) throw new Error(`REFUSING: ${stale} fixture(s) from a previous run still present`);

  // ── 1. ONE RESOLVER, BESIDE THE ONE IT MIRRORS ───────────────────────────────────────────────
  console.log('\n— the billed party is resolved in one place —');
  check('resolveBilledParty lives beside resolveCompanyIdentity',
    typeof INV.resolveBilledParty === 'function' && typeof INV.resolveCompanyIdentity === 'function',
    'the two parties on a document are resolved the same way, in the same file, or one of them drifts');

  // A GATE THAT DIES AT CHECK 1 REPORTS NOTHING ABOUT CHECKS 2-32. The resolver is absent before
  // this slice lands, so calling it directly would throw and take the whole run with it — and the
  // red-proof would then be unable to show that any LATER assertion can fail. Absent resolves to an
  // empty object, every derived check fails on its own terms, and the reasons are all visible.
  const rbp = (c) => { try { return INV.resolveBilledParty(c) ?? {}; } catch { return {}; } };

  const retail = rbp({ name: 'Ada Retail', address: '2 Mill Lane' });
  check('no account: the customer is the addressee',
    retail.name === 'Ada Retail' && retail.address === '2 Mill Lane');
  check('  …and there is no second party to name', retail.onBehalfOf === null,
    'NULL is the normal case — almost every invoice a garage raises');

  const acct = rbp({
    name: 'Ada Retail', address: '2 Mill Lane', account_name: FIRM, account_address: FIRM_ADDR });
  check('an account name set: the company is the addressee', acct.name === FIRM, acct.name);
  check('  …at the ACCOUNT address, not the customer’s', acct.address === FIRM_ADDR, String(acct.address));
  check('  …and the customer is named as the party it is FOR', acct.onBehalfOf === 'Ada Retail', String(acct.onBehalfOf));

  // THE RULE THAT A `??` WOULD GET WRONG WITHOUT ANYBODY CHOOSING IT.
  const noAddr = rbp({ name: 'Ada Retail', address: '2 Mill Lane', account_name: FIRM });
  check('an account with no address prints NO address', noAddr.address === null, String(noAddr.address),);
  // PAIRED WITH A POSITIVE, or it passes on every failure that produces nothing at all. The
  // red-proof caught this one green against a resolver that did not exist: `undefined !== '2 Mill
  // Lane'` is true, so the check most worth having was the only one in the section not failing.
  check('  …specifically NOT the person’s own', noAddr.address !== '2 Mill Lane' && noAddr.name === FIRM,
    'addressing a haulage firm at an employee’s house is worse than addressing it nowhere');
  check('  …while still billing the company', noAddr.name === FIRM && noAddr.onBehalfOf === 'Ada Retail');

  check('blank is blank: a whitespace account name is not an account',
    rbp({ name: 'Ada Retail', address: null, account_name: '   ' }).onBehalfOf === null);
  check('  …and an account ADDRESS with no name is not an account either',
    rbp({ name: 'Ada Retail', address: '2 Mill Lane', account_address: FIRM_ADDR }).name === 'Ada Retail',
    'there is nobody to bill; an address alone addresses nothing');

  // ── 2. THE SCHEMA: FIVE NULLABLE COLUMNS, NO BACKFILL ────────────────────────────────────────
  console.log('\n— five nullable columns, and nothing was backfilled —');
  const schema = readFileSync('prisma/schema.prisma', 'utf8');
  const block = (model) => {
    const m = schema.slice(schema.indexOf(`model ${model} {`));
    return m.slice(0, m.indexOf('\n}'));
  };
  const nullable = (model, col) => new RegExp(`^\\s+${col}\\s+String\\?`, 'm').test(block(model));
  check('Customer.account_address is nullable', nullable('Customer', 'account_address'));
  check('Invoice carries its own account pair, both nullable',
    nullable('Invoice', 'account_name_snapshot') && nullable('Invoice', 'account_address_snapshot'));
  check('CreditNote carries the same pair, both nullable',
    nullable('CreditNote', 'account_name_snapshot') && nullable('CreditNote', 'account_address_snapshot'));

  // ── 3. THE MINT ──────────────────────────────────────────────────────────────────────────────
  console.log('\n— the mint snapshots the account without moving the customer —');
  const site = await zzSite(prisma);
  const mk = async (name, reg, extra) => {
    const c = await prisma.customer.create({ data: { group_id: ZZ, name, ...extra }, select: { id: true } });
    const v = await prisma.vehicle.create({
      data: { group_id: ZZ, registration: reg, registration_normalized: reg, make: 'Billed', model: 'Fixture' },
      select: { id: true } });
    await prisma.vehicleOwnership.create({ data: { vehicle_id: v.id, customer_id: c.id, is_current: true } });
    const card = await prisma.jobCard.create({
      data: { group_id: ZZ, site_id: site.id, customer_id: c.id, vehicle_id: v.id, status: 'invoiced', odometer_in: 41000 },
      select: { id: true } });
    await prisma.jobCardItem.create({ data: { job_card_id: card.id, item_type: 'labour',
      description: 'Billed-party fixture work', qty: 1, unit_price: 120, vat_rate: 20, vat_amount: 24, labour_hours: 1 } });
    let id = null;
    await prisma.$transaction(async (tx) => { id = await issueInvoiceForCard(tx, card.id, ZZ); }, { timeout: 30000 });
    return { cust: c.id, veh: v.id, card: card.id, invoice: id };
  };

  const A = await mk(PERSON, REG, { address: '14 Hollin Road, Leeds LS16 5NE', account_name: FIRM, account_address: FIRM_ADDR });
  const B = await mk(RETAIL, REG2, { address: '3 Kirkgate, Otley LS21 3HJ' });
  fix = { a: A, b: B };

  const invA = await prisma.invoice.findUnique({ where: { id: A.invoice },
    select: { account_name_snapshot: true, account_address_snapshot: true, customer_name_snapshot: true, customer_address_snapshot: true } });
  check('the account name is snapshotted at mint', invA.account_name_snapshot === FIRM, String(invA.account_name_snapshot));
  check('  …with its own address', invA.account_address_snapshot === FIRM_ADDR, String(invA.account_address_snapshot));
  // THE REGRESSION THAT MATTERS MOST. 3,395 documents already carry this column.
  check('  …and customer_name_snapshot still means THE PERSON', invA.customer_name_snapshot === PERSON,
    `${invA.customer_name_snapshot} — overloading this column would silently restate every document ever issued`);
  check('  …at the person’s own address', /Hollin Road/.test(invA.customer_address_snapshot ?? ''));

  const invB = await prisma.invoice.findUnique({ where: { id: B.invoice },
    select: { account_name_snapshot: true, account_address_snapshot: true, customer_name_snapshot: true } });
  check('a retail invoice carries NULL, not an empty string',
    invB.account_name_snapshot === null && invB.account_address_snapshot === null,
    'honest-null: NULL is "billed to the customer", which is nearly every invoice');
  check('  …and its customer is unchanged', invB.customer_name_snapshot === RETAIL);

  const backfilled = await prisma.invoice.count({
    where: { account_name_snapshot: { not: null }, id: { notIn: [A.invoice, B.invoice] } } });
  check('no existing document was backfilled', backfilled === 0,
    `${backfilled} invoice(s) outside this fixture carry an account — nothing should have been written to the back catalogue`);

  // ── 4. ONE ADDRESSEE BLOCK, READ BY ALL THREE RENDERERS ──────────────────────────────────────
  console.log('\n— one block on the doc, three renderers reading it —');
  const { buildInvoiceDoc } = await import('../lib/invoice-doc.ts');
  const docA = await buildInvoiceDoc(A.invoice, ZZ);
  check('the doc addresses the company', docA?.addressee?.name === FIRM, String(docA?.addressee?.name));
  check('  …and names the person it is for', docA?.addressee?.onBehalfOf === PERSON, String(docA?.addressee?.onBehalfOf));
  check('  …while doc.customer stays the person the email greets',
    docA?.customer?.name === PERSON,
    'invoice-email-send greets doc.customer.name — the employer must not be greeted as the driver');
  const docB = await buildInvoiceDoc(B.invoice, ZZ);
  check('a retail doc addresses the customer with nobody behind it',
    docB?.addressee?.name === RETAIL && docB?.addressee?.onBehalfOf === null);

  const renderers = {
    'lib/invoice-pdf.tsx': /\bdoc\.addressee\b/,
    'pages/admin/invoices/[id].tsx': /\bprops\.addressee\b/,
    'components/customer/CustomerInvoice.tsx': /\bd\.addressee\b/,
  };
  const src = Object.fromEntries(Object.keys(renderers).map((f) => [f, readFileSync(f, 'utf8')]));
  const missing = Object.entries(renderers).filter(([f, re]) => !re.test(src[f])).map(([f]) => f);
  check('all three renderers read the resolved block', missing.length === 0, missing.join(', ') || '3 of 3');
  // NOT A BARE IDENTIFIER: the column name in a RENDERER means it went round the doc.
  const openCoded = Object.keys(renderers).filter((f) => /account_name_snapshot/.test(src[f]));
  check('  …and none of them open-codes the fallback', openCoded.length === 0,
    openCoded.join(', ') || 'the choice of party is made once, not three times');

  // ── 5. THE SERVED DOCUMENT NAMES BOTH PARTIES ────────────────────────────────────────────────
  console.log('\n— and the page a person actually looks at —');
  const ready = await serverReady();
  check('the dev server serves pages before we drive it', ready.ok, `HTTP ${ready.status} after ${ready.attempts} attempt(s)`);
  browser = await chromium.launch({ channel: 'chrome' });
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${BASE}/admin/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', 'owner@zzgategarage.test');
  await page.fill('input[type="password"]', 'GateGarage!2026');
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }), page.click('button[type="submit"]')]);
  await page.goto(`${BASE}/admin/invoices/${A.invoice}`, { waitUntil: 'domcontentloaded' });
  // WAIT FOR THE ELEMENT THIS SECTION IS ABOUT, not for a neighbour of it. Reading innerText after
  // waiting on the addressee alone caught the page 11 characters short of finished and reported the
  // "for …" line missing — a real red for a rendering that was correct, which is the worst kind.
  // The wait is on the node the assertion names, and a genuine absence still lands as a failed
  // check below (with the block printed) rather than as a swallowed timeout.
  await page.waitForSelector('[data-testid="invoice-on-behalf-of"]', { timeout: 30000 }).catch(() => {});
  const body = await page.evaluate(() => document.body.innerText);
  // POSITIVE FIRST. A negative assertion is satisfied by a blank page, which is what a crashed
  // tree renders — so the presence of a known label is what proves the page rendered at all.
  check('the invoice page rendered', /Bill to/i.test(body), body.length ? `${body.length} chars` : 'BLANK BODY — the tree rendered nothing');
  check('  …addressed to the company', new RegExp(FIRM).test(body));
  // A FAILING CHECK MUST SAY WHAT IT SAW. Reporting only the rule leaves the reader guessing
  // whether the line is missing, mis-worded, or the page simply had not finished rendering.
  const billBlock = (() => { const i = body.search(/BILL TO/i); return i < 0 ? '(no BILL TO in the body)' : JSON.stringify(body.slice(i, i + 120)); })();
  check('  …and saying whose car it was', new RegExp(`for\\s+${PERSON}`).test(body),
    `${billBlock} — the employer’s accounts department cannot pay a bill it cannot attribute to an employee`);
  await page.goto(`${BASE}/admin/invoices/${B.invoice}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="invoice-addressee"]', { timeout: 30000 }).catch(() => {});
  const bodyB = await page.evaluate(() => document.body.innerText);
  check('a retail invoice renders one party and no dangling "for"',
    new RegExp(RETAIL).test(bodyB) && !/\bfor\s*$/m.test(bodyB));

  // ── 6. THE CREDIT NOTE CARRIES THE SAME PAIR ─────────────────────────────────────────────────
  console.log('\n— the credit note reads as a pair with it —');
  const { mintCreditNote } = await import('../lib/credit-note.ts');
  let cn = null;
  await prisma.$transaction(async (tx) => {
    cn = await mintCreditNote(tx, { groupId: ZZ, invoiceId: A.invoice, dateIssued: new Date(),
      reason: 'Billed-party fixture', createdBy: null,
      lines: [{ position: 0, description: 'Fixture credit', item_type: 'labour', qty: 1, unit_price: 120, vat_rate: 20, line_total: 120, line_vat: 24 }] });
  }, { timeout: 30000 });
  fix.creditNote = cn?.id ?? null;
  const cnRow = await prisma.creditNote.findUnique({ where: { id: cn.id },
    select: { account_name_snapshot: true, account_address_snapshot: true, customer_name_snapshot: true } });
  check('the credit note is addressed to the same company', cnRow.account_name_snapshot === FIRM, String(cnRow.account_name_snapshot));
  check('  …at the same address', cnRow.account_address_snapshot === FIRM_ADDR);
  check('  …and names the same person', cnRow.customer_name_snapshot === PERSON);

  // ── 7. THE FORM: ITS OWN SECTION, AND COPY THAT SAYS WHEN IT TAKES EFFECT ────────────────────
  console.log('\n— the field says what it does, where somebody will find it —');
  const form = readFileSync('components/jobcard/CustomerDetailsForm.tsx', 'utf8');
  const at = (needle) => form.indexOf(needle);
  const iAddr = at('data-testid="cust-address"');
  const iAcctName = at('data-testid="cust-account-name"');
  const iAcctAddr = at('data-testid="cust-account-address"');
  const iTerms = at('data-testid="cust-terms"');
  check('the billing address field exists', iAcctAddr > 0);
  check('the billing block sits with the addresses, not in the on-account block',
    iAddr > 0 && iAcctName > iAddr && iTerms > 0 && iAcctName < iTerms,
    `address ${iAddr} → account ${iAcctName} → terms ${iTerms}: billing an employer is not a credit-terms decision`);
  check('  …with its two fields together', iAcctAddr > iAcctName && iAcctAddr < iTerms);

  const copy = JSON.parse(readFileSync('public/locales/en-GB/jobcard.json', 'utf8')).field ?? {};
  check('the field no longer asks "different" from what',
    !/if different/i.test(copy.accountName ?? ''), copy.accountName ?? '(missing)');
  check('  …and a billing address has a label', !!copy.accountAddress, copy.accountAddress ?? '(missing)');
  // THE SENTENCE WHOSE ABSENCE PRODUCED THIS SLICE.
  check('the hint says WHEN it takes effect', /from now on/i.test(copy.accountNameHint ?? ''),
    copy.accountNameHint ?? '(missing)');
  check('  …and that the customer stays the owner of the car',
    /owner of the car/i.test(copy.accountNameHint ?? ''),
    'the trap is editing the customer’s NAME to the employer instead');
} catch (e) {
  check('gate run completed', false, describeError(e).slice(0, 300));
  await explainIfClientStale(BASE);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (fix) {
    const step = async (n, fn) => { try { await fn(); } catch (e) { console.log(`  teardown ${n}: ${describeError(e).slice(0, 90)}`); } };
    if (fix.creditNote) {
      await step('credit note lines', () => prisma.creditNoteLine.deleteMany({ where: { credit_note_id: fix.creditNote } }));
      await step('credit note', () => prisma.creditNote.deleteMany({ where: { id: fix.creditNote } }));
    }
    for (const f of [fix.a, fix.b].filter(Boolean)) {
      if (f.invoice) {
        await step('invoice lines', () => prisma.invoiceLine.deleteMany({ where: { invoice_id: f.invoice } }));
        await step('invoice', () => prisma.invoice.deleteMany({ where: { id: f.invoice } }));
      }
      await step('card items', () => prisma.jobCardItem.deleteMany({ where: { job_card_id: f.card } }));
      await step('card', () => prisma.jobCard.deleteMany({ where: { id: f.card } }));
      await step('edges', () => prisma.vehicleOwnership.deleteMany({ where: { vehicle_id: f.veh } }));
      await step('vehicle', () => prisma.vehicle.deleteMany({ where: { id: f.veh } }));
      await step('customer', () => prisma.customer.deleteMany({ where: { id: f.cust } }));
    }
    // BY THE FIXTURE'S OWN IDENTIFIERS, tenant-scoped, never by anything the code under test returned.
    check('teardown removed every fixture row (ZZ only)',
      (await prisma.customer.count({ where: { group_id: ZZ, name: { in: [PERSON, RETAIL] } } })) === 0
      && (await prisma.vehicle.count({ where: { group_id: ZZ, registration: { in: [REG, REG2] } } })) === 0);
  }
}

console.log(`\n${out.filter((x) => x === 'F').length} failures of ${out.length}`);
await prisma.$disconnect();
process.exit(out.includes('F') ? 1 : 0);
