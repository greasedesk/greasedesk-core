/**
 * File: scripts/retry-transient-gate.mjs
 * @gate-timeout: 60
 * @gate-requires: none
 *
 * DECLARED, because inference gets this one wrong. The runner reads `localhost:(\d{4})` out of a
 * gate's source to learn which servers it needs — and this gate's own FIXTURE says "Can't reach
 * database server at localhost:5432", so the suite concluded it needed Postgres on 5432, found
 * nothing there, and skipped it. A skipped gate has told you nothing, and a gate skipped because
 * its own test data reads like a dependency would have stayed silent indefinitely.
 * This gate touches no database and no server: it calls one pure function.
 *
 * THE RETRY HELPER MUST RECOGNISE THE FAULT THAT ACTUALLY HAPPENS.
 *
 * ── WHAT THIS EXISTS FOR ────────────────────────────────────────────────────────────────────────
 * Neon's compute suspends after idle and refuses the first caller. Prisma reports that as a
 * PrismaClientInitializationError, and — this is the whole problem — the instance carries NO `code`
 * and, in the shape that reaches a gate, NO message either. `lib/db` learned this on 29 Aug 2026,
 * after the fault took out four gates at once. `_gate-retry` did not.
 *
 * So the helper written to stop this exact failure returned false for this exact failure: its
 * TRANSIENT_CODES check needs a `code` and its TRANSIENT_TEXT check needs a message, and the error
 * has neither. It was a false reassurance — the two gates using it were no better protected than
 * the thirty-three that use none.
 *
 * ── WHY MATCH ON THE CLASS NAME ─────────────────────────────────────────────────────────────────
 * There is nothing else to match on. Checked rather than assumed: the class name survives the
 * runtime's minification (the stack frames come through as `ei.handleRequestError`, but
 * `constructor.name` still reads PrismaClientInitializationError), and the real class built with an
 * empty message reproduces the fault exactly — which is what the fixture below uses, rather than a
 * local stand-in that could agree with a predicate the real error would not.
 *
 * ── AND WHY IT MUST NOT WIDEN ───────────────────────────────────────────────────────────────────
 * "No code and no message" describes a bare `new Error()` too, and a gate whose ASSERTION throws
 * must never be retried — that is the gate doing its job. The clause is therefore narrow on
 * purpose: this class, and no code. The second half of this gate is what holds it narrow.
 */
import './_gate-preflight.mjs';
const { Prisma } = await import('@prisma/client');
const { isTransient } = await import('./_gate-retry.mjs');
const { readFileSync } = await import('node:fs');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };

// ── 1. THE FAULT ────────────────────────────────────────────────────────────────────────────────
console.log('\n— the error with nothing on it —');
const noCodeNoMessage = new Prisma.PrismaClientInitializationError('', '6.19.0');
check('the fixture really is the fault: right class, no code, no message',
  noCodeNoMessage.constructor.name === 'PrismaClientInitializationError'
  && noCodeNoMessage.code == null && noCodeNoMessage.message === '',
  `ctor=${noCodeNoMessage.constructor.name} code=${String(noCodeNoMessage.code)} message=${JSON.stringify(noCodeNoMessage.message)}`);
check('an initialization error with no code and no message IS transient',
  isTransient(noCodeNoMessage) === true,
  'the connection could not be OBTAINED, so nothing was sent and anything may be repeated');

// The same class WITH a message already passed, through the text regex. It must keep passing: the
// new clause is an addition, not a replacement.
check('  …and the same class with a message still is',
  isTransient(new Prisma.PrismaClientInitializationError("Can't reach database server at localhost:5432", '6.19.0')) === true);

// ── 2. AND IT DOES NOT WIDEN ────────────────────────────────────────────────────────────────────
console.log('\n— what must stay NOT transient —');
const plain = new Error('');
check('a plain Error with no code and no message is NOT transient',
  isTransient(plain) === false,
  'a gate whose assertion throws must fail, not be retried four times into a green');

const outsideSet = Object.assign(new Error('Unique constraint failed on the fields: (`registration`)'), { code: 'P2002' });
check('an error with a code OUTSIDE the set is NOT transient',
  isTransient(outsideSet) === false, 'P2002 — the caller being wrong, and repeating it would hide that');

const knownButNotDb = Object.assign(new Error(''), { code: 'P2025' });
check('  …including one with no message to fall back on',
  isTransient(knownButNotDb) === false, 'P2025');

// ── 3. NOTHING THAT WORKED BEFORE STOPPED ───────────────────────────────────────────────────────
console.log('\n— the three codes and the text regex, unchanged —');
for (const code of ['P1001', 'P1017', 'P2024']) {
  check(`  ${code} is still transient`, isTransient(Object.assign(new Error(''), { code })) === true);
}
for (const text of ['ECONNRESET', 'socket hang up', 'Connection closed']) {
  check(`  "${text}" is still transient on an error with no code`, isTransient(new Error(text)) === true);
}
check('null is not transient', isTransient(null) === false);
check('undefined is not transient', isTransient(undefined) === false);

// ── 4. THE TWO PREDICATES MUST NOT DRIFT ────────────────────────────────────────────────────────
// This whole slice exists because lib/db was fixed and this helper was not. Pinning the shared
// clause is the cheapest thing that would have caught that. Comments are stripped first: both files
// discuss the fault in prose, and a scan that matches its own explanation proves nothing.
console.log('\n— lib/db and _gate-retry agree, which is why this was missed for four months —');
const strip = (f) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const CLAUSE = /constructor\?\.name === 'PrismaClientInitializationError'/;
for (const f of ['lib/db.ts', 'scripts/_gate-retry.mjs']) {
  const code = strip(f);
  const hits = code.match(new RegExp(CLAUSE.source, 'g'))?.length ?? 0;
  check(`${f} tests the class in CODE, exactly once`, hits === 1,
    hits === 1 ? 'comments stripped, so this is the predicate itself' : `${hits} matches outside comments`);
}

console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
process.exit(out.includes('F') ? 1 : 0);
