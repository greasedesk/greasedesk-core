/**
 * File: scripts/demo-maintenance-guard-gate.mjs
 * @gate-requires: none
 *
 * MAY THIS CALLER WRITE TO THIS DEMO TENANT — and the override that must never reach a cron.
 *
 * ── WHAT HAPPENED ───────────────────────────────────────────────────────────────────────────────
 * On 2026-11-02 scripts/demo-shift-dates moved the frozen reference demo's dated rows forward on
 * production. It carried its own hardcoded tenant id and four facts about the row, and it never
 * asked lib/demo-tenants. Nothing broke. The convention that every writer of a demo tenant routes
 * through `refuseDemoMaintenance` was simply bypassed by the script that most needed it, and that
 * was not discovered until afterwards — a private exemption, correct by luck, auditable by nobody.
 *
 * The owner's ruling that followed splits the question in two: the reference demo stays protected
 * from jobs that act ON a tenant — crons, sweeps, lifecycle — and is a full participant in jobs
 * that act WITHIN one (confirm-paid clears its invoices like any garage's). An owner-run one-off
 * script may write to it with an explicit flag plus the ref typed back. It is NOT added to
 * DEMO_TENANTS, which would have handed the same authority to every cron.
 *
 * ── WHY THIS GATE AND NOT never-subscribes-gate ─────────────────────────────────────────────────
 * That gate's §7 holds the three clauses this extends, and they must stay exactly as they are —
 * `refuseDemoMaintenance(ref, group)` with two arguments must still refuse the reference demo
 * `not_listed`, because that is now the automated-job protection. But it reads the live sales demo
 * and the live reference demo, and NEITHER EXISTS ON THE GATE DATABASE: measured 2026-11-02, the
 * gate database holds six tenants and neither of those two is among them, so that gate exits at
 * its own line 46 before §7 is ever reached. Clauses added there would not run.
 *
 * So the matrix lives here and is PURE — no database, no terminal, no tenant. That is the whole
 * reason the predicate is a pure function, and it means every refusal is proved without anything
 * being at risk while it is proved.
 *
 * ── AND THE PART A MATRIX CANNOT PROVE ──────────────────────────────────────────────────────────
 * A correct predicate nobody calls is what the incident above actually was. So the second half of
 * this gate reads the two scripts' SOURCE and asserts they ask it and take the answer — the same
 * shape demo-refresh-guard-gate uses for refuseRefreshWhileActive, and the only part of this that
 * protects against the next script. The scripts themselves are deliberately not executed: they
 * write to production, and a gate that runs one to watch it refuse is a gate one flag away from
 * being the hazard.
 */
import './_gate-preflight.mjs';
import './_ts.mjs';
const { readFileSync } = await import('node:fs');
// The one property-key matcher (anchored-match-gate bans hand-written ones, and duly caught four
// of them in the first draft of this file: /write:\s*true/ also matches `no_write: true`).
const { hasKey } = await import('../lib/anchored-match.ts');
const D = await import('../lib/demo-tenants.ts');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };

const LISTED = D.DEMO_TENANTS[0]?.ref ?? 'GB-GD0000';
const REFERENCE = D.REFERENCE_DEMOS[0]?.ref ?? 'GB-GD0000';
const STRANGER = 'GB-GD9999';

/** A group row as the database would hand it over. The facts, not a claim about them. */
const row = (ref, { is_demo = true, is_internal = true } = {}) => ({ ref, is_demo, is_internal });
const code = (r) => r?.code ?? null;

// ── 1. THE TWO LISTS ───────────────────────────────────────────────────────────────────────────
console.log('\n— two lists, and they must not be one —');
check('DEMO_TENANTS names at least one tenant', D.DEMO_TENANTS.length > 0, D.DEMO_TENANTS.map((t) => t.ref).join(', '));
check('REFERENCE_DEMOS names at least one tenant', D.REFERENCE_DEMOS.length > 0, D.REFERENCE_DEMOS.map((t) => t.ref).join(', '));
check('and they are DISJOINT', !D.REFERENCE_DEMOS.some((r) => D.DEMO_TENANTS.some((t) => t.ref === r.ref)),
  'an entry on both would mean the operator-only authority had quietly become the cron authority');
check('every entry says what it is for, so a stale one can be recognised',
  [...D.DEMO_TENANTS, ...D.REFERENCE_DEMOS].every((t) => typeof t.purpose === 'string' && t.purpose.length > 20));
check('isReferenceDemo accepts the declared ref and nothing else',
  D.isReferenceDemo(REFERENCE) === true && D.isReferenceDemo(LISTED) === false && D.isReferenceDemo(STRANGER) === false);
check('  …and absence is never a yes', D.isReferenceDemo(null) === false && D.isReferenceDemo(undefined) === false && D.isReferenceDemo('') === false);

// ── 2. THE DEFAULT IS UNCHANGED — the clause never-subscribes-gate holds ───────────────────────
// This is the automated-job protection, and the whole claim of the slice is that adding a third
// parameter cannot have opened anything. Asserted over every shape of the group row rather than
// read off the code, because "the branch is unreachable" is exactly the sort of thing that is true
// until somebody reorders two ifs.
console.log('\n— two arguments: a cron, and the answer it got before 2026-11-02 —');
check('the reference demo is REFUSED not_listed on the two-argument call',
  code(D.refuseDemoMaintenance(REFERENCE, row(REFERENCE))) === 'not_listed',
  'the exact clause never-subscribes-gate:110 asserts, proved here without a database');
const everyShape = [
  row(REFERENCE), row(REFERENCE, { is_internal: false }), row(REFERENCE, { is_internal: null }),
  row(REFERENCE, { is_demo: false }), row(REFERENCE, { is_demo: false, is_internal: false }), null,
];
check('  …for EVERY shape of the row, including none at all',
  everyShape.every((g) => code(D.refuseDemoMaintenance(REFERENCE, g)) === 'not_listed'),
  `${everyShape.length} shapes, one answer — no row makes a cron an operator`);
check('an explicit actor:automation is the same answer as saying nothing',
  code(D.refuseDemoMaintenance(REFERENCE, row(REFERENCE), { actor: 'automation' })) === 'not_listed'
  && code(D.refuseDemoMaintenance(REFERENCE, row(REFERENCE), {})) === 'not_listed');
check('a listed, still-internal demo is ALLOWED, as it always was',
  D.refuseDemoMaintenance(LISTED, row(LISTED, { is_demo: false })) === null);
check('a listed demo that stopped being internal is REFUSED',
  code(D.refuseDemoMaintenance(LISTED, row(LISTED, { is_internal: false }))) === 'not_internal',
  'the list is a claim; is_internal is the fact, checked at the moment of use');
check('a listed demo that does not exist is not_found, not not_listed',
  code(D.refuseDemoMaintenance(LISTED, null)) === 'not_found');
check('an undeclared tenant is REFUSED', code(D.refuseDemoMaintenance(STRANGER, row(STRANGER))) === 'not_listed');

// ── 3. THE FLAG IN THE WRONG HANDS ─────────────────────────────────────────────────────────────
console.log('\n— a cron holding the override names itself —');
const cronFlagged = (ref) => D.refuseDemoMaintenance(ref, row(ref), { override: { flagged: true } });
check('flag + no declared actor is REFUSED with its OWN code',
  code(cronFlagged(REFERENCE)) === 'override_not_available_to_automation',
  'not not_listed: a cron that has acquired the flag is a worse fact than a cron pointed at the wrong tenant');
check('  …and so is flag + actor:automation, said out loud',
  code(D.refuseDemoMaintenance(REFERENCE, row(REFERENCE), { actor: 'automation', override: { flagged: true } })) === 'override_not_available_to_automation');
check('  …even pointed at a LISTED demo, where it would otherwise be allowed',
  code(cronFlagged(LISTED)) === 'override_not_available_to_automation',
  'checked before the target, because the caller is the problem');
check('  …and even with confirmed:true, which an automation cannot honestly set',
  code(D.refuseDemoMaintenance(REFERENCE, row(REFERENCE), { override: { flagged: true, confirmed: true } })) === 'override_not_available_to_automation');
check('a write:true automation on a listed demo is still fine — crons repair declared demos',
  D.refuseDemoMaintenance(LISTED, row(LISTED, { is_demo: false }), { write: true }) === null);

// ── 4. THE OPERATOR LADDER ─────────────────────────────────────────────────────────────────────
console.log('\n— an operator, one rung at a time —');
const op = (ref, g, over, write = false) => D.refuseDemoMaintenance(ref, g, { actor: 'operator', write, override: over });
check('operator, reference demo, NO flag → refused, and told what to pass',
  code(op(REFERENCE, row(REFERENCE), undefined)) === 'reference_demo'
  && /--allow-reference-demo/.test(op(REFERENCE, row(REFERENCE), undefined).message));
check('operator, flagged, DRY RUN, nothing typed → ALLOWED',
  op(REFERENCE, row(REFERENCE), { flagged: true }, false) === null,
  'a ceremony performed to see a number is not a ceremony — the dry run writes nothing');
check('operator, flagged, WRITE, nothing typed → refused not_confirmed',
  code(op(REFERENCE, row(REFERENCE), { flagged: true }, true)) === 'not_confirmed');
check('  …and confirmed:false is not the same as confirmed, however it is spelled',
  code(op(REFERENCE, row(REFERENCE), { flagged: true, confirmed: false }, true)) === 'not_confirmed');
check('operator, flagged, WRITE, ref typed back → ALLOWED',
  op(REFERENCE, row(REFERENCE), { flagged: true, confirmed: true }, true) === null);
check('…but the facts still decide: is_demo false → refused not_demo',
  code(op(REFERENCE, row(REFERENCE, { is_demo: false }), { flagged: true, confirmed: true }, true)) === 'not_demo',
  'the override writes to invented data; a row that has stopped being a demo is a different tenant wearing the ref');
check('…is_internal false → refused not_internal',
  code(op(REFERENCE, row(REFERENCE, { is_internal: false }), { flagged: true, confirmed: true }, true)) === 'not_internal');
check('…is_internal null → refused too, because NULL is not false and must not slip through',
  code(op(REFERENCE, row(REFERENCE, { is_internal: null }), { flagged: true, confirmed: true }, true)) === 'not_internal');
check('…a declared reference demo that does not exist → not_found',
  code(op(REFERENCE, null, { flagged: true, confirmed: true }, true)) === 'not_found');
check('THE OVERRIDE IS NOT A SKELETON KEY: flagged at an undeclared tenant → refused',
  code(op(STRANGER, row(STRANGER), { flagged: true, confirmed: true }, true)) === 'override_target_not_listed',
  'its own code — "you pointed it at the wrong tenant" is a different sentence from "not a declared demo"');
check('  …and the flag is INERT where it is not needed: a listed demo is allowed as before',
  op(LISTED, row(LISTED, { is_demo: false }), { flagged: true, confirmed: true }, true) === null);
check('an operator with no flag at an undeclared tenant is the plain refusal',
  code(op(STRANGER, row(STRANGER), undefined)) === 'not_listed');

// ── 5. THE MATRIX CAN FAIL ─────────────────────────────────────────────────────────────────────
// Every clause above asserts a REFUSAL CODE, so a predicate that returned one fixed code would
// satisfy half of them. These say the codes DISCRIMINATE: the eight outcomes are eight values, and
// the two that must never be confused — a cron refused, and an operator allowed — are not.
console.log('\n— the codes discriminate, so the clauses above are not agreeing with themselves —');
const outcomes = new Set([
  code(D.refuseDemoMaintenance(REFERENCE, row(REFERENCE))),
  code(cronFlagged(REFERENCE)),
  code(op(REFERENCE, row(REFERENCE), undefined)),
  code(op(REFERENCE, row(REFERENCE), { flagged: true }, true)),
  code(op(REFERENCE, row(REFERENCE, { is_demo: false }), { flagged: true, confirmed: true }, true)),
  code(op(REFERENCE, row(REFERENCE, { is_internal: false }), { flagged: true, confirmed: true }, true)),
  code(op(REFERENCE, null, { flagged: true, confirmed: true }, true)),
  code(op(STRANGER, row(STRANGER), { flagged: true, confirmed: true }, true)),
]);
check('eight distinguishable refusals, not one message for every mistake', outcomes.size === 8,
  [...outcomes].join(', '));
check('and every refusal carries a message long enough to act on',
  [...outcomes].every((c) => c !== null));
{
  // A BROKEN COPY, to show the clauses would catch the failure that matters: an override that
  // honours the flag without asking who passed it. That is the ruling's whole content.
  const BROKEN = (ref, g, req) => (req?.override?.flagged ? null : D.refuseDemoMaintenance(ref, g, req));
  check('the clauses would CATCH a predicate that honoured the flag whoever passed it',
    BROKEN(REFERENCE, row(REFERENCE), { override: { flagged: true } }) === null
    && code(cronFlagged(REFERENCE)) === 'override_not_available_to_automation',
    'broken lets a cron write to the reference demo; real refuses it by name');
}

// ── 6. THE SCRIPTS ASK, AND TAKE THE ANSWER ────────────────────────────────────────────────────
// The predicate is not the protection; calling it is. A correct predicate nobody calls is exactly
// what the 2026-11-02 incident was.
console.log('\n— the two writers route through it —');
const src = (f) => readFileSync(`scripts/${f}`, 'utf8');
/** Comment lines removed: a file EXPLAINING why it does something must not satisfy the check. */
const prose = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const calls = (s) => (prose(s).match(/refuseDemoMaintenance\(/g) ?? []).length;
const parsesFlag = (s) => prose(s).includes("'--allow-reference-demo'");

const SHIFT = 'demo-shift-dates.mjs';
const BACKFILL = 'payment-backfill.mjs';
const shift = src(SHIFT);
const backfill = src(BACKFILL);

check(`${BACKFILL} parses --allow-reference-demo`, parsesFlag(backfill));
check(`${BACKFILL} asks the predicate`, calls(backfill) === 1, `${calls(backfill)} call(s)`);
check(`  …declaring itself an operator and whether it is writing`,
  hasKey(prose(backfill), 'actor', "'operator'") && hasKey(prose(backfill), 'write', 'APPLY'),
  'write:APPLY, not write:true — a dry run must not demand a typed ref');
check('  …and it needs a TERMINAL before it will prompt',
  /process\.stdin\.isTTY/.test(prose(backfill)),
  'a confirmation that can be piped in is not a confirmation');
check('  …and the refusal is THROWN, not logged',
  /if \(refusal\) throw new Error\(/.test(prose(backfill)));
{
  // THE ORDER THAT HAS NO ERROR WHEN IT IS WRONG. lib/db builds its client at import time, so the
  // production URLs must be in the environment BEFORE that import. Move the block below it and the
  // flag silently does nothing: the script reads .env, finds the gate database, and reports "no
  // tenant with ref GB-GD2236" — a true sentence about the wrong database, whose likeliest reading
  // is that the ref is wrong.
  const b = prose(backfill);
  const flag = b.indexOf("'--yes-production'");
  const file = b.indexOf('.migrate-target.production');
  const db = b.indexOf("await import('../lib/db.ts')");
  check('  …and it can reach production, with the URLs set BEFORE lib/db is imported',
    flag > 0 && file > flag && db > file,
    `flag ${flag}, target file ${file}, lib/db ${db} — this order has no error when it is wrong`);
  check('  …with the Environment marker, not the flag, as the authority',
    /env\?\.kind !== 'production'/.test(b),
    'a stale DATABASE_URL must not be able to satisfy --yes-production');
}

check(`${SHIFT} parses --allow-reference-demo`, parsesFlag(shift));
// TWICE, for the reason demo-refresh asks its activity check twice: the first call must refuse
// before anything is read, and the second must be about the state at the moment of the write.
check(`${SHIFT} asks the predicate TWICE`, calls(shift) === 2, `${calls(shift)} call(s)`);
check('  …once with write:false, once with write:true',
  hasKey(prose(shift), 'write', 'false') && hasKey(prose(shift), 'write', 'true'));
{
  const s = prose(shift);
  const first = s.indexOf('refuseDemoMaintenance(');
  const typedCmp = s.indexOf("typed.trim() !== TENANT_REF");
  const second = s.indexOf('refuseDemoMaintenance(', first + 1);
  check('  …and the SECOND call is after the ref is typed back, not before',
    first > 0 && typedCmp > first && second > typedCmp,
    `first ${first}, typed ${typedCmp}, second ${second} — a confirmation checked before it is collected is decoration`);
}
check('  …both refusals are taken',
  /if \(firstLook\) await die\(/.test(prose(shift)) && /if \(atWrite\) await die\(/.test(prose(shift)));
// The ABSENCE of the id lookup, and the PRESENCE of the id comparison. `id: TENANT_ID` is the
// key-value shape of a Prisma where clause; `g.id !== TENANT_ID` is a comparison and not a key, so
// the first can be gone while the second remains — which is the whole change.
check(`  …and ${SHIFT} no longer resolves its target by id alone`,
  !hasKey(prose(shift), 'id', 'TENANT_ID')
  && hasKey(prose(shift), 'ref', 'TENANT_REF')
  && prose(shift).includes('g.id !== TENANT_ID'),
  'fetched by ref, with the id kept as a cross-check — a replaced tenant goes red instead of the literal winning');

// ── 7. THE SCANS BITE ──────────────────────────────────────────────────────────────────────────
// A source scan that matches nothing real is indistinguishable from one that matches nothing.
console.log('\n— proven on synthetic sources —');
check('calls() does not count a mention in a comment',
  calls("// we should call refuseDemoMaintenance( one day\n/* refuseDemoMaintenance( */\n") === 0,
  'the commonest way a scan in this repo has been defeated');
check('calls() counts a real call', calls("const r = refuseDemoMaintenance(ref, g, {});\n") === 1);
check('parsesFlag() does not count the flag named in prose',
  parsesFlag("// pass --allow-reference-demo to override\n") === false);
check('parsesFlag() counts the argv read', parsesFlag("const A = argv.includes('--allow-reference-demo');\n") === true);

// ── 8. THE GATES KEEP THEIR OWN COPIES, AND THEY MUST AGREE ────────────────────────────────────
// demo-lifecycle-gate says why in as many words: never put the declaration where the guarded thing
// can reach it. lib/demo-tenants is imported by the app, so it IS that place. The hardcoded refs
// therefore stay, and this asserts they agree with the list instead of replacing them with it —
// agreement catches drift; sharing would remove the second opinion.
//
// A STALE ENTRY IS A FAILURE, not a pass: a file that has stopped carrying the ref is a declaration
// that no longer names anything, which is how an exclusion silently excludes nothing.
console.log('\n— the independent copies of the reference-demo ref —');
const CARRIERS = [
  { f: 'demo-lifecycle-gate.mjs', why: 'DECLARED_OUT_OF_SCOPE — the purge sweep that once deleted it' },
  { f: 'demo-generation-gate.mjs', why: 'twice: the tenants it may regenerate' },
  { f: 'never-subscribes-gate.mjs', why: '§7, the maintenance-targeting clauses' },
  { f: SHIFT, why: 'TENANT_REF — its only target' },
];
const refsIn = (s) => [...new Set(prose(s).match(/\b[A-Z]{2}-GD\d+\b/g) ?? [])];
let carrierFailures = 0;
for (const c of CARRIERS) {
  const refs = refsIn(src(c.f));
  const carries = refs.some((r) => D.isReferenceDemo(r));
  const strangers = refs.filter((r) => !D.isReferenceDemo(r) && !D.isListedDemoTenant(r));
  const ok = carries && strangers.length === 0;
  if (!ok) carrierFailures++;
  check(`${c.f} names the declared reference demo`, ok,
    ok ? `${refs.join(', ')} — ${c.why}`
      : !carries ? `carries none of REFERENCE_DEMOS — stale declaration, or the list moved (${c.why})`
        : `undeclared ref(s) in code: ${strangers.join(', ')}`);
}
check('every declared carrier agrees with the list', carrierFailures === 0,
  `${CARRIERS.length} files, each with its own copy — on purpose`);
check('the carrier scan would catch a ref that is on NEITHER list',
  refsIn("const T = 'GB-GD9999';\n").filter((r) => !D.isReferenceDemo(r) && !D.isListedDemoTenant(r)).length === 1);
check('  …and does not count one quoted in a comment',
  refsIn("// the old tenant was GB-GD9999\n").length === 0);

console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
process.exit(out.includes('F') ? 1 : 0);
