/**
 * File: scripts/gate-origin-gate.mjs
 * A GATE MUST NOT DECIDE FOR ITSELF WHERE THE SERVER IS.
 * @gate-requires: none
 *
 * ── A DAY AND A HALF TESTING SOMETHING ELSE ─────────────────────────────────────────────────────
 * `process.env.GATE_BASE ?? 'http://localhost:3000'` was written out forty-five times, once per
 * gate, and worked forty-five times because everyone copied it correctly. Two gates spelled the
 * origin their own way — `const ER = 'http://er.greasedesk.com:3000'` — and when another project
 * took port 3000 on this machine, GATE_BASE moved the forty-five and left those two driving the
 * other application. They reported reds for a day and a half. They were not reds: they were a suite
 * testing something else and saying nothing about GreaseDesk.
 *
 * The origin now lives in _gate-preflight (gateOrigin / erOrigin). This gate is what stops the
 * copied idiom coming back — and a copy is exactly what it would be, because the idiom LOOKS
 * harmless and reads as self-contained.
 */
import './_gate-preflight.mjs';
const { gateOrigin, erOrigin, repOrigin } = await import('./_gate-preflight.mjs');
const { readFileSync, readdirSync } = await import('node:fs');

const SELF = 'gate-origin-gate.mjs';
const SOURCE = '_gate-preflight.mjs';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
/** CODE ONLY. A comment quoting the banned literal is not the banned literal. */
const s0 = readFileSync('scripts/gate-origin-gate.mjs', 'utf8');
const code = (src) => src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

/** Every origin a file spells out for itself. Exported so the synthetic cases test the real scan. */
export function ownOrigins(src) {
  const s = code(src);
  return [
    ...[...s.matchAll(/'https?:\/\/[a-z0-9.-]*:\d{4}'/g)].map((m) => m[0]),
    ...[...s.matchAll(/GATE_BASE\s*\?\?/g)].map(() => 'GATE_BASE ?? …'),
  ];
}

// ── 1. THE SCAN BITES ──────────────────────────────────────────────────────────────────────────
console.log('\n— proven on synthetic sources —');
check('a hardcoded origin is FLAGGED', ownOrigins("const B = 'http://localhost:3000';").length === 1);
check('  …including an er. one', ownOrigins("const ER = 'http://er.greasedesk.com:3000';").length === 1,
    'the exact literal that spent a day and a half driving another application');
check('  …and the copied fallback idiom', ownOrigins("const B = process.env.GATE_BASE ?? 'http://x:3000';").length === 2,
    'both halves: the env read AND the literal behind it');
check('the helper call is not', ownOrigins('const B = gateOrigin();').length === 0);
check('  …nor is a comment quoting the ban',
  ownOrigins("// never write process.env.GATE_BASE ?? 'http://localhost:3000'\nconst B = gateOrigin();").length === 0,
  'a file must be able to say what it no longer does');
check('a port with no origin around it is not flagged', ownOrigins('const timeout = 3000;').length === 0,
  'otherwise every timeout in the suite reads as a hostname');

// ── 2. THE SWEEP ───────────────────────────────────────────────────────────────────────────────
console.log('\n— and no gate spells one out —');
/**
 * ONE EXEMPTION, NAMED, WITH ITS REASON — the runner. gates.mjs must know the origin BEFORE any
 * gate loads, and it cannot import _gate-preflight to find out: that module refuses to load when
 * stdout is a pipe (the fixture-safety guard), which is exactly how the runner is invoked. So it
 * mirrors the literal, and the check below asserts the mirror AGREES rather than exempting it from
 * scrutiny. An exemption that only excuses is how the second copy drifts.
 */
const MIRROR = 'gates.mjs';
const files = readdirSync('scripts').filter((f) => f.endsWith('.mjs') && f !== SELF && f !== SOURCE && f !== MIRROR);
const offenders = [];
for (const f of files) {
  const hits = ownOrigins(readFileSync(`scripts/${f}`, 'utf8'));
  if (hits.length) offenders.push(`${f}: ${[...new Set(hits)].join(', ')}`);
}
check('every gate asks _gate-preflight where the server is', offenders.length === 0,
  offenders.join('\n    ') || `${files.length} gates, none carrying its own`);
check('  …and the sweep really covered the suite', files.length >= 100, `${files.length} files`);

// THE MIRROR, CHECKED RATHER THAN EXCUSED. If the runner and _gate-preflight ever disagree about
// where the server is, every gate talks to one place and the identity check guards another — which
// is the failure this whole slice exists to stop, arriving from the inside.
const runnerSrc = readFileSync(`scripts/${MIRROR}`, 'utf8');
const runnerLit = (runnerSrc.match(/const ORIGIN = ([^;]+);/) ?? [])[1];
const sourceLit = (readFileSync(`scripts/${SOURCE}`, 'utf8').match(/export function gateOrigin\(\) \{\s*return ([^;]+);/) ?? [])[1];
check('the runner mirrors gateOrigin exactly', runnerLit != null && runnerLit.trim() === (sourceLit ?? '').trim(),
  `runner: ${runnerLit} | source: ${sourceLit}`);
check('  …and says why it cannot import it', /refuses to load when|stdout is a pipe/.test(runnerSrc + s0),
  'an exemption with no reason is one somebody deletes');

// ── 3. THE SOURCE ITSELF ───────────────────────────────────────────────────────────────────────
console.log('\n— one env var moves everything —');
check('gateOrigin and erOrigin agree on the port', new URL(erOrigin()).port === new URL(gateOrigin()).port,
  `${gateOrigin()} / ${erOrigin()}`);
check('  …and differ only in the host', new URL(erOrigin()).hostname === 'er.greasedesk.com'
  && new URL(gateOrigin()).hostname !== 'er.greasedesk.com',
  'the hostname is what middleware.ts routes on; the port is what GATE_BASE moves');
// THE SECOND ISOLATED HOST, HELD TO THE SAME RULE. reps.greasedesk.com arrived on 2026-09-09 by
// copying the erOrigin arrangement, and a copied arrangement is exactly what this gate exists to
// watch: the two hosts must move together on the port and differ only in the name.
check('repOrigin agrees on the port too', new URL(repOrigin()).port === new URL(gateOrigin()).port,
  `${gateOrigin()} / ${repOrigin()}`);
check('  …and is a third distinct host', new URL(repOrigin()).hostname === 'reps.greasedesk.com'
  && new URL(repOrigin()).hostname !== new URL(erOrigin()).hostname,
  'three origins, three cookie jars — the isolation is the hostname, not the guard');
check('  …with its own resolver rule beside it',
  /reps\.greasedesk\.com 127\.0\.0\.1/.test(readFileSync(`scripts/${SOURCE}`, 'utf8')),
  'a host that resolves nowhere is a gate that 404s for a reason nobody reads');
check('the resolver rule lives beside the origin it serves',
  /er\.greasedesk\.com 127\.0\.0\.1/.test(readFileSync(`scripts/${SOURCE}`, 'utf8')),
  'a host that resolves nowhere is a gate that 404s for a reason nobody reads');

// ── 4. A DECLARATION IS HONOURED, OR THE GATE IS UNRUN ─────────────────────────────────────────
/**
 * `@gate-requires: server:9999` — a port nothing listens on — RAN ANYWAY, and the suite reported
 * nothing skipped. The runner collected each declared origin into a set and then marked the whole
 * set satisfied unconditionally, so a requirement was met the moment ANY check passed. For a day
 * the header was decoration: humans read it as a guard, the runner did not act on it at all.
 *
 * The rule is that a requirement is satisfied only by its OWN probe result. What follows bans the
 * shape that broke it, because the line that broke it was one line long and looked like bookkeeping.
 */
console.log('\n— a requirement is satisfied only by its own probe —');

/** Assignments that mark a satisfaction map true without consulting anything. Exported to be proven. */
export function blanketSatisfaction(src) {
  return [...code(src).matchAll(/\b(up|probed|satisfied)\[[^\]]+\]\s*=\s*(true|1|\{\s*ok:\s*true)/g)].map((m) => m[0]);
}
check('the historical line is FLAGGED',
  blanketSatisfaction('for (const p of needed) up[p] = true;').length === 1,
  'the exact line that made every @gate-requires header decoration');
check('  …and so is a hand-built pass result', blanketSatisfaction('up[o] = { ok: true };').length === 1,
  'satisfying a probe by writing its answer is the same defect wearing the probe\'s shape');
check('probing for the answer is not', blanketSatisfaction('for (const o of needed) up[o] = await identify(o);').length === 0);
check('  …nor is a comment quoting the ban',
  blanketSatisfaction('// never write: for (const p of needed) up[p] = true\nup[o] = await identify(o);').length === 0,
  'a file must be able to say what it no longer does — this gate holds the banned line in its own cases above');
check('the runner satisfies nothing wholesale', blanketSatisfaction(runnerSrc).length === 0,
  blanketSatisfaction(runnerSrc).join(', ') || 'no unconditional satisfaction in gates.mjs');

// A MALFORMED DECLARATION IS THE SAME DEFECT, WRITTEN BY THE GATE INSTEAD. `server 3000` and
// `sever` both parse to zero requirements, which reads as "needs nothing" and runs — silently,
// and only for the one gate whose author made the typo, which is the hardest kind to notice.
const malformed = [];
for (const f of files) {
  const d = (readFileSync(`scripts/${f}`, 'utf8').match(/@gate-requires:\s*([^\n]+)/) ?? [])[1];
  if (!d) continue;
  for (const p of d.split(',').map((x) => x.trim()).filter(Boolean)) {
    if (!/^(server(:\d{2,5})?|db|none)$/.test(p)) malformed.push(`${f}: "${p}"`);
  }
}
check('every declaration in the suite is a token the runner acts on', malformed.length === 0,
  malformed.join('\n    ') || 'server, server:NNNN, db, none — nothing else');

// ── 5. THE SUITE MAY CLEAR ITS OWN CARRY-OVER, AND NOTHING ELSE ───────────────────────────────
/**
 * The runner deletes rate-limit rows this machine wrote against itself, once per run, so the tier
 * counts stop depending on how recently somebody last ran. It deletes from a table that also holds
 * REAL PEOPLE'S rows — seventeen of them the day this was written — so the two safety properties
 * are proved here rather than read in the file.
 *
 * A destructive helper with a code-shaped safety claim and no gate is the shape the standing rule
 * exists for: "this cannot reach anything else" expires the moment somebody edits the pattern.
 */
console.log('\n— the limiter reaper reaches this machine and nothing else —');
const REAP = await import('./_reap-loopback-limits.mjs');

check('a loopback key is matched', REAP.LOOPBACK_KEY.test('magic:ip:::1'));
check('  …in all three spellings a local client produces',
  ['magic:ip:::1', 'repauth:ip:127.0.0.1', 'pay:ip:::ffff:127.0.0.1'].every((k) => REAP.LOOPBACK_KEY.test(k)),
  'a raw node socket, a Chromium one, and the plain v4 form');
check('a REAL address is NOT matched',
  ['magic:ip:83.104.131.111', 'magic:ip:31.94.9.53', 'pay:ip:2a00:23c7:1:1'].every((k) => !REAP.LOOPBACK_KEY.test(k)),
  'these are live rows in that table; a prefix sweep would take every one of them');
check('  …nor is an address that merely CONTAINS a loopback form',
  !REAP.LOOPBACK_KEY.test('magic:ip:127.0.0.10') && !REAP.LOOPBACK_KEY.test('magic:ip:1.127.0.0.1.9'),
  'anchored at the end, so 127.0.0.10 is a different machine and stays');
check('  …nor a key with no address at all', !REAP.LOOPBACK_KEY.test('pay:link:abc') && !REAP.LOOPBACK_KEY.test('email:deadbeef'),
  'only address-keyed rows can be attributed to this machine');

check('a loopback ORIGIN is accepted', ['http://localhost:3010', 'http://127.0.0.1:3010'].every(REAP.isLoopbackOrigin));
check('  …and a real one is REFUSED', !REAP.isLoopbackOrigin('https://greasedesk.com')
  && !REAP.isLoopbackOrigin('https://staging.greasedesk.com'),
  'GATE_BASE can point at staging, where these rows belong to real people');
check('  …as is anything unparseable', !REAP.isLoopbackOrigin('') && !REAP.isLoopbackOrigin('not a url'),
  'fails closed: an origin it cannot read is not one it may delete against');

// AND THE DELETE ITSELF IS BY EXACT KEY. A pattern would make every clause above decoration.
const reapSrc = readFileSync('scripts/_reap-loopback-limits.mjs', 'utf8');
check('the delete is by exact equality, never a pattern',
  /DELETE FROM "AuthRateLimit" WHERE "key" = \$1/.test(reapSrc) && !/LIKE|startsWith/.test(code(reapSrc)),
  'the fixture-teardown rule, applied to somebody else’s rows: by the OWN identifier, never a shape');
check('  …and the runner clears once, before the first gate',
  /_reap-loopback-limits\.mjs/.test(runnerSrc)
  // ANCHORED ON THE LINE THAT ACTUALLY RUNS A GATE. 'for (const g of plan)' appears THREE times —
  // the first is the requirements scan, which happens before the reaper and made this clause fail
  // against correct code. The run itself is the only ordering that matters.
  && runnerSrc.indexOf('_reap-loopback-limits.mjs') < runnerSrc.indexOf('await run(g)'),
  'never between gates: a gate asserting "the Nth request is refused" must still be able to');
check('  …and says so in the summary, not only the header',
  (runnerSrc.match(/reapLine/g) ?? []).length >= 3,
  'a suite that quietly clears its own obstacles is the defect it was built to stop');

console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
process.exit(out.includes('F') ? 1 : 0);
