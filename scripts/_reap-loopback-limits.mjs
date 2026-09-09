/**
 * File: scripts/_reap-loopback-limits.mjs
 * CLEAR THE RATE-LIMIT ROWS THIS MACHINE WROTE AGAINST ITSELF — and nothing else, ever.
 *
 * ── WHY THE SUITE NEEDS THIS ────────────────────────────────────────────────────────────────────
 * The gates drive real customer surfaces, so they spend real rate-limit budget. Measured on
 * 2026-09-09 from a cleared baseline: a full sweep costs 23 of magic:ip's 60 per hour, so under
 * three sweeps an hour before the suite locks ITSELF out and gates begin failing on the limiter
 * rather than on anything they test. Five did that day. The tier counts then depend on how recently
 * you last ran, which makes every number the suite reports conditional on something nobody states.
 *
 * ── WHAT THIS DELIBERATELY IS NOT ───────────────────────────────────────────────────────────────
 * It is NOT a weakened limit. Every limit stays exactly where it is — magic:ip 60, repauth:ip 30,
 * repreq:ip 10, pay:ip 10 — and every gate still exercises the real limiter, unchanged, for the
 * whole of its own run. What is removed is the CARRY-OVER between runs, which is an artefact of one
 * machine being every caller.
 *
 * It is also NOT silent. The runner prints what was cleared, in the header and in the summary, at
 * zero as well as above it. A suite that quietly clears its own obstacles is the same defect as one
 * that quietly tests the wrong application, and this project has had that defect once already.
 *
 * ── THE TWO SAFETY PROPERTIES ───────────────────────────────────────────────────────────────────
 *   1. LOOPBACK ADDRESSES ONLY, matched on the key's ADDRESS SUFFIX and never as a prefix sweep.
 *      Real customers' rows live in this same table — seventeen of them the day this was written —
 *      and `DELETE WHERE key LIKE 'magic:ip:%'` would take every one of them.
 *   2. IT REFUSES ENTIRELY when the origin is not loopback. GATE_BASE can point at staging; reaping
 *      there would delete real limiter state for real people, and the refusal says so out loud
 *      rather than quietly doing nothing.
 *
 * Constructs its own PrismaClient rather than gatePrisma(): _gate-preflight refuses to load when
 * stdout is a pipe, and the runner reads this script's JSON from exactly that pipe. gate-hygiene's
 * Rule G scopes to discovered gates, which excludes `_`-prefixed files like this one.
 */
import { PrismaClient } from '@prisma/client';

/**
 * A LOOPBACK ADDRESS AT THE END OF THE KEY. The three spellings a local client actually produces —
 * `::1` from a raw node socket, `::ffff:127.0.0.1` from a Chromium one, and the plain v4 form.
 * That the same caller is billed under two of them is a real weakness in lib/auth-rate-limit's
 * clientIp and is on the open list; it is not this script's to fix, only to clean up after.
 *
 * ANCHORED AT BOTH ENDS: preceded by a colon (so it is the address segment, not part of a longer
 * one) and at the end of the key. No real address ends this way, and nothing here matches a prefix.
 */
export const LOOPBACK_KEY = /:(?:::1|::ffff:127\.0\.0\.1|127\.0\.0\.1)$/;
export const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
export const isLoopbackOrigin = (o) => {
  try { return LOOPBACK_HOSTS.has(new URL(o).hostname.toLowerCase()); } catch { return false; }
};

// IMPORTABLE WITHOUT RUNNING. Both rules above are exported so gate-origin-gate can prove them on
// constructed keys — including the ones that must NOT match — rather than trusting a regex nobody
// tried against a real address. Nothing below executes unless an origin was passed on argv.
const origin = process.argv[2];
if (origin === undefined) { /* imported for the rules, not invoked */ } else await main();

async function main() {
const say = (o) => { process.stdout.write(JSON.stringify(o)); process.exit(0); };

let host;
try { host = new URL(origin).hostname.toLowerCase(); } catch { say({ ok: false, reason: 'bad_origin', origin }); }
if (!LOOPBACK_HOSTS.has(host)) say({ ok: false, reason: 'not_loopback', origin, host });

const prisma = new PrismaClient();
try {
  const rows = await prisma.$queryRawUnsafe('SELECT "key", count(*)::int AS n FROM "AuthRateLimit" GROUP BY "key"');
  const mine = rows.filter((r) => LOOPBACK_KEY.test(r.key));
  let cleared = 0;
  // ONE KEY AT A TIME, BY EXACT EQUALITY. Never a pattern: the fixture-teardown rule ("by the
  // fixture's OWN identifier") is the same rule, and a pattern here reaches other people's rows.
  for (const r of mine) cleared += await prisma.$executeRawUnsafe('DELETE FROM "AuthRateLimit" WHERE "key" = $1', r.key);
  say({
    ok: true, cleared,
    keys: mine.map((r) => `${r.key} (${r.n})`),
    untouched: rows.length - mine.length,
  });
} catch (e) {
  say({ ok: false, reason: 'error', message: String(e?.message ?? e).slice(0, 200) });
} finally {
  await prisma.$disconnect().catch(() => {});
}
}
