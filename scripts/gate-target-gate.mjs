/**
 * File: scripts/gate-target-gate.mjs
 * @gate-requires: db
 *
 * WHICH DATABASE AM I, AND WHAT FOLLOWS FROM THE ANSWER.
 *
 * ── WHAT THIS IS GUARDING ───────────────────────────────────────────────────────────────────────
 * On 2026-10-25 a gate run captured the owner's half-typed trial length, restored it over his
 * correction, and the ISR boundary then published a 46-day trial to greasedesk.com as a real
 * offer. Earlier the same day a red-proof nearly rewrote every tenant's trial_ends_at, and a gate
 * left a live OWNER operator on the production database. Three incidents, one cause: gates ran
 * against the database production reads.
 *
 * There is a separate database now, and two checks that must BOTH pass before a gate gets a
 * client. The decision is a pure function so it can be proved here without repointing anything —
 * a gate that could only be tested by aiming it at production would be its own worst hazard.
 */
import './_gate-preflight.mjs';
const { gatePrisma, gateDbRefusal, describeError } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { describeTarget, classifyUrl, endpointOf, PRODUCTION_ENDPOINT_SHA256 } = await import('./_db-target.mjs');
const { readFileSync } = await import('node:fs');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const R = '/Users/hugh/Developer/greasedesk-core';
/**
 * ── NO REAL HOSTNAME IS WRITTEN IN THIS FILE ───────────────────────────────────────────────────
 * The production endpoint is stored in _db-target as a SHA-256 precisely because this repository
 * is public. The first draft of this gate then spelled it out in five connection strings, undoing
 * that in the file whose job is proving it — and gitleaks' greasedesk-database-uri rule caught all
 * five, correctly, even though the credentials in them are fake.
 *
 * So the MECHANISM is proved on synthetic endpoints, and the one clause that needs the real value
 * reads it from the operator's own .migrate-target.production, which is git-ignored and never
 * committed. Absent that file the clause goes RED and says what is missing, rather than passing
 * quietly — a clause that silently skips is worse than one that is not there.
 */
// NO CREDENTIALS IN IT EITHER. classifyUrl and endpointOf parse the HOSTNAME and nothing else, so
// the `user:pass@` the first draft carried was decoration — decoration that made every one of these
// read as a committed connection string to the secret scanner, which is a fair reading.
const url = (ep) => `postgresql://${ep}.example.invalid/db`;
const SYNTH = 'ep-synthetic-not-production';
const realProdEp = (() => {
  try {
    const line = readFileSync(`${R}/.migrate-target.production`, 'utf8')
      .split('\n').map((l) => l.match(/^\s*DATABASE_URL\s*=\s*(.*)$/)).find(Boolean);
    if (!line) return null;
    return new URL(line[1].trim().replace(/^["']|["']$/g, '')).hostname.split('.')[0].replace(/-pooler$/, '');
  } catch { return null; }
})();
const SAFE = { safe: true, runtime: 'other', migrations: 'other', runtimeEndpoint: 'ep-x', migrationsEndpoint: 'ep-x' };

let prisma;
try {
  // ── 1. THE ENDPOINT HALF ────────────────────────────────────────────────────────────────────
  console.log('— the endpoint, answerable with no connection —');
  check('the REAL production endpoint classifies as production, pooled and direct',
    realProdEp != null
      && classifyUrl(url(realProdEp)) === 'production'
      && classifyUrl(url(`${realProdEp}-pooler`)) === 'production',
    realProdEp == null
      ? 'NOT PROVED — .migrate-target.production is absent, so the real endpoint could not be read. '
        + 'It is never committed; create it to prove this clause.'
      : 'the pooled and direct forms are one endpoint; catching only one of them catches nothing');
  check('  …and anything else is NOT production', classifyUrl(url(SYNTH)) === 'other');
  check('an unparseable or absent url is UNKNOWN, never "not production"',
    classifyUrl('not-a-url') === 'unknown' && classifyUrl(undefined) === 'unknown' && classifyUrl('') === 'unknown',
    'silence is not a yes — unknown is treated as production everywhere downstream');
  check('the hash is of ONE endpoint, not of something that matches everything',
    PRODUCTION_ENDPOINT_SHA256.length === 64 && classifyUrl(url('ep-anything-else')) === 'other',
    'a hash that matched every endpoint would refuse every database and read as "very safe"');
  check('-pooler is stripped so the pair compares equal',
    endpointOf(url('ep-a-b-pooler')) === 'ep-a-b' && endpointOf(url('ep-a-b')) === 'ep-a-b');

  // ── 2. THE DECISION, PROVED WITHOUT POINTING ANYTHING ANYWHERE ──────────────────────────────
  console.log('\n— and what follows from it —');
  check('a production endpoint is refused', !!gateDbRefusal({ ...SAFE, safe: false, runtime: 'production' }, 'test'));
  check('an UNKNOWN endpoint is refused', !!gateDbRefusal({ ...SAFE, safe: false, runtime: 'unknown' }, 'test'),
    'the dangerous case is the one nobody can classify, not the one that announces itself');
  check('a marker reading production is refused', !!gateDbRefusal(SAFE, 'production'),
    'this is what catches a RESTORED COPY of production — an unfamiliar endpoint full of customers');
  check('a MISSING marker is refused', !!gateDbRefusal(SAFE, null));
  // THE DISCRIMINATOR. Without it the four refusals above pass against a function that refuses
  // everything, which is exactly how a guard ends up blocking all work and being deleted.
  check('  …and a test marker on a non-production endpoint is ALLOWED', gateDbRefusal(SAFE, 'test') === null,
    'otherwise the four refusals prove only that the door is nailed shut');
  check('BOTH are required — neither alone opens it',
    gateDbRefusal({ ...SAFE, safe: false }, 'test') !== null && gateDbRefusal(SAFE, 'production') !== null,
    'each covers the other’s blind spot: the endpoint cannot see a restored copy, the marker cannot see a database with no schema');

  // ── 3. AND gatePrisma ACTUALLY ASKS ─────────────────────────────────────────────────────────
  // The decision being right is worth nothing if the thing that hands out clients does not consult
  // it. 117 gates get their client from that one function.
  const pre = readFileSync(`${R}/scripts/_gate-preflight.mjs`, 'utf8');
  const fn = pre.slice(pre.indexOf('export async function gatePrisma'));
  check('gatePrisma consults the decision and declines on it',
    /gateDbRefusal\(/.test(fn) && /declineToRun\(/.test(fn.slice(0, fn.indexOf('return prisma'))),
    'a gate pointed at the wrong database has not tested anything, so it is UNRUN and not a red');

  prisma = await gatePrisma();

  // ── 4. THIS DATABASE SENDS NOTHING ──────────────────────────────────────────────────────────
  console.log('\n— and nothing is sent from it —');
  const E = await import(`${R}/lib/environment.ts`);
  const here = await E.readEnvironment(prisma);
  check('the marker reads test on the database this gate is using', here.kind === 'test', JSON.stringify(here));
  const refusal = await E.environmentSendRefusal(prisma);
  check('  …so every send is refused', refusal.refuse === true && refusal.skipCode === 'test_environment',
    JSON.stringify(refusal));
  check('  …under its OWN code, not demo_tenant’s',
    refusal.skipCode !== 'demo_tenant',
    'a real database holding an invented tenant and a different database entirely are two silences, not one');

  // AN UNREADABLE MARKER REFUSES, AND THE FAILURE IS NOT CACHED (owner ruling, 2026-10-26).
  E.__resetEnvironmentCache();
  const throwing = { environment: { findUnique: async () => { throw new Error('connection reset'); } } };
  const first = await E.environmentSendRefusal(throwing);
  check('an unreadable marker refuses too', first.refuse === true && first.skipCode === 'environment_unknown',
    JSON.stringify(first));
  // THE CLAUSE THE RULING IS ABOUT: a cached failure would mean a transient fault at boot stopped
  // production email until the next deploy. The very next send must try again.
  const second = await E.readEnvironment(prisma);
  check('  …and the FAILURE IS NOT CACHED — the next read tries again',
    second.kind === 'test' && second.cached === false,
    `${JSON.stringify(second)} — a cached failure turns seconds of trouble into hours of silence`);
  const third = await E.readEnvironment(prisma);
  check('  …while a SUCCESS is cached', third.cached === true, JSON.stringify(third));

  // ── 5. AND THE SEND PATH REACHES IT ─────────────────────────────────────────────────────────
  const notify = readFileSync(`${R}/lib/notify.ts`, 'utf8');
  const envAt = notify.indexOf('environmentSendRefusal(');
  const demoAt = notify.indexOf('demoSendDecision(');
  check('sendNotification asks BEFORE the demo check', envAt > 0 && demoAt > 0 && envAt < demoAt,
    `environment at ${envAt}, demo at ${demoAt} — this question is broader, so it is asked first`);
} catch (e) {
  console.log(`\n✗ THREW: ${describeError(e).slice(0, 500)}`);
  out.push('F');
} finally {
  await prisma?.$disconnect();
  console.log(`\n${out.filter((x) => x === 'F').length} failures of ${out.length}`);
  process.exit(out.includes('F') ? 1 : 0);
}
