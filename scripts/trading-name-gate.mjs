/**
 * File: scripts/trading-name-gate.mjs
 * One field, two jobs, separated: the registered name bills; the trading name is what customers see.
 *
 * ── WHAT WAS ACTUALLY WRONG ─────────────────────────────────────────────────────────────────────
 * `Group.trading_name` already existed and was ALREADY read by the SMS, the quote document, the
 * quote-respond email and the inbound forward — all with `trading_name || group_name`. It was never
 * EDITABLE, so it is NULL for every real tenant and every reader falls through to the registered
 * name. The owner changed "Company Name" in Settings and saw it appear in the next text, which is
 * that fallback working exactly as designed on an empty field.
 *
 * So this slice is not "add a field". It is: make it editable, normalise the empty case at the
 * write, finish the readers that still take the legal name, and — the part that cannot be
 * retrofitted — FREEZE IT ONTO THE DOCUMENTS.
 *
 * ── THE SNAPSHOT IS THE POINT ───────────────────────────────────────────────────────────────────
 * A garage that rebrands must not have every historical invoice reprint under the new name. An
 * invoice is a record of what the customer received, not a view of who the garage is today — the
 * same rule that stops a labour rate revaluing a closed month.
 */
import './_gate-preflight.mjs';
import './_ts.mjs';
const { prisma } = await import('../lib/db.ts');
const { resolveCompanyIdentity } = await import('../lib/invoice.ts');
const { readFileSync } = await import('node:fs');

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };

let restore;
try {
  // ── 1. THE RESOLVER KEEPS THE LEGAL NAME AND CARRIES THE TRADING ONE ───────────────────────
  console.log('\n— the identity resolver —');
  const G = (trading) => ({ group_name: 'The Mini Specialist Ltd', trading_name: trading, company_number: '1', vat_number: 'GB1', address: 'A' });
  const both = resolveCompanyIdentity(G('The Mini & BMW Specialist'), null);
  check('`name` stays the REGISTERED name', both.name === 'The Mini Specialist Ltd',
    'a VAT invoice must identify the supplier; for a limited company that is the registered name');
  check('the trading name is carried ALONGSIDE, not instead', both.tradingName === 'The Mini & BMW Specialist');
  const none = resolveCompanyIdentity(G(null), null);
  check('unset stays NULL — not silently the legal name', none.tradingName === null,
    'a snapshot that duplicates the legal name cannot later be told from one that genuinely matched it');
  check('whitespace-only is treated as unset', resolveCompanyIdentity(G('   '), null).tradingName === null);

  // ── 2. '' → NULL AT THE WRITE ──────────────────────────────────────────────────────────────
  console.log('\n— the empty case is normalised once, at the writer —');
  const api = readFileSync('pages/api/company.ts', 'utf8');
  check('the API normalises an empty trading name to NULL',
    /data\.trading_name = trading_name\.trim\(\)\.slice\(0, 120\) \|\| null;/.test(api),
    'a cleared input submits "", and a column carrying "" means two kinds of unset for N readers');
  // Round-trip it against the real column, because the rule is about what lands in the database.
  const before = (await prisma.group.findUnique({ where: { id: ZZ }, select: { trading_name: true } })).trading_name;
  restore = before;
  await prisma.group.update({ where: { id: ZZ }, data: { trading_name: '' } });
  const empty = (await prisma.group.findUnique({ where: { id: ZZ }, select: { trading_name: true } })).trading_name;
  check('the check is discriminating — the COLUMN itself will hold ""', empty === '',
    'so the normalisation has to happen at the writer; the database will not do it for us');
  await prisma.group.update({ where: { id: ZZ }, data: { trading_name: restore } });

  // ── 3. THE FALLBACK CHAIN, WHEREVER IT IS READ ─────────────────────────────────────────────
  console.log('\n— trading || legal, everywhere a customer sees a name —');
  for (const [f, label] of [
    ['pages/api/invoice-sms.ts', 'invoice SMS'],
    ['pages/api/quote-send.ts', 'quote SMS'],
    ['lib/quote-doc.ts', 'quote document'],
    ['pages/api/quote-respond.ts', 'quote-respond email'],
    ['lib/inbound.ts', 'inbound forward'],
  ]) {
    check(`${label} uses trading || legal`, /trading_name\s*\|\|\s*(g|v\.group|card\.group|group)\??\.?group_name/.test(readFileSync(f, 'utf8')));
  }
  const mail = readFileSync('lib/invoice-email-send.ts', 'utf8');
  check('the invoice email SUBJECT uses the display name', /garage: displayName/.test(mail));
  check('and the body does too', /garageName: displayName/.test(mail));
  check('invoice_sender_name NARROWS it rather than competing',
    /const senderName = \(group\.invoice_sender_name \|\| ''\)\.trim\(\) \|\| displayName;/.test(mail),
    'sender || trading || legal — one chain, so a garage that sets only a trading name gets it here too');

  // ── 4. THE VAT-BEARING READS KEEP THE LEGAL NAME ───────────────────────────────────────────
  console.log('\n— what must NOT change —');
  const issue = readFileSync('lib/invoice-issue.ts', 'utf8');
  check('the invoice mint freezes the REGISTERED name as company_name_snapshot',
    /company_name_snapshot: identity\.name,/.test(issue));
  const invLib = readFileSync('lib/invoice.ts', 'utf8');
  check('resolveCompanyIdentity still returns the registered name as `name`', /name: group\.group_name,/.test(invLib),
    'the discriminator for the whole slice — if this ever became the trading name, VAT documents would misidentify the supplier');
  for (const f of ['pages/api/reports/vat-summary.ts', 'pages/admin/reports/vat.tsx']) {
    check(`${f.split('/').pop()} does not switch to the trading name`, !/trading_name/.test(readFileSync(f, 'utf8')));
  }

  // ── 5. FROZEN ON BOTH DOCUMENTS ────────────────────────────────────────────────────────────
  console.log('\n— frozen at issue, on both document types —');
  check('the invoice mint writes company_trading_name_snapshot',
    /company_trading_name_snapshot: identity\.tradingName \?\? null,/.test(issue));
  const cn = readFileSync('lib/credit-note.ts', 'utf8');
  check('the credit note COPIES it from the invoice, not from the tenant today',
    /company_trading_name_snapshot: inv\.company_trading_name_snapshot,/.test(cn),
    'a credit note showing a newer name than the invoice it corrects would not read as a pair');
  const cols = await prisma.$queryRawUnsafe(
    `SELECT table_name FROM information_schema.columns
      WHERE column_name = 'company_trading_name_snapshot' ORDER BY table_name`);
  check('both tables carry the column', cols.map((c) => c.table_name).join(',') === 'CreditNote,Invoice',
    cols.map((c) => c.table_name).join(', ') || 'NONE');
  // Discriminating: the query finds columns that DO exist, so "both present" is not vacuous.
  const sane = await prisma.$queryRawUnsafe(
    `SELECT table_name FROM information_schema.columns WHERE column_name = 'company_name_snapshot' ORDER BY table_name`);
  check('the check is discriminating — the same query finds the existing snapshot too', sane.length >= 2);

  // ── 6. THE NULL IS TEMPORAL, AND SAYS SO ───────────────────────────────────────────────────
  const schema = readFileSync('prisma/schema.prisma', 'utf8');
  check('the column explains that its NULL is TEMPORAL, not forgotten',
    /NULL is TEMPORAL and honest/.test(schema),
    'rows issued before it existed carried no trading name; the renderer falls back rather than pretending');
  const existing = await prisma.invoice.count({ where: { company_trading_name_snapshot: null } });
  const total = await prisma.invoice.count();
  check('no backfill was invented for historical documents', existing === total,
    `${existing} of ${total} pre-date the column — asserting a trading name for them would be a claim nobody recorded`);
} catch (e) {
  check('run completed', false, String(e?.message ?? e).slice(0, 300));
} finally {
  if (restore !== undefined) {
    await prisma.group.update({ where: { id: ZZ }, data: { trading_name: restore } });
    const now = (await prisma.group.findUnique({ where: { id: ZZ }, select: { trading_name: true } })).trading_name;
    check('teardown restored the tenant’s trading name exactly', now === restore, `${JSON.stringify(restore)} → ${JSON.stringify(now)}`);
  }
  console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
  await prisma.$disconnect();
  process.exit(out.includes('F') ? 1 : 0);
}
