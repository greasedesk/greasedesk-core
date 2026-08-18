/**
 * File: scripts/demo-profile-gate.mjs
 * Does lib/demo/profile.ts leak anything of TMBS's, and is it reproducible?
 *
 * ── WHAT "NOTHING IDENTIFYING SURVIVES" ACTUALLY MEANS ──────────────────────────────────────────
 * The first version of this gate compared every source string against the file and failed on
 * "Barry", "Keith", "Cooper" and "3 Series". None of those is a leak: the authored name pool holds
 * common GB names and the authored vehicle mix holds the cars a UK independent sees, so collision
 * with a 191-customer list is arithmetic, not transcription. A test that cries wolf is a test that
 * gets deleted, so the scope is now stated rather than maximal.
 *
 * STRICT — any hit is a leak, and the run fails:
 *   registrations, VINs, emails, phone numbers, addresses, FULL customer names (forename AND
 *   surname as a unit), the group/trading/site names, the VAT number, and invoice-line free text.
 *   These are either unique to a person or unique to the business.
 *
 * ADVISORY — measured, reported, and failed only if IMPLAUSIBLE:
 *   single-token overlap between the authored pools and the source. A handful of shared first
 *   names is coincidence; most of the pool matching would mean somebody had sourced it from the
 *   tenant, which is the thing actually worth catching. Threshold 60%.
 *
 * Plus: BYTE-IDENTICAL on re-run. A profile that drifts is one nobody can review, and its diff
 * stops meaning anything.
 *
 * Run after every extraction. It is READ-ONLY against the tenant and writes nothing.
 */
import './_gate-preflight.mjs';
import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const prisma = new PrismaClient();
const TMBS = '854d38e7-6dd4-4836-af61-a0d169639a78';
const PATH = 'lib/demo/profile.ts';

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };

const profile = readFileSync(PATH, 'utf8');
const haystack = profile.toLowerCase();

const norm = (v) => String(v ?? '').trim().toLowerCase();
const flatten = (v) => norm(v).replace(/[^a-z0-9]/g, '');
/** The profile with all whitespace and punctuation stripped — catches a value re-spaced or
 *  re-punctuated on its way in, which a plain substring test would miss. */
const flat = flatten(profile);

// ── THE CORPUS, SPLIT BY WHAT A HIT WOULD MEAN ───────────────────────────────────────────────────
const [customers, vehicles, lines, group, sites] = await Promise.all([
  prisma.customer.findMany({ where: { group_id: TMBS }, select: { name: true, email: true, phone: true, address: true } }),
  prisma.vehicle.findMany({ where: { group_id: TMBS }, select: { registration: true, make: true, model: true, vin: true } }),
  prisma.invoiceLine.findMany({ where: { invoice: { is: { group_id: TMBS } } }, select: { description: true } }),
  prisma.group.findUnique({ where: { id: TMBS }, select: { group_name: true, trading_name: true, vat_number: true, address: true, billing_email: true } }),
  prisma.site.findMany({ where: { group_id: TMBS }, select: { site_name: true, address: true, phone: true } }),
]);

console.log(`corpus: ${customers.length} customers, ${vehicles.length} vehicles, ${lines.length} lines\n`);

/** Unique to a person or to the business. Any appearance is a leak. */
const STRICT = [
  ...customers.map((c) => c.email),
  ...customers.map((c) => c.phone),
  ...customers.map((c) => c.address),
  // A FULL name, not its parts — "Barry" is a coincidence, "Barry Sutcliffe" is a person.
  ...customers.map((c) => (norm(c.name).split(/\s+/).length >= 2 ? c.name : null)),
  ...vehicles.map((v) => v.registration),
  ...vehicles.map((v) => v.vin),
  // Free text carries the garage's own phrasing; anything substantial is theirs.
  ...lines.map((l) => (norm(l.description).length >= 12 ? l.description : null)),
  group?.group_name, group?.trading_name, group?.vat_number, group?.address, group?.billing_email,
  ...sites.flatMap((s) => [s.site_name, s.address, s.phone]),
].filter((v) => v && String(v).trim().length >= 5);

const strictHits = [...new Set(STRICT.filter((v) => flat.includes(flatten(v)) || haystack.includes(norm(v))))];
check('STRICT — no person, vehicle, address or free-text string survives', strictHits.length === 0,
  strictHits.length ? `${strictHits.length} HIT(S): ${strictHits.slice(0, 6).join(' | ')}` : `clean across ${STRICT.length} values`);

// Registrations again, spacing ignored — the shape is unmistakable and a partial is still a leak.
const regs = vehicles.map((v) => flatten(v.registration)).filter((r) => r.length >= 5);
const regHits = regs.filter((r) => flat.includes(r));
check('no registration survives, spacing ignored', regHits.length === 0, regHits.slice(0, 5).join(', ') || `clean across ${regs.length}`);

// ── ADVISORY: is the authored pool plausibly authored, or was it sourced? ────────────────────────
const poolOf = (name) => {
  const m = profile.match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const;`));
  return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];
};
const authored = [...poolOf('FIRST_NAMES'), ...poolOf('LAST_NAMES'), ...poolOf('STREETS')];
const sourceTokens = new Set();
for (const v of [...customers.map((c) => c.name), ...customers.map((c) => c.address)]) {
  for (const t of norm(v).split(/[^a-z]+/)) if (t.length >= 4) sourceTokens.add(t);
}
const overlap = authored.filter((a) => norm(a).split(/[^a-z]+/).some((t) => t.length >= 4 && sourceTokens.has(t)));
const rate = authored.length ? overlap.length / authored.length : 0;
check(`ADVISORY — the authored pool looks authored, not sourced (${(rate * 100).toFixed(0)}% overlap, fails above 60%)`,
  rate <= 0.6, `${overlap.length}/${authored.length} collide: ${overlap.slice(0, 8).join(', ')}`);
console.log('   (a shared common forename is arithmetic; a pool that mostly matched would not be)\n');

// ── 2. REPRODUCIBLE ──────────────────────────────────────────────────────────────────────────────
/**
 * THE PROPERTY IS DETERMINISM, NOT STASIS — and the two are not the same check.
 *
 * This used to compare a fresh extract against the COMMITTED file and fail when they differed.
 * That reads as "the extractor is reproducible" but actually asserts "TMBS has not traded since the
 * profile was last committed" — and TMBS is a live garage. It duly failed on 2026-08-18 with a
 * longer max job duration, an older p90 vehicle and a footprint ratio of 1.27 against 1.32: three
 * real numbers moving because a real workshop did real work. Nothing was broken.
 *
 * So: run the extractor TWICE and compare the two outputs to each other. That fixes the input and
 * tests the only thing the extractor controls. Drift from the committed file is reported as
 * ADVISORY, with the deltas, because it is information — the profile is a calibration INPUT chosen
 * offline, and re-adopting today's TMBS numbers is a decision a person makes, not a gate.
 *
 * The committed file is restored either way. A gate that leaves a tracked file rewritten has
 * performed a teardown failure on the repository.
 */
const committed = createHash('sha256').update(profile).digest('hex');
try {
  execSync('node scripts/demo-profile-extract.mjs', { stdio: 'pipe' });
  const runA = readFileSync(PATH, 'utf8');
  execSync('node scripts/demo-profile-extract.mjs', { stdio: 'pipe' });
  const runB = readFileSync(PATH, 'utf8');
  const a = createHash('sha256').update(runA).digest('hex');
  const b = createHash('sha256').update(runB).digest('hex');
  check('the extractor is DETERMINISTIC — two runs against the same tenant agree', a === b,
    `${a.slice(0, 16)} vs ${b.slice(0, 16)}`);

  const drifted = a !== committed;
  // The DIFF ITSELF, not a reconstructed key→value map. An earlier version regexed `"key": number`
  // out of both files and paired them by key, which silently paired ARRAY INDICES and reported
  // `8 0.5→0.4` — an advisory naming figures it had not identified. Show the changed lines.
  let deltas = [];
  if (drifted) {
    const wasLines = profile.split('\n'), nowLines = runA.split('\n');
    for (let i = 0; i < Math.max(wasLines.length, nowLines.length); i++) {
      if (wasLines[i] !== nowLines[i]) deltas.push(`${(wasLines[i] ?? '').trim()} → ${(nowLines[i] ?? '').trim()}`.slice(0, 90));
    }
  }
  check(`ADVISORY — the committed profile still matches TMBS today${drifted ? ` (${deltas.length} lines moved)` : ''}`,
    true, drifted ? '' : 'no drift');
  for (const d of deltas.slice(0, 8)) console.log(`     ${d}`);
  if (drifted) console.log('   (TMBS trades; re-adopting is an offline decision, not a gate failure)');
  console.log(`  committed profile sha256: ${committed}`);
} finally {
  // Restore the tracked file the extractor just overwrote, whatever happened above.
  execSync(`git checkout -- ${PATH}`, { stdio: 'pipe' });
  const back = createHash('sha256').update(readFileSync(PATH, 'utf8')).digest('hex');
  check('teardown restored the committed profile exactly', back === committed, `${back.slice(0, 16)}`);
}

console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
await prisma.$disconnect();
process.exit(out.includes('F') ? 1 : 0);
