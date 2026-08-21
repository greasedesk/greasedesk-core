/**
 * File: scripts/gate-hygiene-gate.mjs
 * The gates that check the product, checked. A gate that cannot run proves nothing, silently.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────────
 * Three gates — sms-sends, sms-allowance, demo-lifecycle — could not run AT ALL, and had been that
 * way for an unknown period. `ERR_MODULE_NOT_FOUND: Cannot find package '@/lib'`. They used STATIC
 * imports of `.ts` modules, and ES modules are fully linked before any module body evaluates, so
 * `import './_ts.mjs'` cannot register the `@/` resolver in time however early it is written.
 *
 * The number that mattered was not three. FOURTEEN gates used static `.ts` imports, and the ones
 * that worked worked by luck: nothing in their transitive graph happened to use `@/`. Add one `@/`
 * import to a lib file and a gate somewhere else dies — a failure arriving from a direction nobody
 * is watching, in the evidence base for everything else.
 *
 * ── WHY A SCANNER AND NOT THE PREFLIGHT ─────────────────────────────────────────────────────────
 * `_gate-preflight.mjs` cannot catch this. The link error happens BEFORE any module body runs, so
 * the preflight never evaluates — the guard would be inside the building it is meant to inspect.
 * Source-level is the only level that works, which is the same reason poisoned-transaction-gate
 * reads text rather than executing anything.
 *
 * ── THE RULES ───────────────────────────────────────────────────────────────────────────────────
 *   A. No STATIC import of a `.ts` module, anywhere in scripts/. Use `await import()`.
 *   B. Every gate imports `_gate-preflight.mjs`, so a truncating pipe cannot skip its teardown.
 *   C. Any script that imports a `.ts` module at all must also import `_ts.mjs`, or `@/` specifiers
 *      inside that module resolve against nothing.
 *
 * Each rule is proven against synthetic BAD sources as well as the real tree, so a rule that has
 * stopped matching anything still demonstrates it would catch the thing it describes.
 */
import './_gate-preflight.mjs';
import { readFileSync, readdirSync } from 'node:fs';

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };

// ── THE RULES, AS PURE PREDICATES ─────────────────────────────────────────────────────────────
// Exported shape: (source) => offending lines. Pure, so they can be proven against synthetic text
// without a filesystem — the same discipline as proving a destructive gate against its predicate.
const staticTsImports = (src) => src.split('\n')
  .map((l, i) => [i + 1, l])
  .filter(([, l]) => /^import\s[^'"]*from\s*['"][^'"]*\.ts['"]/.test(l) || /^import\s*['"][^'"]*\.ts['"]/.test(l));
const importsPreflight = (src) => /^import\s*['"]\.\/_gate-preflight\.mjs['"];/m.test(src);
const importsTsHarness = (src) => /^import\s*['"]\.\/_ts\.mjs['"];/m.test(src);
const touchesTsModule = (src) => /(?:^import\s[^'"]*from\s*|await import\(\s*)['"][^'"]*\.ts['"]/m.test(src);

// This file is EXCLUDED from the real-tree rules below. It carries synthetic bad sources as string
// literals — that is how the rules are proven able to fail — and rule C duly matched its own test
// data on the first run. A scanner that flags its own fixtures is reporting the fixture, not the
// tree. The exclusion is narrow and named rather than a general "ignore" mechanism nobody audits.
const SELF = 'gate-hygiene-gate.mjs';
const files = readdirSync('scripts').filter((f) => f.endsWith('.mjs') && f !== SELF).sort();
const read = (f) => readFileSync(`scripts/${f}`, 'utf8');
// The helpers are imported BY gates; they are not gates and must not require their own preflight.
// gates.mjs is the RUNNER, not a gate. It spawns each gate as its own process, and every one of
// those imports the preflight for itself — the runner importing it too would run the freshness
// check once for the suite and then again per gate, and Rule B would be enforcing a no-op.
const HELPERS = new Set(['_gate-preflight.mjs', '_ts.mjs', '_ts-hook.mjs', '_gate-retry.mjs', 'gates.mjs']);
const gates = files.filter((f) => f.includes('gate') && !HELPERS.has(f));

console.log(`\n— scanning ${files.length} scripts (${gates.length} gates) —`);

// ── RULE A ────────────────────────────────────────────────────────────────────────────────────
const offendersA = files.flatMap((f) => staticTsImports(read(f)).map(([n, l]) => `${f}:${n}  ${l.trim().slice(0, 72)}`));
check('A. no script statically imports a .ts module', offendersA.length === 0,
  offendersA.length ? `\n    ${offendersA.join('\n    ')}` : 'all .ts imports are dynamic, so _ts.mjs registers the @/ hook first');

// ── RULE B ────────────────────────────────────────────────────────────────────────────────────
const offendersB = gates.filter((f) => !importsPreflight(read(f)));
check('B. every gate imports _gate-preflight.mjs', offendersB.length === 0, offendersB.join(', ') || `${gates.length} gates`);

// ── RULE C ────────────────────────────────────────────────────────────────────────────────────
const offendersC = files.filter((f) => !HELPERS.has(f) && touchesTsModule(read(f)) && !importsTsHarness(read(f)));
check('C. every script touching a .ts module imports _ts.mjs', offendersC.length === 0,
  offendersC.join(', ') || 'the @/ resolver is registered wherever it is needed');

// ── AND THE RULES CAN FAIL ────────────────────────────────────────────────────────────────────
// A scanner that matches nothing is indistinguishable from a scanner that matches nothing REAL.
console.log('\n— the rules bite, proven on synthetic sources —');
const BAD_A = "import './_gate-preflight.mjs';\nimport { prisma } from '../lib/db.ts';\n";
const BAD_A2 = "import '../lib/side-effect.ts';\n";
const GOOD_A = "import './_ts.mjs';\nconst { prisma } = await import('../lib/db.ts');\n";
check('A flags a static named .ts import', staticTsImports(BAD_A).length === 1, JSON.stringify(BAD_A.split('\n')[1]));
check('A flags a bare static .ts import', staticTsImports(BAD_A2).length === 1);
check('A does NOT flag the dynamic form', staticTsImports(GOOD_A).length === 0,
  'the distinction the whole rule rests on — one links before evaluation, the other does not');
check('A does not flag a .mjs import', staticTsImports("import './_ts.mjs';\n").length === 0);
check('B flags a gate without the preflight', importsPreflight('const x = 1;\n') === false);
check('C flags a .ts consumer with no harness', touchesTsModule(GOOD_A) && !importsTsHarness("const { p } = await import('../lib/db.ts');\n"));
check('C does not flag a script that touches no .ts module', !touchesTsModule("import { readFileSync } from 'node:fs';\n"));

// ── RULE F: A SCAN'S TERM MUST BE ANCHORED TO WHAT IT MEANS ────────────────────────────────────
// Nine times in two days a gate asserted on a BARE IDENTIFIER where it meant a render or a write,
// and every one was caught by red-proving rather than by the written rule:
//
//   /DocumentCredit/.test(src)   true of a file that merely IMPORTS it — deleting the element
//                                left the check green
//   /CREDIT_LINE/                first occurrence was the import at the top, above everything
//   /closed_at/                  banned as a word when the rule was about the WRITE; an orderBy
//                                tripped it
//   /reason === 'mot'/           matched the comment explaining that the gate had been removed
//   /PACE_MS/                    true of `import { PACE_MS }` whether or not anything waited
//
// The written discipline is correct and has never once fired at the moment somebody was writing
// the scan. This is the mechanical version, and it fires where the prose does not.
//
// ── DELIBERATELY NARROW ────────────────────────────────────────────────────────────────────────
// Only a regex that is NOTHING BUT an identifier, tested against a variable holding FILE SOURCE.
// Matching a word in rendered OUTPUT is legitimate and common — `/Coolant/.test(innerText)` is
// exactly right — so the haystack is what decides, not the pattern. Nineteen candidates become
// four when the haystack has to be a readFileSync.
//
// A `// @scan-ok: <why>` on the line above waives it, because some source scans genuinely are
// searching prose. The waiver costs a sentence, which is the point: it makes the author say which
// kind they meant.
//
// ── WHAT THIS DOES NOT CATCH — READ THIS BEFORE YOU TRUST IT ───────────────────────────────────
// Rule F catches ONE SHAPE of a much larger failure: the bare identifier. It is not a general
// defence against a scan matching the wrong thing, and finding it green is NOT evidence that a
// new scan is anchored.
//
// Of the nine collisions that motivated it, Rule F would have caught four. It would have sailed
// straight past:
//
//   /reason === 'mot'/     matched the COMMENT explaining that this very gate had been removed.
//                          Not a bare identifier, so Rule F says nothing.
//   /closed_at/            banned as a word when the rule was about the WRITE; an orderBy tripped
//                          it. The haystack was right, the CLAIM was the wrong shape.
//   a term that appears    in the fixture, the explanation, or twice in the patched file — Rule F
//                          counts nothing, so a scan matching its own setup still passes.
//
// The only thing that reliably catches those is red-proving: break the behaviour the assertion
// NAMES and watch the assertion go red. Rule F is a floor under the cheapest mistake. It is not
// a substitute, and a slice that skips the red-proof because Rule F is green has swapped a
// discipline for a lint.
const SOURCE_VAR = /(?:const|let)\s+(\w+)\s*=\s*(?:await\s+)?(?:prose\()?\s*(?:rf|readFileSync)\(/g;
const ID_ONLY = /^\/(?:\\b)?(?:[A-Z][A-Za-z0-9]*|[A-Z][A-Z0-9_]{3,})(?:\\b)?\/[gimsuy]*$/;
const TEST_CALL = /(\/(?:\\.|\[[^\]]*\]|[^/\n\\])+\/[gimsuy]*)\s*\.test\(\s*(\w+)/g;
const unanchored = [];
for (const f of gates) {
  const src = read(f);
  const sourceVars = new Set([...src.matchAll(SOURCE_VAR)].map((m) => m[1]));
  if (!sourceVars.size) continue;
  const lines = src.split('\n');
  for (const m of src.matchAll(TEST_CALL)) {
    if (!sourceVars.has(m[2]) || !ID_ONLY.test(m[1])) continue;
    const lineNo = src.slice(0, m.index).split('\n').length;
    if (/@scan-ok:/.test(lines[lineNo - 2] ?? '')) continue;
    unanchored.push(`${f}:${lineNo}  ${m[1]}.test(${m[2]})`);
  }
}
check('F. no gate asserts a bare identifier against file source', unanchored.length === 0,
  unanchored.length
    ? `\n    ${unanchored.join('\n    ')}\n    Anchor it: <Component, {CONSTANT}, an import line, a call — or waive with // @scan-ok: <why>`
    : 'anchored to a render, a write, or waived with a reason');

console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
process.exit(out.includes('F') ? 1 : 0);
