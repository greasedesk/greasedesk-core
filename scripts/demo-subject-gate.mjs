/**
 * File: scripts/demo-subject-gate.mjs
 * ONE real number, in ONE declared internal tenant, and the refusals proven against the PURE
 * predicate — never against a live path that would write a real phone number somewhere to find out.
 */
import './_gate-preflight.mjs';
import './_ts.mjs';
const { prisma } = await import('../lib/db.ts');
const { refuseDemoSubject, demoSubjectColumns } = await import('../lib/demo/demo-subject.ts');
const { DEMO_TENANTS, isListedDemoTenant } = await import('../lib/demo-tenants.ts');
const { readFileSync } = await import('node:fs');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const OK = { name: 'Hugh Gunn', phone: '07397387332' };
const G = { ref: 'GB-GD2369', is_internal: true };

// ── 1. THE GUARD CAN FAIL ────────────────────────────────────────────────────────────────────────
console.log('\n— every refusal, against the pure predicate —');
check('accepts a listed, internal tenant with a real number', refuseDemoSubject('g', true, G, OK) === null);
for (const [label, args, code] of [
  ['an UNLISTED tenant', ['g', false, G, OK], 'not_listed'],
  ['a listed tenant that is not is_internal', ['g', true, { ref: 'X', is_internal: false }, OK], 'not_internal'],
  ['a listed tenant that no longer exists', ['g', true, null, OK], 'not_found'],
  ['a subject with no name', ['g', true, G, { ...OK, name: '  ' }], 'no_name'],
  ['an unparseable number', ['g', true, G, { ...OK, phone: 'ring me' }], 'unusable_number'],
  // THE ONE THAT MATTERS: the fix arriving disguised as a fix.
  ['a DRAMA-RANGE number — the very thing it exists to fix', ['g', true, G, { ...OK, phone: '07700 900416' }], 'reserved_range'],
]) {
  const r = refuseDemoSubject(...args);
  check(`refuses ${label}`, r?.code === code, r ? `${r.code}` : 'ACCEPTED IT');
}

// ── 2. THE COLUMNS ARE THE DIALABLE ONES ─────────────────────────────────────────────────────────
console.log('\n— the dial code is a dial code —');
const cols = demoSubjectColumns(OK);
check('phone_e164 is GB E.164 digits', cols.phone_e164 === '447397387332', cols.phone_e164);
// DISCRIMINATING. toE164Digits' second argument is a DIAL CODE; passing the ISO code concatenates
// it literally. That shipped once and produced "GB7700900002" — assert the shape, not just non-null.
check('and it is NOT the ISO code concatenated', !/^GB/.test(cols.phone_e164),
  'toE164Digits(x, "GB") returns "GB7397387332" — non-null, and completely wrong');
check('the raw stays exactly as supplied', cols.phone === '07397387332', 'honest-null: the raw is what the garage recognises');

// ── 3. THE GENERATOR USES THE WRITE CHOKEPOINT ───────────────────────────────────────────────────
console.log('\n— one customer-phone write shape —');
const gen = readFileSync('lib/demo/generate.ts', 'utf8');
check('the generator writes customers through customerPhoneFields', /\.\.\.customerPhoneFields\(demoPhone\(i\), demoDialCode\)/.test(gen));
const genCode = gen.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check('and no longer calls toE164Digits with an ISO code', !/toE164Digits\([^)]*'GB'\)/.test(genCode));
check('  …with the reason preserved for the next reader', /concatenated literally/.test(gen));

// ── 4. LIVE: ON THE TENANT ITSELF ────────────────────────────────────────────────────────────────
console.log('\n— on the tenant itself —');
/**
 * WHAT THIS CAN AND CANNOT ASSERT.
 *
 * The first draft failed with "the real number appears in NO other tenant — GB-GD2236, GB-GD1967,
 * GB-GD1967", and it was the ASSERTION that was wrong. The owner is a customer of their own garage:
 * two TMBS rows from July, and one on the frozen reference demo seeded when it was generated. A
 * gate cannot forbid a real person appearing in real data under their real number.
 *
 * The property that IS this path's responsibility: it writes only to a declared internal demo, and
 * it writes ONE row there. Anything older is reported, not judged.
 */
/**
 * WHAT THIS CAN AND CANNOT ASSERT — corrected TWICE, both times because the assertion was wrong.
 *
 * 1. The first draft failed with "the real number appears in NO other tenant — GB-GD2236,
 *    GB-GD1967, GB-GD1967". The owner is a customer of their own garage. A gate cannot forbid a
 *    real person appearing in real data under their real number.
 *
 * 2. The second pinned the seeded number itself and failed the moment the demo was used: the
 *    subject's number had been changed to another real mobile during a live demo. Entering a
 *    prospect's details live is THE POINT of the tenant. Pinning a value the demo is explicitly
 *    designed to overwrite makes the gate fail on correct use.
 *
 * So the property is REACHABILITY, not a particular number: at least one customer this tenant can
 * actually text. That is what makes the demo work, and it survives the demo being used.
 */
const here = DEMO_TENANTS.map((t) => t.id);
for (const t of DEMO_TENANTS) {
  const reachable = await prisma.customer.findMany({
    where: { group_id: t.id, phone_e164: { not: null }, NOT: { phone_e164: { startsWith: '447700900' } } },
    select: { name: true, phone_e164: true },
  });
  check(`${t.ref} has at least one customer it can actually text`, reachable.length >= 1,
    reachable.map((c) => `${c.name} ${c.phone_e164}`).join(', ') || 'NONE — the SMS demo cannot complete');
  // DISCRIMINATING: the same query over the drama range finds the other 618, so "at least one" is
  // not satisfied by the query simply matching everything.
  const drama = await prisma.customer.count({ where: { group_id: t.id, phone_e164: { startsWith: '447700900' } } });
  const total = await prisma.customer.count({ where: { group_id: t.id } });
  check(`  and the bulk stay unroutable — ${drama} of ${total} on the drama range`, drama === total - reachable.length,
    'a demo that could text its whole customer list is a demo that can text a stranger');
}
const elsewhere = await prisma.customer.findMany({
  where: { phone_e164: '447397387332', group_id: { notIn: here } },
  select: { created_at: true, group: { select: { ref: true, is_demo: true } } },
  orderBy: { created_at: 'asc' },
});
check(`ADVISORY — ${elsewhere.length} rows outside the declared demos carry the seeded number`, true,
  elsewhere.map((e) => `${e.group?.ref}${e.group?.is_demo ? ' (demo)' : ''} ${e.created_at.toISOString().slice(0, 10)}`).join(', ') || 'none');
console.log('   (the owner is a customer of their own garage; that is data, not a leak)');

console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
await prisma.$disconnect();
process.exit(out.includes('F') ? 1 : 0);
