/**
 * File: scripts/client-bundle-gate.mjs
 * NOTHING THAT REACHES lib/db MAY REACH A CLIENT BUNDLE.
 *
 * ── TWICE NOW, AND SILENT BOTH TIMES ────────────────────────────────────────────────────────────
 * Next strips getServerSideProps and the imports used ONLY inside it. An import used anywhere else
 * in the file — a constant in a copy table, a helper in the component — keeps its whole module, and
 * everything that module imports, in the browser bundle. When that chain ends at lib/db, the page
 * ships PrismaClient, whose own guard throws on load, and NO CLIENT JAVASCRIPT RUNS ON THAT ROUTE.
 *
 * Nothing looks broken until somebody tries to click something:
 *   2026-09-07  a diagnostic on a universal import took out every page, twice
 *   2026-09-08  pages/c/[token] used MAGIC_LINK_DAYS in a sentence about link expiry. That one
 *               constant kept @/lib/magic-link — and through it @/lib/db — in the customer pay
 *               page's bundle. The consent banner rendered and could not be dismissed, its effect
 *               never published --consent-height, and PayPanel (ssr:false) never mounted, so the
 *               Pay button was simply absent. Three gates went red, each naming its own symptom:
 *               "body padding-bottom 0px", a missing pay-start, a missing pay-error. None named the
 *               cause, and the one that got reported was the padding.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────────────────────────
 * Every component is client-reachable. A page is client-reachable except inside getServerSideProps.
 * Walk the imports of everything client-reachable; none may arrive at lib/db or @prisma/client.
 *
 * `import type` is erased by the compiler and is NOT a reachability edge — which is what keeps this
 * from banning every `import type { InvoiceDoc }` in the tree.
 */
import './_gate-preflight.mjs';
const { describeError } = await import('./_gate-preflight.mjs');
const { readFileSync, readdirSync, statSync, existsSync } = await import('node:fs');
const { join, dirname, resolve } = await import('node:path');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };

const ROOT = process.cwd();
/** Comments and string bodies removed, so a mention in prose is not a reference. That mistake is
 *  four gates old in this suite, and it made the first diagnosis of THIS defect point at the wrong
 *  line. */
const code = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
  // TEMPLATE LITERALS KEEP THEIR INTERPOLATIONS. Blanking them whole is what hid this defect from
  // its own gate: MAGIC_LINK_DAYS lives inside `…for ${MAGIC_LINK_DAYS} days…`, so a wholesale blank
  // erased the one reference the sweep exists to find. Only the literal TEXT is noise.
  .replace(/`(?:[^`\\]|\\.)*`/g, (lit) => ' ' + [...lit.matchAll(/\$\{([^{}]*)\}/g)].map((m) => m[1]).join(' ') + ' ')
  .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
  .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');

/** '@/lib/x' → an absolute file, or null for a bare package (node_modules). */
function resolveSpec(spec, fromFile) {
  let base = null;
  if (spec.startsWith('@/')) base = join(ROOT, spec.slice(2));
  else if (spec.startsWith('.')) base = resolve(dirname(fromFile), spec);
  else return spec;                              // a package: '@prisma/client', 'react', …
  for (const ext of ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx']) {
    if (existsSync(base + ext)) return base + ext;
  }
  return existsSync(base) && statSync(base).isFile() ? base : null;
}

/** COMMENTS ONLY. Import parsing needs the specifier string intact, so this is a second, weaker
 *  strip than code() above — which blanks strings and is what reference-detection wants. Reading
 *  the clause from one and the specifier from the other is what broke the first version of this
 *  walk: the indices of a stripped source do not line up with the original, so every import in a
 *  file resolved to whichever module happened to sit at that offset. */
const noComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

/** Value imports only — `import type` and inline `type X` bindings are erased, so they are not edges. */
export function valueImports(src) {
  const s = noComments(src);
  const found = [];
  for (const m of s.matchAll(/import\s+(type\s+)?([\s\S]*?)\s*from\s*['"]([^'"]+)['"]/g)) {
    if (m[1]) continue;                                            // import type { … } from '…'
    found.push({ clause: m[2], spec: m[3] });
  }
  return found;
}

/** The bindings a clause introduces, minus inline `type` ones. */
function bindingsOf(clause) {
  const names = [];
  const braces = clause.match(/\{([\s\S]*)\}/);
  if (braces) {
    for (const part of braces[1].split(',')) {
      const t = part.trim();
      if (!t || /^type\s/.test(t)) continue;
      names.push((t.split(/\s+as\s+/).pop() ?? t).trim());
    }
  }
  const bare = clause.replace(/\{[\s\S]*\}/, '').replace(/,/g, ' ').trim();
  for (const b of bare.split(/\s+/)) if (b && b !== '*' && b !== 'as') names.push(b);
  return names.filter(Boolean);
}

const SERVER_SINKS = ['lib/db.ts', '@prisma/client'];
const isSink = (f) => f === '@prisma/client' || (typeof f === 'string' && f.endsWith('/lib/db.ts'));

/** Every module reachable from `entry` through value imports, with the path that got there. */
function reaches(entry, seen = new Map(), trail = []) {
  if (seen.has(entry)) return null;
  seen.set(entry, true);
  if (isSink(entry)) return [...trail, entry];
  if (typeof entry !== 'string' || !entry.startsWith(ROOT)) return null;   // a package that is not a sink
  let src;
  try { src = readFileSync(entry, 'utf8'); } catch { return null; }
  for (const imp of valueImports(src)) {
    const target = resolveSpec(imp.spec, entry);
    if (!target) continue;
    const hit = reaches(target, seen, [...trail, entry]);
    if (hit) return hit;
  }
  return null;
}

/**
 * The half of a page that ships to the browser: the source with getServerSideProps CUT OUT.
 *
 * Not "everything before it" — the first version sliced at the declaration and threw away whatever
 * followed, which silently exonerated any page that puts gSSP above its component. Cutting the
 * body out by brace-matching leaves the rest of the file intact, which is what Next does before
 * tree-shaking: remove gSSP, keep the component, drop whatever nothing retained.
 *
 * It is an APPROXIMATION of webpack's reachability, and deliberately the conservative one: a helper
 * defined at module scope and called only from gSSP still reads as client-reachable here. That is a
 * hazard worth a red gate anyway — whether webpack drops it depends on side-effect analysis nobody
 * should be relying on to keep PrismaClient out of a browser.
 */
/** Cut the body of the first construct at `i` (its outermost braces), or the tail if unbalanced. */
function cutBody(s, i) {
  const open = s.indexOf('{', i);
  if (open === -1) return s.slice(0, i);
  let depth = 0;
  for (let j = open; j < s.length; j++) {
    if (s[j] === '{') depth++;
    else if (s[j] === '}' && --depth === 0) return s.slice(0, i) + s.slice(j + 1);
  }
  return s.slice(0, i);
}

/**
 * MODULE SCOPE ONLY — and this calibration is what makes the sweep usable rather than muted.
 *
 * The loose rule ("referenced anywhere outside getServerSideProps") reported 709 imports across 57
 * pages, against a ground truth — the production build manifest — of THREE. A scanner that cries
 * wolf gets muted, which is worse than not having one.
 *
 * So what counts is a reference at MODULE SCOPE: a top-level const, the copy table, anything
 * evaluated when the module loads. Every function body is cut, gSSP and the component included.
 * That is where both incidents lived — a constant in a copy table on 2026-09-08, a layout import on
 * 2026-09-07 — and it is the shape webpack cannot drop, because a module-scope initialiser runs.
 *
 * ── THE BLIND SPOT, STATED ──────────────────────────────────────────────────────────────────────
 * A server-reaching import used ONLY inside the component's JSX is not caught here. That is covered
 * from the other side by the components rule above: no component may reach lib/db at all, ever. The
 * two together are not a proof, and the only exact answer is the built chunk — which is why the
 * check against a real production build is written down in the report rather than pretended at.
 */
function stripFunctionBodies(s) {
  let out = s;
  for (let guard = 0; guard < 400; guard++) {
    const m = out.match(/\)\s*(?::\s*[^={;]{1,80})?\s*(?:=>\s*)?\{/);
    if (!m) break;
    const next = cutBody(out, m.index);
    if (next === out || next.length >= out.length) break;
    out = next;
  }
  return out;
}

export function clientHalf(src) {
  // THE IMPORT STATEMENTS GO FIRST. Without this every binding matches its own declaration, so
  // every import reads as "used" and the sweep reports 709 leaks against a ground truth of three.
  // Third time today that a scan has matched the thing it was written to look past.
  const noImports = code(src).replace(/import\s+(?:type\s+)?[\s\S]*?\s*from\s*(?:''|"")\s*;?/g, ' ');
  // TYPE DECLARATIONS GO TOO. They are erased at compile time, and their MEMBER NAMES collide with
  // import names: pages/admin/invoices/[id] declares `offersPayLink: boolean` in its Props type,
  // which read as a use of the imported `offersPayLink` and put a page on this list that the
  // production manifest says is clean.
  // BRACE-MATCHED, not regex'd to the next "\n}". The lazy version swallowed everything from the
  // first `type Props = {` to a closing brace further down the file — including the copy table this
  // gate exists to see — and the sweep went green while the defect was still there. A strip that
  // removes too much is a scan that passes for the wrong reason.
  let noTypes = noImports;
  for (let guard = 0; guard < 200; guard++) {
    const m = noTypes.match(/\b(?:type|interface)\s+\w+[^={;]*[={]/);
    if (!m) break;
    const next = cutBody(noTypes, m.index);
    if (next === noTypes || next.length >= noTypes.length) break;
    noTypes = next;
  }
  return stripFunctionBodies(noTypes);
}

const walk = (d) => readdirSync(d).flatMap((e) => {
  const p = join(d, e);
  return statSync(p).isDirectory() ? walk(p) : (/\.(ts|tsx)$/.test(p) ? [p] : []);
});

try {
  // ── 1. THE PARTS, PROVEN ON SYNTHETIC SOURCES ────────────────────────────────────────────────
  console.log('\n— proven on synthetic sources —');
  check('a value import is an edge', valueImports("import { x } from 'm'").length === 1);
  check('  …and it reads the specifier from the SAME source as the clause',
    valueImports("import { x } from 'm'")[0]?.spec === 'm',
    'the first version read the clause from a stripped source and the spec by offset from the original, so every import in a file resolved to the wrong module');
  check('  …and `import type` is NOT', valueImports("import type { X } from 'm'").length === 0,
    'erased by the compiler — banning it would ban every shared type in the tree');
  check('  …nor is an inline type binding', bindingsOf('{ a, type B }').join(',') === 'a',
    'the shape pages/c/[token] uses: { resolveMagicLink, MAGIC_LINK_DAYS, type MagicPurpose }');
  check('a default import is an edge', bindingsOf('Thing').join(',') === 'Thing');
  check('an aliased one keeps the LOCAL name', bindingsOf('{ a as b }').join(',') === 'b');
  const PAGE = "import { K } from '@/lib/x';\nconst COPY = `${K} days`;\nexport const getServerSideProps = async () => { const y = other(); };\n";
  check('a constant used in the copy table is in the CLIENT half', /K/.test(clientHalf(PAGE)),
    'exactly the reference that shipped Prisma to the customer pay page');
  check('  …while a gSSP-only reference is not', !/other/.test(clientHalf(PAGE)));
  const TOP_GSSP = "import { K } from '@/lib/x';\nexport const getServerSideProps = async () => { const y = other(); };\nexport default function P() { return K; }\n";
  check('  …and a gSSP-only reference is not, wherever gSSP sits',
    !/other/.test(clientHalf(TOP_GSSP)),
    'the first version sliced at the declaration, so a page with gSSP above its component was exonerated by position');
  check('  …while a reference inside the COMPONENT is the stated blind spot',
    !/K\b/.test(clientHalf("import { K } from '@/lib/x';\nexport default function P() { return K; }\n")),
    'module scope only — the component side is covered by the components rule, which bans lib/db outright');
  check('an import does not count as a use of itself',
    !/K\b/.test(clientHalf("import { K } from '@/lib/x';\nexport default function P() { return 1; }\n")),
    'otherwise every binding is "used" and the sweep flags the whole tree');
  check('stripping a type does not swallow what follows it',
    /KEEP/.test(clientHalf("import { K } from '@/lib/x';\ntype P = {\n  a: string;\n};\nconst C = `${KEEP} days`;\n")),
    'the lazy regex ate from the first type to a later brace and took the copy table with it');
  check('a type member name is not a use of the import it shadows',
    !/offersPayLink/.test(clientHalf("import { offersPayLink } from '@/lib/x';\ntype Props = {\n  offersPayLink: boolean;\n};\n")),
    'types are erased — and their member names collide with import names');
  check('a mention in a COMMENT is not a reference',
    !/resolveMagicLink/.test(clientHalf("// from resolveMagicLink\nexport const getServerSideProps = async () => {};")),
    'the first diagnosis of this defect pointed at a comment on line 65');

  // ── 2. COMPONENTS ARE ALWAYS CLIENT-REACHABLE ────────────────────────────────────────────────
  console.log('\n— no component reaches the database —');
  const offenders = [];
  for (const f of walk('components')) {
    const hit = reaches(f);
    if (hit) offenders.push(`${f.replace(ROOT + '/', '')} → ${hit.slice(1).map((x) => String(x).replace(ROOT + '/', '')).join(' → ')}`);
  }
  check('no component imports its way to lib/db', offenders.length === 0, offenders.slice(0, 4).join('\n    '));

  // ── 3. AND NO PAGE DOES IT OUTSIDE getServerSideProps ────────────────────────────────────────
  console.log('\n— and no page ships one to the browser —');
  const leaks = [];
  for (const f of walk('pages')) {
    if (f.includes('pages/api/')) continue;                  // server only; never bundled for a browser
    //  ^ NOT '/pages/api/': walk() yields repo-relative paths, so the leading slash never matched and
    //    seven API routes were reported as page leaks.
    const src = readFileSync(f, 'utf8');
    const half = clientHalf(src);
    for (const imp of valueImports(src)) {
      const used = bindingsOf(imp.clause).some((b) => new RegExp(`\\b${b}\\b`).test(half));
      if (!used) continue;                                    // gSSP-only: Next strips it
      const target = resolveSpec(imp.spec, f);
      if (!target) continue;
      const hit = reaches(target);
      if (hit) leaks.push(`${f.replace(ROOT + '/', '')}  [${bindingsOf(imp.clause).join(', ')}]  → ${hit.map((x) => String(x).replace(ROOT + '/', '')).join(' → ')}`);
    }
  }
  // THE WHOLE LIST, and the count first. An earlier version printed six of them and the page this
  // gate exists for was seventh — a truncated failure list is a failure list that can hide its own
  // headline, which is the same shape as the padding message that hid this defect for two days.
  check('no page reaches lib/db from its client half', leaks.length === 0,
    leaks.length ? `${leaks.length} leak(s)\n    ${leaks.join('\n    ')}` : 'every server import is used only inside getServerSideProps');

  // ── 4. AND THE SINK IS STILL THE SINK ────────────────────────────────────────────────────────
  // If lib/db stopped exporting a Prisma client this whole gate would pass while proving nothing.
  console.log('\n— the thing being kept out is still what we think it is —');
  check('lib/db still constructs a Prisma client', /PrismaClient/.test(readFileSync('lib/db.ts', 'utf8')));
  check('  …and the walk really can reach it', reaches(join(ROOT, 'lib/magic-link.ts')) !== null,
    'a module known to import lib/db — otherwise a clean sweep is indistinguishable from a broken walk');
  check('  …but does not flag one that does not', reaches(join(ROOT, 'lib/rep-visit.ts')) === null,
    'lib/rep-visit is pure — if this flagged it, the walk would be finding everything');
} catch (e) {
  check('gate run completed', false, describeError(e).slice(0, 300));
}

console.log(`\n${out.filter((x) => x === 'F').length} failures of ${out.length}`);
process.exit(out.includes('F') ? 1 : 0);
