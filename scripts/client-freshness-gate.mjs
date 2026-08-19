/**
 * File: scripts/client-freshness-gate.mjs
 * THE GUARD FIRES, AND FIRES ONLY WHEN IT SHOULD.
 *
 * A guard that cannot distinguish "stale" from "cannot tell" is worse than none: it fires on its
 * own blindness, someone switches it off, and the failure it existed for comes back invisible. So
 * the assertions are mostly about the THREE-WAY answer, not the two-way one.
 *
 * Writes NO fixtures — the rule is pure and the integration half runs against a real dev server.
 */
import './_gate-preflight.mjs';
import './_ts.mjs';
const F = await import('../lib/client-freshness.ts');
const { readFileSync, writeFileSync, copyFileSync, unlinkSync } = await import('node:fs');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const B = process.env.GATE_BASE ?? 'http://localhost:3000';

// ── 1. THE RULE IS THREE-WAY ────────────────────────────────────────────────────────────────────
console.log('\n— stale, fresh, and cannot tell —');
check('two different fingerprints are stale', F.isStale('aaaa', 'bbbb'));
check('the same fingerprint is not', !F.isStale('aaaa', 'aaaa'));
check('an unknown BOOT print is not stale', !F.isStale(null, 'bbbb'),
  'never checked in, so there is no drift to report');
check('an unknown DISK print is not stale', !F.isStale('aaaa', null),
  'the file went missing — that is our blindness, not the server’s staleness');
check('  …and neither is both unknown', !F.isStale(null, null));

// ── 2. THE FINGERPRINT ACTUALLY DISCRIMINATES ───────────────────────────────────────────────────
console.log('\n— it has to notice a change —');
check('identical contents fingerprint the same', F.fingerprint('model A {}') === F.fingerprint('model A {}'));
check('one added field changes it', F.fingerprint('model A {}') !== F.fingerprint('model A { x Int }'),
  'a hash that cannot tell two schemas apart would report fresh forever');
check('a missing file reads as null, not as a throw', F.readFingerprint('/nonexistent/schema.prisma') === null);
check('the real generated schema is readable', F.readFingerprint() !== null,
  F.GENERATED_SCHEMA_PATH.replace(process.cwd() + '/', ''));

// ── 3. THE MESSAGE POINTS AT THE CAUSE, NOT THE SYMPTOM ─────────────────────────────────────────
console.log('\n— it has to prevent the wrong investigation —');
const m = F.STALE_CLIENT_MESSAGE;
check('it names the actual cause', /prisma generate/i.test(m) && /older than the one on disk/i.test(m));
check('it says what to do', /RESTART THE DEV SERVER/.test(m));
check('  …and warns that it LOOKS like a broken feature', /looks like the feature being broken/i.test(m),
  'that sentence is the whole point — twice it sent the search into the wrong subsystem');
check('  …and says it is development-only, so nobody ships it', /development-only/i.test(m));

// ── 4. DEVELOPMENT ONLY, AND THE REASON IS RECORDED ─────────────────────────────────────────────
console.log('\n— the window cannot open in production —');
const db = readFileSync('lib/db.ts', 'utf8');
const prose = (s) => s.replace(/^\s*\*\s?/gm, ' ').replace(/\s+/g, ' ');
check('the guard is skipped in production', /process\.env\.NODE_ENV === 'production' \? base :/.test(db));
check('  …and it sits OUTSIDE the transient retry',
  db.indexOf('withFreshnessGuard(base') > db.indexOf('withTransientRetry(baseClient())'),
  'a stale client is not transient and must not be retried six times with backoff first');
check('the reason production is exempt is written down',
  /generated at build time and the server process starts afterwards/i.test(prose(readFileSync('lib/client-freshness.ts', 'utf8'))),
  'or someone removes the environment check to tidy the asymmetry');
check('it does not exit the process', !/process\.exit/.test(readFileSync('lib/client-freshness.ts', 'utf8')),
  'dying part-way through a migration is a worse surprise than the error');

// ── 5. AGAINST A RUNNING SERVER ─────────────────────────────────────────────────────────────────
// The pure rule is proven above. This is the half that could not be proven by reasoning: that the
// running process notices, and that a normal request is unaffected when it should not.
console.log('\n— and now for real —');
// A PUBLIC route that queries Prisma. The first draft used /api/pwa/day, which answers 401 from the
// session check BEFORE any query runs — so the guard was never reached and the probe proved nothing.
// /c/<token> resolves a magic link, which is a findUnique, and it is reachable without a session.
// A bad token renders "we couldn't find that link" at HTTP 200, so a healthy server is a 200.
const hit = async (token) => {
  const r = await fetch(`${B}/c/${token}`).catch(() => null);
  return r ? { status: r.status, text: await r.text().catch(() => '') } : { status: 0, text: '' };
};

const before = await hit('aaaaaaaaaaaaaaaa');
check('the dev server answers before we touch anything', before.status === 200, `HTTP ${before.status}`);

const backup = '/tmp/generated-schema.prisma.bak';
let restored = false;
try {
  copyFileSync(F.GENERATED_SCHEMA_PATH, backup);
  // SIMULATES A REGENERATE: the guard compares this file's fingerprint against the one taken when
  // the server process loaded it, so appending a comment is indistinguishable from a real
  // `prisma generate` as far as the check is concerned — and it cannot corrupt anything, because
  // the client reads the compiled artefacts beside this file rather than this file itself.
  writeFileSync(F.GENERATED_SCHEMA_PATH, readFileSync(backup, 'utf8') + '\n// freshness gate probe\n');
  await new Promise((r) => setTimeout(r, 1500)); // past the throttle

  const during = await hit('bbbbbbbbbbbbbbbb');
  check('a query REFUSES while the client is behind the disk',
    during.status >= 500 || /OLD PRISMA CLIENT|RESTART THE DEV SERVER/i.test(during.text),
    `HTTP ${during.status}`);
  check('  …and the page says WHY, not just that something failed',
    /OLD PRISMA CLIENT|RESTART THE DEV SERVER/i.test(during.text),
    'a bare 500 would send the next hour into the wrong subsystem, which is the whole point');
} finally {
  try { copyFileSync(backup, F.GENERATED_SCHEMA_PATH); unlinkSync(backup); restored = true; } catch { /* reported below */ }
}
check('the generated schema was put back', restored && F.readFingerprint() !== null,
  'this gate edits a file inside node_modules; leaving it edited would leave the guard permanently tripped');

await new Promise((r) => setTimeout(r, 1500));
const after = await hit('cccccccccccccccc');
check('and the server serves normally again', after.status === 200, `HTTP ${after.status}`);

console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
process.exit(out.includes('F') ? 1 : 0);
