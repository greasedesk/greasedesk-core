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
const { gateOrigin } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const F = await import('../lib/client-freshness.ts');
const { readFileSync, existsSync } = await import('node:fs'); // READ only — see the last check in section 6

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const B = gateOrigin();

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

// ── 5. THE REFUSAL ITSELF ───────────────────────────────────────────────────────────────────────
// THIS USED TO DRIVE A REAL DEV SERVER. It made the client stale by appending a line to
// node_modules/.prisma/client/schema.prisma, then asserted that a request to /c/<token> was
// refused. That proof became A RACE BY CONSTRUCTION the day scripts/dev.mjs shipped: the
// supervisor WATCHES that same directory and restarts the server on any change — repairing the
// staleness a moment before the assertion looked for it. It went red for the first time on
// 2026-09-07 (the dev log shows two restarts mid-probe) and passed when run again on its own.
//
// Two watchers acting on one directory, and the gate's answer decided by which won. So the refusal
// is now proven where it lives: lib/client-freshness::refuseIfStale takes the staleness as an
// ARGUMENT, which needs no server, no clock, and no write inside node_modules — a write this file
// itself warned about ("leaving it edited would leave the guard permanently tripped").
//
// WHAT IS NO LONGER PROVEN HERE, stated rather than quietly dropped: that a real request through a
// real stale server is refused. The wiring is asserted structurally below, and scripts/gates.mjs
// probes the running server for staleness before EVERY run and aborts the suite if it finds it —
// so the healthy direction is exercised end to end continuously. It is the unhealthy direction
// that is now proven against the function instead of the machine.
console.log('\n— stale refuses, fresh does not —');
let threw = null;
try { F.refuseIfStale(true); } catch (e) { threw = e; }
check('a stale answer THROWS', threw instanceof Error, String(threw));
check('  …carrying the message that names the cause', /OLD PRISMA CLIENT/.test(threw?.message ?? ''),
  'the error a caller sees must be the banner, not a bare failure');
check('  …the very same one, not a paraphrase', threw?.message === F.STALE_CLIENT_MESSAGE,
  'two copies of this text would drift, and the copy in the throw is the one anybody reads');
let fresh = null;
try { F.refuseIfStale(false); } catch (e) { fresh = e; }
check('a fresh answer does NOT throw', fresh === null, String(fresh));
check('  …which is the discriminating half', threw !== null && fresh === null,
  'a refusal that fired both ways would stop every query on a healthy server');

// ── 6. AND lib/db CALLS IT, ON EVERY OPERATION ──────────────────────────────────────────────────
// The one thing section 5 cannot see. Structural, and narrow enough to be worth something: the
// guard must ask the live decision and hand it to the refusal, inside $allOperations.
console.log('\n— wired into every query —');
check('the extension refuses on the live answer', /refuseIfStale\(clientIsStale\(\)\);/.test(db),
  'not a cached boolean, and not a second copy of the rule');
check('  …inside $allOperations, so no query bypasses it',
  db.indexOf('refuseIfStale(clientIsStale());') > db.indexOf('async $allOperations'),
  'a guard on one method is a guard on the methods somebody remembered');
// ── THE PROBE MOVED OFF THE CUSTOMER PATH (2026-09-09), AND THE CLAUSE MOVED WITH IT ──────────
// This asserted the runner still matched the guard's BANNER TEXT, which was true only while the
// probe fetched /c/<token> and read HTML. That path was a customer magic-link route rate-limited at
// 60 per IP per hour: the runner spent one per invocation and 25 gates spent one each TIME THEY
// FAILED, so reds caused exhaustion and exhaustion caused reds. Five gates went red on it.
//
// What is pinned now is stronger than the old clause, because it is the rule rather than the
// spelling: the diagnostic is asked on a route that EXISTS FOR IT, and it is not asked on a
// customer surface. Both halves, because either alone would pass on the arrangement that broke.
const runnerSrc = readFileSync('scripts/gates.mjs', 'utf8');
const preflightSrc = readFileSync('scripts/_gate-preflight.mjs', 'utf8');
const codeOf = (t) => t.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const DEV_PROBE = '/api/dev/client' + '-freshness';
check('  …and the running server is probed before every suite run',
  codeOf(runnerSrc).includes(DEV_PROBE),
  'the runner aborts the whole suite on a stale client, and it still asks something to find out');
check('  …on a route that exists for the diagnostic', existsSync('pages' + DEV_PROBE + '.ts'),
  'a diagnostic sharing a route with a customer surface is what put five gates on the limiter');
check('  …which 404s in production', /NODE_ENV === 'production'/.test(readFileSync('pages' + DEV_PROBE + '.ts', 'utf8')),
  'it reports a state that cannot occur in production, so it has no reason to be reachable there');
check('  …and neither probe touches a customer magic link any more',
  // @anchored-ok: a TOKEN PREFIX — the retired probe was /c/aaaaaaaaaaaaaaaa, so a whole-segment match would go blind
  !codeOf(runnerSrc).includes('/c/aaaa') && !codeOf(preflightSrc).includes('/c/aaaa'),
  'the comments still say what changed; the code no longer does it');
// THE TERMS ARE SPLIT SO THE SCAN CANNOT MATCH ITSELF. Written whole, each name appears in this
// very line and the check fails on its own text — which is exactly how it failed the first time it
// ran. A scan whose term is present in its own source is not a scan.
const WRITERS = ['write' + 'FileSync(', 'copy' + 'FileSync(', 'unlink' + 'Sync('];
const self = readFileSync('scripts/client-freshness-gate.mjs', 'utf8');
check('nothing here writes inside node_modules', WRITERS.every((w) => !self.includes(w)),
  WRITERS.filter((w) => self.includes(w)).join(', ') || 'read-only — the old probe edited the generated client, and the supervisor watches that directory');
check('  …and the scan can still see a writer', WRITERS.some((w) => `x ${'write' + 'FileSync('}y`.includes(w)),
  'otherwise the check above passes because it looks for nothing');

console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
process.exit(out.includes('F') ? 1 : 0);
