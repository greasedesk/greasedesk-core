/**
 * File: scripts/prisma-any-gate.mjs
 * The Prisma client is TYPED now. The call sites that throw the type away are counted and capped.
 *
 * ── WHAT THE CLIENT FIX DID, AND WHAT IT DID NOT ────────────────────────────────────────────────
 * `lib/db.ts` exported `prisma` as `any` — not by an explicit cast on the export, but because
 * `globalThis as any` made the `??` beside it `any`, and every query in the codebase inherited it.
 * Three separate defects in one day were invisible to the type-checker for that reason.
 *
 * Typing it costs 14 errors in 9 files (see the commit). Typing it the OBVIOUS way costs 200 across
 * 87 — that lever is recorded in the memory note, because whoever picks this up will try it first.
 *
 * IT IS NOT ENOUGH ON ITS OWN, and that was measured rather than assumed. With the client typed,
 * this morning's forgotten `select` was reintroduced and tsc said NOTHING — because the call site
 * reads `const inv = (await tx.invoice.findUnique({…})) as any;`. Typing the client does not help
 * when the caller discards the type on the next character.
 *
 * ── THE RATCHET ─────────────────────────────────────────────────────────────────────────────────
 * There are 134 such casts across 67 files. That is not a sweep: removing one surfaces whatever
 * that file was papering over, so it is 67 small investigations, not a find-and-replace — a week
 * nobody will schedule. So it is pinned instead. The count may fall freely; it may not rise. Drop
 * the ceiling whenever a file is touched for another reason.
 *
 * Third ratchet in the codebase, after INLINE_GUARD_CEILING and UNANNOTATED_CEILING. The pattern is
 * for debt that is real, bounded, and not worth a dedicated project: make it visible and one-way.
 */
import './_gate-preflight.mjs';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };

/**
 * PURE: source → the number of places A CALL'S RESULT is cast to `any` — `(await x.find(…)) as any`.
 *
 * `)) as any` and not the broader `) as any`, deliberately. The broad form counts 206 and sweeps in
 * `session?.user as any` and `catch (e: any)`, which are a different problem: the session and the
 * error really are untyped, and casting them is not discarding a type Prisma gave us. Counting them
 * here would mean the number never reaches zero and stops meaning anything.
 *
 * COMMENTS STRIPPED FIRST. A file explaining why it no longer casts must not be counted as casting.
 */
export function anyCasts(src) {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  return (code.match(/\)\)\s*as any/g) ?? []).length;
}

const walk = (d) => readdirSync(d).flatMap((e) => {
  const p = join(d, e);
  if (e === 'node_modules' || e === '.next') return [];
  return statSync(p).isDirectory() ? walk(p) : (/\.(ts|tsx)$/.test(p) ? [p] : []);
});
const files = [...walk('lib'), ...walk('pages'), ...walk('components')];
const perFile = files.map((f) => [f, anyCasts(readFileSync(f, 'utf8'))]).filter(([, n]) => n > 0);
const total = perFile.reduce((a, [, n]) => a + n, 0);

// ── THE RATCHET ───────────────────────────────────────────────────────────────────────────────
// Lower this in the same commit that removes casts. It must never be raised.
// 134, not the 164 first quoted. That figure came from a regex with two alternate patterns and no
// comment stripping — an inconsistent definition measured once. 134 is `)) as any` over stripped
// source, which is the shape that actually discards a Prisma row type. (The FILE count, 67, was
// right both times.)
const ANY_CAST_CEILING = 134;

console.log(`\n— \`as any\` casts: ${total} across ${perFile.length} files (ceiling ${ANY_CAST_CEILING}) —`);
const over = total - ANY_CAST_CEILING;
check('the `as any` count has not RISEN', over <= 0,
  over <= 0
    ? (over === 0 ? 'at the ceiling — remove some and lower it' : `${-over} below; lower the ceiling to ${total} in this commit`)
    : `${over} more than the ceiling. A new \`as any\` on a Prisma result puts the file back where the\n` +
      `  client was: the type-checker stops seeing a forgotten select. Type the row instead.`);

// ── THE CLIENT ITSELF STAYS TYPED ─────────────────────────────────────────────────────────────
const db = readFileSync('lib/db.ts', 'utf8');
// CODE ONLY — db.ts's own comment explains the `globalThis as any` it no longer does. Third time
// today a source scan has matched an explanation instead of an instruction.
const dbCode = db.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check('lib/db.ts does NOT export an `any` client', !/globalThis as any/.test(dbCode),
  'the one word that made every query in the codebase untyped');
check('the check is discriminating — the comment DOES still name it', /globalThis as any/.test(db),
  'the explanation survives; only the code is gone');
check('and the export names a concrete type', /export const prisma: ReturnType<typeof baseClient>/.test(db),
  'a union of base-and-extended costs 200 errors; one concrete type costs 14');

// ── THE PREDICATE BITES ───────────────────────────────────────────────────────────────────────
console.log('\n— proven on synthetic sources —');
check('a cast Prisma result is counted', anyCasts('const x = (await p.a.findFirst({})) as any;') === 1);
check('a bare `session?.user as any` is NOT counted', anyCasts('const u = session?.user as any;') === 0,
  'the session is genuinely untyped — counting it would keep the number from ever reaching zero');
check('a comment mentioning the pattern is not counted', anyCasts('// we removed the (x) as any here\\n') === 0);
check('two wrapped calls on one line are both counted', anyCasts('const a = (f(x)) as any, b = (g(y)) as any;') === 2);
check('whitespace before `as` does not hide one', anyCasts('const x = (f(y))   as any;') === 1);
check('a plain typed read is not counted', anyCasts('const x = await p.a.findFirst({});') === 0,
  'the discriminator — otherwise this counts every line in the repo');
check('`as unknown` is not an `any` cast', anyCasts('const x = (y) as unknown as Foo;') === 0);

console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
process.exit(out.includes('F') ? 1 : 0);
