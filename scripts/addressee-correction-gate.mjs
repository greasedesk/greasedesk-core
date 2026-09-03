/**
 * File: scripts/addressee-correction-gate.mjs
 * CORRECTING WHO AN INVOICE IS ADDRESSED TO — the one door in the freeze, and its hinges.
 * @gate-requires: server:3000, db
 *
 * ── WHY THERE IS A DOOR AT ALL ──────────────────────────────────────────────────────────────────
 * A garage billed a customer, the customer said "put it to my employer", and the product had no
 * answer. Unlock, type the company in, re-issue: the document came back addressed to the person,
 * because the addressee is a snapshot frozen at mint and every writer of it is the mint. Slice one
 * gave a NEW invoice somewhere to put the employer. It could do nothing for one already raised.
 *
 * ── WHY IT IS A DOOR AND NOT AN UNLOCK ──────────────────────────────────────────────────────────
 * `correctable` is a third snapshot policy, and a third policy in a freeze is worth exactly as much
 * as the narrowness of the thing that implements it. So this gate holds the endpoint to the same
 * shape lib/invoice-void's amend path claims for itself, and holds it FROM OUTSIDE, over HTTP:
 *   · ADMIN only — a site manager gets 403, not a quieter version of the same power;
 *   · only while the invoice is UNDER CORRECTION — a frozen document is refused and told to unlock;
 *   · never on a void, and never once a CREDIT NOTE exists — two immutable documents addressed to
 *     different parties is a worse state than the one being corrected;
 *   · four columns and nothing else — not the status, the number, the lines, the dates or the money;
 *   · a MANDATORY reason, an append-only log, and an audit row, every time.
 *
 * ── AND THE ONE THAT IS THE WHOLE POINT ─────────────────────────────────────────────────────────
 * The correction must SURVIVE THE RE-ISSUE that follows it. A `rebuild` policy would have re-read
 * the account from the customer record and quietly undone the correction on the very next button —
 * the same shape as the £75 that survived four unlock/re-issue cycles on 100003203. That check is
 * the reason this gate drives the real re-issue endpoint rather than reading the columns back.
 *
 * Fixtures on ZZ Gate Garage only. Never TMBS.
 */
import './_gate-preflight.mjs';
const { gatePrisma, explainIfClientStale, zzSite, serverReady, describeError } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');
const { readFileSync, existsSync } = await import('node:fs');
const S = await import('../lib/invoice-snapshots.ts');
// TOLERANT ON PURPOSE. A top-level import of a module that does not exist yet kills the process
// before check 1, so the red-proof can say nothing about any of the 30 assertions below it — the
// same trap as slice one's resolver. Absent loads as {}, the first check names the cause, and every
// dependent check fails on its own terms with its own reason visible.
const A = await import('../lib/invoice-addressee.ts').catch(() => ({}));
const { issueInvoiceForCard } = await import('../lib/invoice-issue.ts');
const prisma = await gatePrisma();

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
// Terms no scan in this file looks for. Every source scan below matches a property access, a
// `data:` payload or a policy name — never a person or a company.
const PERSON = 'Netherby Correction Fixture';
const FIRM = 'Otley Groundworks Limited';
const FIRM_ADDR = 'Bay 3, Pool Road, Otley LS21 1DY';
const REG = 'ZZ22ADR';
const REG_CN = 'ZZ22ADC';
const PERSON_CN = 'Credited Correction Fixture';

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };

const BASE = process.env.GATE_BASE ?? 'http://localhost:3000';
const VIA = 'pages/api/invoice-addressee.ts';
let fix = null, browser = null;

/** Sign in and return a page whose fetches carry that person's session. */
async function signedIn(email) {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${BASE}/admin/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', 'GateGarage!2026');
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }), page.click('button[type="submit"]')]);
  return page;
}
const post = (page, url, body) => page.evaluate(async ([u, b]) => {
  const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(b) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}, [url, body]);

try {
  const stale = await prisma.customer.count({ where: { group_id: ZZ, name: { in: [PERSON, PERSON_CN] } } });
  if (stale) throw new Error(`REFUSING: ${stale} fixture(s) from a previous run still present`);

  // ── 1. THE POLICY, AND THE LOG'S SHAPE ───────────────────────────────────────────────────────
  console.log('\n— the four addressee columns are correctable, together —');
  check('lib/invoice-addressee loads', typeof A.readAddresseeCorrections === 'function' && typeof A.printedAddressee === 'function',
    `readAddresseeCorrections=${typeof A.readAddresseeCorrections} printedAddressee=${typeof A.printedAddressee}`);
  const ADDRESSEE = ['customer_name_snapshot', 'customer_address_snapshot', 'account_name_snapshot', 'account_address_snapshot'];
  const policies = ADDRESSEE.map((c) => S.snapshotPolicy(c));
  check('all four are declared correctable', policies.every((p) => p?.policy === 'correctable'),
    ADDRESSEE.map((c, i) => `${c}=${policies[i]?.policy ?? 'undeclared'}`).join(' '));
  // `new Set([undefined, undefined, undefined, undefined]).size === 1` is TRUE. Caught green in the
  // red-proof against a register with no correctable column at all — the same shape as slice one's
  // `undefined !== '2 Mill Lane'`. A negative or a set-cardinality claim needs a positive beside it.
  check('  …and all four name the SAME path',
    new Set(policies.map((p) => p?.via)).size === 1 && !!policies[0]?.via,
    `via = ${String(policies[0]?.via)}` );
  check('  …which is the endpoint this gate drives', policies[0]?.via === VIA && existsSync(VIA), String(policies[0]?.via));
  // The customer pair and the account pair move TOGETHER or the endpoint can write two of the four
  // fields it renders — half an addressee, which is neither the old one nor the new one.
  check('  …and none of them was left behind as frozen',
    !ADDRESSEE.some((c) => S.snapshotPolicy(c)?.policy === 'frozen'));
  // SIX, counted from the register rather than remembered: reg, VIN, mileage, and the three
  // narrative blocks. The new policy must not quietly move anything into or out of this set.
  check('the rebuild set is unchanged by any of this', S.REBUILT_ON_REISSUE.length === 6,
    S.REBUILT_ON_REISSUE.join(', '));

  const schema = readFileSync('prisma/schema.prisma', 'utf8');
  const invModel = (() => { const m = schema.slice(schema.indexOf('model Invoice {')); return m.slice(0, m.indexOf('\n}')); })();
  check('Invoice.addressee_corrections is a nullable log', /^\s+addressee_corrections\s+Json\?/m.test(invModel));
  check('  …and is NOT a snapshot column', !/addressee_corrections/.test(S.INVOICE_SNAPSHOTS.map((s) => s.column).join(' ')),
    'it records corrections; it is not one of the things corrected');

  const readLog = (v) => { try { return A.readAddresseeCorrections(v) ?? []; } catch { return null; } };
  const printed = (v) => { try { return A.printedAddressee(v); } catch { return null; } };
  check('the correction log reads empty as empty, not as a crash',
    Array.isArray(readLog(null)) && readLog(null).length === 0 && Array.isArray(readLog('nonsense')) && readLog('nonsense').length === 0);
  check('  …and prints an addressee the same way the document does',
    printed({ customerName: 'Ada', customerAddress: '2 Mill Lane', accountName: null, accountAddress: null }) === 'Ada\n2 Mill Lane'
    && printed({ customerName: 'Ada', customerAddress: '2 Mill Lane', accountName: 'Firm Ltd', accountAddress: 'Unit 1' }) === 'Firm Ltd\nUnit 1\nfor Ada',
    JSON.stringify(printed({ customerName: 'Ada', customerAddress: '2 Mill Lane', accountName: 'Firm Ltd', accountAddress: 'Unit 1' })));

  // ── 2. THE FIXTURES ──────────────────────────────────────────────────────────────────────────
  const site = await zzSite(prisma);
  const mk = async (name, reg) => {
    const c = await prisma.customer.create({ data: { group_id: ZZ, name, address: '5 Netherby Rise, Leeds LS8 2QP' }, select: { id: true } });
    const v = await prisma.vehicle.create({ data: { group_id: ZZ, registration: reg, registration_normalized: reg, make: 'Addr', model: 'Fixture' }, select: { id: true } });
    await prisma.vehicleOwnership.create({ data: { vehicle_id: v.id, customer_id: c.id, is_current: true } });
    const card = await prisma.jobCard.create({
      data: { group_id: ZZ, site_id: site.id, customer_id: c.id, vehicle_id: v.id, status: 'invoiced', odometer_in: 52000 }, select: { id: true } });
    await prisma.jobCardItem.create({ data: { job_card_id: card.id, item_type: 'labour', description: 'Addressee fixture work',
      qty: 1, unit_price: 200, vat_rate: 20, vat_amount: 40, labour_hours: 2 } });
    let id = null;
    await prisma.$transaction(async (tx) => { id = await issueInvoiceForCard(tx, card.id, ZZ); }, { timeout: 30000 });
    return { cust: c.id, veh: v.id, card: card.id, invoice: id };
  };
  const M = await mk(PERSON, REG);
  const C = await mk(PERSON_CN, REG_CN);
  fix = { m: M, c: C };

  const ready = await serverReady();
  check('the dev server serves pages before we drive it', ready.ok, `HTTP ${ready.status} after ${ready.attempts} attempt(s)`);
  browser = await chromium.launch({ channel: 'chrome' });
  const admin = await signedIn('owner@zzgategarage.test');
  const correction = { accountName: FIRM, accountAddress: FIRM_ADDR, customerName: PERSON, customerAddress: '5 Netherby Rise, Leeds LS8 2QP', reason: 'Customer asked for it to go to their employer' };

  // ── 3. THE REFUSALS, FROM OUTSIDE, OVER HTTP ─────────────────────────────────────────────────
  console.log('\n— what it refuses, and whether it says come back —');
  const locked = await post(admin, '/api/invoice-addressee', { invoiceId: M.invoice, ...correction });
  check('a FROZEN invoice is refused', locked.status === 409, `HTTP ${locked.status}`);
  check('  …and told how to proceed, not merely told no', /unlock/i.test(locked.body?.message ?? ''),
    JSON.stringify(locked.body?.message ?? '').slice(0, 120));

  const manager = await signedIn('manager@zzgategarage.test');
  // UNLOCK FIRST so the 403 below cannot be the under-correction guard wearing the wrong number.
  const unlocked = await post(admin, '/api/invoice-unlock', { invoiceId: M.invoice, action: 'unlock' });
  check('the admin can unlock it', unlocked.status === 200, JSON.stringify(unlocked.body).slice(0, 120));
  const asManager = await post(manager, '/api/invoice-addressee', { invoiceId: M.invoice, ...correction });
  check('a site manager is refused 403 on an invoice that WOULD accept it', asManager.status === 403, `HTTP ${asManager.status}`);

  const noReason = await post(admin, '/api/invoice-addressee', { invoiceId: M.invoice, ...correction, reason: '   ' });
  check('a correction with no reason is refused', noReason.status === 400, `HTTP ${noReason.status}`);
  const noName = await post(admin, '/api/invoice-addressee', { invoiceId: M.invoice, ...correction, customerName: '' });
  check('  …and so is one that would leave nobody named', noName.status === 400, `HTTP ${noName.status}`);

  // ── 4. THE CORRECTION ────────────────────────────────────────────────────────────────────────
  console.log('\n— the correction itself —');
  const before = await prisma.invoice.findUnique({ where: { id: M.invoice }, select: { customer_name_snapshot: true, account_name_snapshot: true, status: true, invoice_number: true } });
  const done = await post(admin, '/api/invoice-addressee', { invoiceId: M.invoice, ...correction });
  check('the correction is accepted', done.status === 200, JSON.stringify(done.body).slice(0, 160));
  const after = await prisma.invoice.findUnique({ where: { id: M.invoice },
    select: { customer_name_snapshot: true, customer_address_snapshot: true, account_name_snapshot: true, account_address_snapshot: true,
      addressee_corrections: true, status: true, invoice_number: true, date_issued: true, amount_paid_pennies: true } });
  check('  …the invoice is now addressed to the company', after.account_name_snapshot === FIRM, String(after.account_name_snapshot));
  check('  …at the company’s address', after.account_address_snapshot === FIRM_ADDR);
  check('  …and still names whose car it was', after.customer_name_snapshot === PERSON);
  // FOUR COLUMNS AND NOTHING ELSE — the claim the endpoint's header makes about itself.
  check('  …and touched nothing else on the row',
    after.status === before.status && after.invoice_number === before.invoice_number,
    `status ${before.status}→${after.status}, number ${before.invoice_number}→${after.invoice_number}`);

  const log = readLog(after.addressee_corrections) ?? [];
  check('one entry was appended', log.length === 1, `${log.length} entries`);
  check('  …carrying the reason a person gave', /employer/i.test(log[0]?.reason ?? ''), String(log[0]?.reason));
  check('  …and BOTH sides, so the original is recoverable',
    log[0]?.from?.customerName === PERSON && log[0]?.from?.accountName === null && log[0]?.to?.accountName === FIRM,
    JSON.stringify(log[0]?.from ?? null));
  const audit = await prisma.auditLog.findFirst({ where: { entity_id: M.card, action: 'invoice.addressee_corrected' }, select: { id: true, diff_json: true } });
  check('  …and an audit row records it', !!audit, audit ? JSON.stringify(audit.diff_json).slice(0, 120) : 'none');

  const again = await post(admin, '/api/invoice-addressee', { invoiceId: M.invoice, ...correction });
  check('a correction that changes nothing is refused', again.status === 409, `HTTP ${again.status}`);
  const second = await post(admin, '/api/invoice-addressee', { invoiceId: M.invoice, ...correction, accountName: 'Otley Groundworks (Yorkshire) Limited' });
  check('a SECOND correction appends rather than replaces', second.status === 200
    && (readLog((await prisma.invoice.findUnique({ where: { id: M.invoice }, select: { addressee_corrections: true } })).addressee_corrections) ?? []).length === 2);

  // ── 5. IT SURVIVES THE RE-ISSUE. THIS IS THE ONE. ────────────────────────────────────────────
  console.log('\n— and the re-issue that follows does not undo it —');
  const reissued = await post(admin, '/api/invoice-unlock', { invoiceId: M.invoice, action: 'reissue', confirm: true });
  check('the re-issue is accepted', reissued.status === 200, JSON.stringify(reissued.body).slice(0, 160));
  const survived = await prisma.invoice.findUnique({ where: { id: M.invoice },
    select: { account_name_snapshot: true, customer_name_snapshot: true, _count: { select: { lines: true } } } });
  check('the corrected addressee SURVIVED the re-issue', survived.account_name_snapshot === 'Otley Groundworks (Yorkshire) Limited',
    `${survived.account_name_snapshot} — a rebuild policy would have re-read the customer and silently undone it`);
  check('  …and the money re-froze in the same pass', survived._count.lines > 0, `${survived._count.lines} lines`);

  // ── 6. THE SERVED DOCUMENT ───────────────────────────────────────────────────────────────────
  console.log('\n— the page a person looks at —');
  await admin.goto(`${BASE}/admin/invoices/${M.invoice}`, { waitUntil: 'domcontentloaded' });
  await admin.waitForSelector('[data-testid="addressee-history"]', { timeout: 30000 }).catch(() => {});
  const body = await admin.evaluate(() => document.body.innerText);
  check('the document rendered', /Bill to/i.test(body), body.length ? `${body.length} chars` : 'BLANK BODY — the tree rendered nothing');
  check('  …addressed to the corrected party', /Otley Groundworks \(Yorkshire\) Limited/.test(body));
  check('  …and saying it was corrected, with what it said before',
    /addressed to/i.test(body) && new RegExp(PERSON).test(body),
    'a customer holding two copies must be able to tell why they differ');

  // ── 7. A CREDIT NOTE CLOSES THE DOOR ─────────────────────────────────────────────────────────
  console.log('\n— once a credit note exists, the pair must not be split —');
  const { mintCreditNote } = await import('../lib/credit-note.ts');
  let cn = null;
  await prisma.$transaction(async (tx) => {
    cn = await mintCreditNote(tx, { groupId: ZZ, invoiceId: C.invoice, dateIssued: new Date(), reason: 'Addressee fixture credit', createdBy: null,
      lines: [{ position: 0, description: 'Fixture credit', item_type: 'labour', qty: 1, unit_price: 200, vat_rate: 20, line_total: 200, line_vat: 40 }] });
  }, { timeout: 30000 });
  fix.creditNote = cn?.id ?? null;
  const cnUnlock = await post(admin, '/api/invoice-unlock', { invoiceId: C.invoice, action: 'unlock' });
  check('an invoice with a credit note can still be unlocked', cnUnlock.status === 200, JSON.stringify(cnUnlock.body).slice(0, 100));
  const refusedCn = await post(admin, '/api/invoice-addressee', { invoiceId: C.invoice, ...correction, customerName: PERSON_CN });
  check('  …but its addressee cannot be corrected', refusedCn.status === 409, `HTTP ${refusedCn.status}`);
  check('  …and the refusal names the credit note', /credit note/i.test(refusedCn.body?.message ?? ''),
    JSON.stringify(refusedCn.body?.message ?? '').slice(0, 160));
  const untouched = await prisma.invoice.findUnique({ where: { id: C.invoice }, select: { account_name_snapshot: true } });
  check('  …and nothing was written before the refusal', untouched.account_name_snapshot === null);
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
    for (const f of [fix.m, fix.c].filter(Boolean)) {
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
    // AuditLog rows are NEVER deleted (standing rule) — the correction happened, and a row
    // referencing a removed fixture is a record, not an orphan.
    check('teardown removed every fixture row (ZZ only)',
      (await prisma.customer.count({ where: { group_id: ZZ, name: { in: [PERSON, PERSON_CN] } } })) === 0
      && (await prisma.vehicle.count({ where: { group_id: ZZ, registration: { in: [REG, REG_CN] } } })) === 0);
  }
}

console.log(`\n${out.filter((x) => x === 'F').length} failures of ${out.length}`);
await prisma.$disconnect();
process.exit(out.includes('F') ? 1 : 0);
