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
 * ── WHAT THIS EXISTS FOR, AND THE DIAGNOSIS IT CORRECTS ─────────────────────────────────────────
 * Neon's compute suspends after idle and refuses the first caller, which Prisma reports as a
 * PrismaClientInitializationError with no `code`. `lib/db` learned to retry that on 29 Aug 2026;
 * `_gate-retry` had not, so this gate pins that the two now agree.
 *
 * IT DOES NOT PIN WHAT I FIRST SAID IT DID. The claim was that those errors carried no message
 * either, leaving isTransient blind to them. That was wrong: they carry "Can't reach database
 * server at <host>:5432", which TRANSIENT_TEXT already matches. The blank reasons in the summary
 * came from Prisma's messages beginning with a NEWLINE while the runner read a single line — a
 * reporting defect, not a detection one, now fixed in _gate-summary.mjs and gated in section 7.
 *
 * The clause is still right, just narrower than advertised: it covers an initialization error
 * whose wording the regex does not know. Section 1 tests exactly that and nothing more.
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
const { describeError } = await import('./_gate-preflight.mjs');
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

// ── 5. AND IT NAMES ITSELF WHEN IT IS CAUGHT ────────────────────────────────────────────────────
// Recognising the fault and reporting it are the two halves of the same problem. Every gate printed
// `String(e?.message ?? e)`, which for this error prints nothing at all — "✗ run completed —" with
// the reason blank. describeError leads with the class, which is always present.
console.log('\n— describeError: a red must say what went wrong —');
const D = (x) => { try { return describeError(x); } catch (err) { return `THREW: ${err?.message}`; } };
check('describeError is exported from _gate-preflight', typeof describeError === 'function');

const silent = new Prisma.PrismaClientInitializationError('', '6.19.0');
check('a message-less error still names its class', D(silent) === 'PrismaClientInitializationError',
  JSON.stringify(D(silent)));
check('  …where the old shape said nothing at all', String(silent?.message ?? silent) === '',
  'this is the "✗ run completed —" that cost three days');

const withMsg = new Prisma.PrismaClientInitializationError("Can't reach database server", '6.19.0');
check('a message is kept, after the class', D(withMsg) === "PrismaClientInitializationError: Can't reach database server",
  JSON.stringify(D(withMsg)));

const coded = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
check('a code is reported too — it is the most useful field when present',
  D(coded) === 'Error [P2002]: Unique constraint failed', JSON.stringify(D(coded)));

// TOTAL. It is called from catch blocks: a reporter that throws replaces the failure with its own.
for (const [label, v] of [['null', null], ['undefined', undefined], ['a thrown string', 'boom'], ['a number', 7], ['a plain object', {}]]) {
  const r = D(v);
  check(`  ${label} is described without throwing`, typeof r === 'string' && !r.startsWith('THREW'), JSON.stringify(r));
}

// ── 6. NO GATE STILL REPORTS THE OLD WAY ────────────────────────────────────────────────────────
// Built from an escaped source string, NOT written as a literal: a regex literal for this pattern
// would appear in this file verbatim and the scan would match itself. This gate is excluded from
// the sweep anyway — it necessarily discusses the shape it bans — and the counter-check below
// proves the scanner can still see a real one.
const OLD_SHAPE = new RegExp('String\\(e\\?\\.message \\?\\? e\\)');
const { readdirSync } = await import('node:fs');
const gateFiles = readdirSync('scripts').filter((f) => f.endsWith('-gate.mjs') && f !== 'retry-transient-gate.mjs');
const stragglers = gateFiles.filter((f) => OLD_SHAPE.test(readFileSync(`scripts/${f}`, 'utf8')));
check('no gate reports a caught error the old way', stragglers.length === 0,
  stragglers.length ? `${stragglers.length} of ${gateFiles.length}: ${stragglers.slice(0, 6).join(', ')}${stragglers.length > 6 ? ' …' : ''}` : `${gateFiles.length} gates use describeError`);
check('  …and the scanner can still find one', OLD_SHAPE.test('check("x", false, String(e?.message ?? e).slice(0, 200))'),
  'a sweep that matches nothing is indistinguishable from a sweep that is broken');

// ── 7. AND THE SUMMARY SAYS IT ──────────────────────────────────────────────────────────────────
// The third place this fault hid. Recognising it, naming it, and SURFACING it are one problem: a
// red whose reason lands on the second line is a red with no reason at all.
console.log('\n— firstFailureLine: the reason must survive into the summary —');
const { firstFailureLine } = await import('./_gate-summary.mjs');

const REAL = [
  '✓ a fixture exists',
  '✗ run completed  — ',
  'PrismaClientValidationError: Invalid `prisma.notificationLog.createMany()` invocation:',
  '',
  '1 failures of 20',
].join('\n');
check('a reason on the NEXT line reaches the summary',
  /PrismaClientValidationError/.test(firstFailureLine(REAL) ?? ''), JSON.stringify(firstFailureLine(REAL)));
check('  …which the old one-line read could not', /^✗ run completed\s+—\s*$/.test((REAL.match(/^✗.*$/m) ?? [])[0] ?? ''),
  'this is the shape that reported four reds with a blank reason');

// AND IT MUST NOT INVENT ONE. A failure with genuinely no detail must stay short rather than
// borrowing the next check's words into a sentence that reads true and is not.
const NO_DETAIL = ['✗ every route is guarded  — ', '✓ and the next check passed  — 14 routes', '2 failures of 13'].join('\n');
check('a blank detail does NOT borrow the following check',
  !/next check/.test(firstFailureLine(NO_DETAIL) ?? ''), JSON.stringify(firstFailureLine(NO_DETAIL)));
const NO_SEP = ['✗ the totals disagree', '3 failures of 9'].join('\n');
check('  …nor the totals line', !/failures of/.test(firstFailureLine(NO_SEP) ?? ''), JSON.stringify(firstFailureLine(NO_SEP)));
check('a line that already carries its reason is unchanged',
  firstFailureLine('✗ the board builds quickly (6.2s)  — ZZ is small\n0 failures of 1') === '✗ the board builds quickly (6.2s)  — ZZ is small');
check('no ✗ at all means no failure line', firstFailureLine('✓ all good\n0 failures of 1') === null);
check('  …and it is total on rubbish input', firstFailureLine(null) === null && firstFailureLine(undefined) === null);
check('the cap still applies', (firstFailureLine(`✗ x  — \n${'y'.repeat(400)}`) ?? '').length === 110);

console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
process.exit(out.includes('F') ? 1 : 0);
