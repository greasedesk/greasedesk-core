/**
 * File: scripts/redaction-gate.mjs
 * @gate-requires: db, server
 *
 * THE V5C REFERENCE NEVER COMES BACK OUT.
 *
 * A logbook reference transfers keepership and taxes a car online. The garage holds it legitimately;
 * holding it is the whole of the permission. This gate asserts the three ways it could escape —
 * an audit diff, an API response, a refusal that echoes the form back — and asserts them
 * BEHAVIOURALLY where it can, because a comment promising redaction is what we had before.
 *
 * The class, not the field: the redactor is asserted on the SHAPES a diff actually takes (nested,
 * arrays, mixed spellings), so a second sensitive field added to REDACTED_KEYS inherits the coverage.
 */
import './_gate-preflight.mjs';
const { gatePrisma, describeError, ZZ_GROUP, gateOrigin, serverReady } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const R = await import('../lib/redact.ts');
const { hasKey, countKey } = await import('../lib/anchored-match.ts');
const { readFileSync } = await import('node:fs');
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const SECRET = 'V5C99887766';

let prisma;
let browser = null;
let made = { vehicles: [], items: [] };
try {
  prisma = await gatePrisma();

  console.log('\n— the redactor, on the shapes a diff actually takes —');
  check('a flat diff loses the value',
    R.redactDeep({ v5c_reference: SECRET }).v5c_reference === R.REDACTED_PLACEHOLDER);
  check('the camelCase spelling too — a diff is built from whichever the writer had to hand',
    R.redactDeep({ v5cReference: SECRET }).v5cReference === R.REDACTED_PLACEHOLDER);
  check('and case-insensitively', R.redactDeep({ V5C_Reference: SECRET }).V5C_Reference === R.REDACTED_PLACEHOLDER);
  check('NESTED — the { before, after } shape most diffs are actually written in',
    R.redactDeep({ before: { v5c_reference: SECRET }, after: { v5c_reference: 'X' } }).before.v5c_reference
      === R.REDACTED_PLACEHOLDER,
    'a redactor that only checked the top level is green on every test and useless on the stored shape');
  check('inside an ARRAY of changes',
    R.redactDeep({ changes: [{ field: 'reg' }, { v5c_reference: SECRET }] }).changes[1].v5c_reference
      === R.REDACTED_PLACEHOLDER);
  check('four levels down', R.redactDeep({ a: { b: { c: { v5c_reference: SECRET } } } }).a.b.c.v5c_reference
      === R.REDACTED_PLACEHOLDER);
  check('a registration is NOT redacted — over-redacting makes a trail useless in the other direction',
    R.redactDeep({ registration: 'YE64KLM' }).registration === 'YE64KLM');
  check('absent stays absent — null is not replaced by a placeholder claiming a value was there',
    R.redactDeep({ v5c_reference: null }).v5c_reference === null);
  check('a cycle is cut, not thrown on — this runs on the way to a write that must not fail',
    (() => { const o = { v5c_reference: SECRET }; o.self = o; try { return R.redactDeep(o).v5c_reference === R.REDACTED_PLACEHOLDER; } catch { return false; } })());

  console.log('\n— the leak detector finds a KNOWN case before it is trusted to report none —');
  check('a planted leak is found', R.redactionLeaks({ a: { b: { v5c_reference: SECRET } } }).length === 1);
  check('  …and it names the PATH, not just that something leaked',
    R.redactionLeaks({ a: { b: { v5c_reference: SECRET } } })[0] === 'a.b.v5c_reference');
  check('  …and a redacted structure reports clean', R.redactionLeaks(R.redactDeep({ a: { v5c_reference: SECRET } })).length === 0);

  console.log('\n— every audit writer goes through it, structurally —');
  const audit = strip(readFileSync('lib/audit.ts', 'utf8'));
  const diffLines = audit.split('\n').filter((l) => hasKey(l, 'diff_json'));
  check('lib/audit.ts still has diff_json writers to guard', diffLines.length >= 4, `${diffLines.length}`);
  check('EVERY one of them is built by the shared helper',
    diffLines.every((l) => hasKey(l, 'diff_json', /diffJson\(/)),
    diffLines.filter((l) => !hasKey(l, 'diff_json', /diffJson\(/)).join(' | ') || 'all four');
  check('  …and the helper actually calls the redactor',
    /const diffJson\s*=[\s\S]{0,240}redactDeep\(/.test(audit));

  console.log('\n— and the value never leaves the database, through the real server —');
  const ready = await serverReady();
  check('the dev server serves pages before we drive it', ready.ok, `HTTP ${ready.status}`);
  const origin = gateOrigin();
  const veh = await prisma.vehicle.create({
    data: {
      group_id: ZZ_GROUP, registration: `ZZRDC${Math.floor(Math.random() * 900 + 100)}`,
      registration_normalized: null, v5c_reference: SECRET,
    },
    select: { id: true, registration: true },
  });
  made.vehicles.push(veh.id);
  check('the fixture really holds the secret, so a clean response means something',
    (await prisma.vehicle.findUnique({ where: { id: veh.id }, select: { v5c_reference: true } })).v5c_reference === SECRET,
    'without this, every clause below passes on a car that never had one');

  /**
   * AND IT HAS TO BE IN THE LIST, or the clause below is unfalsifiable. A car with a V5C and no stock
   * record never appears in GET /api/stock at all, so "the response does not contain it" would have
   * been true of a response that never mentioned the car. The fixture must be able to leak before its
   * not leaking says anything.
   */
  const zzOwner = await prisma.user.findFirst({ where: { group_id: ZZ_GROUP }, select: { id: true } });
  const item = await prisma.stockItem.create({
    data: {
      group_id: ZZ_GROUP, vehicle_id: veh.id, created_by_user_id: zzOwner.id,
      acquired_at: new Date('2026-01-05T12:00:00Z'), purchase_pence: 100000,
      vat_status: 'margin', source: 'auction',
    },
    select: { id: true },
  });
  made.items.push(item.id);

  // REACHED THE WAY A USER REACHES IT: a real sign-in, then the API through that session's cookies.
  browser = await chromium.launch({ channel: 'chrome' });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${origin}/admin/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', 'owner@zzgategarage.test');
  await page.fill('input[type="password"]', 'GateGarage!2026');
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }), page.click('button[type="submit"]')]);

  const res = await ctx.request.get(`${origin}/api/stock`);
  const text = await res.text();
  check('GET /api/stock returns 200 to a signed-in user', res.status() === 200, `${res.status()}`);
  check('  …and the body contains no V5C value anywhere', !text.includes(SECRET));
  check('  …and no v5c key either, so nothing is one select away from it',
    !/v5c/i.test(text), 'the field must not be in the response shape at all');

  // A REFUSAL IS A RESPONSE TOO. The form posts the reference; a 400 that echoes the body back is the
  // leak nobody looks for, because the happy path is the one that got checked.
  const bad = await ctx.request.post(`${origin}/api/stock`, {
    data: { registration: '', v5cReference: SECRET, acquiredAt: '2025-01-01' },
  });
  const badText = await bad.text();
  check('a REFUSAL does not echo the reference back', bad.status() >= 400 && !badText.includes(SECRET),
    `${bad.status()}`);

  console.log('\n— and no reader is one select away from it —');
  const store = strip(readFileSync('lib/stock-store.ts', 'utf8'));
  check('stock-store never SELECTS the column into anything it returns',
    countKey(store, 'v5c_reference', 'true') === 0,
    'writing it is the permission; reading it back is a separate decision with its own guard');
  const pages = ['pages/admin/stock.tsx', 'pages/api/stock.ts'];
  check('no page or route renders the stored value',
    pages.every((f) => !/v5c_reference/.test(strip(readFileSync(f, 'utf8')))));
  check('the column carries its warning in the DATABASE, where the next SELECT is written',
    /COMMENT ON COLUMN "Vehicle"\."v5c_reference"/.test(
      readFileSync('prisma/migrations/20260913210000_stock_intake_attributes/migration.sql', 'utf8')));

} catch (e) {
  check('run completed', false, describeError(e).slice(0, 200));
} finally {
  await browser?.close().catch(() => {});
  if (prisma) {
    try {
      if (made.items.length) {
        await prisma.stockItem.deleteMany({ where: { id: { in: made.items }, group_id: ZZ_GROUP } });
      }
      if (made.vehicles.length) {
        const v = await prisma.vehicle.deleteMany({ where: { id: { in: made.vehicles }, group_id: ZZ_GROUP } });
        check('teardown removed the fixture car', v.count === made.vehicles.length, `${v.count} of ${made.vehicles.length}`);
      }
      // SCOPED TO THIS RUN'S OWN SHAPE, and to a broken path's leavings: a teardown that removes only
      // what it REMEMBERED cannot remove what a failed code path created under the same prefix.
      const strayCars = await prisma.vehicle.findMany({
        where: { group_id: ZZ_GROUP, registration: { startsWith: 'ZZRDC' } }, select: { id: true },
      });
      if (strayCars.length) {
        // THE STOCK ROW FIRST — Vehicle.stockItems is onDelete: Restrict, so a car the run did not
        // track cannot be removed while one hangs off it. RESTRICT is the database knowing.
        await prisma.stockItem.deleteMany({ where: { vehicle_id: { in: strayCars.map((c) => c.id) } } });
      }
      const strays = await prisma.vehicle.deleteMany({
        where: { group_id: ZZ_GROUP, registration: { startsWith: 'ZZRDC' } },
      });
      if (strays.count) check('  …including a car the run did not track', true, `${strays.count} swept`);
      const left = await prisma.vehicle.count({ where: { group_id: ZZ_GROUP, v5c_reference: { not: null } } });
      check('ZZ holds no car with a V5C reference again', left === 0, `${left}`);
    } catch (e) { check('teardown completed', false, describeError(e).slice(0, 200)); }
  }
}
console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
await prisma?.$disconnect();
process.exit(out.includes('F') ? 1 : 0);
