/**
 * File: scripts/anchored-match-gate.mjs
 * NO GATE WRITES ITS OWN PROPERTY-KEY OR PATH MATCHER. IT CALLS lib/anchored-match.
 * @gate-requires: none
 *
 * ── THE TWO THAT GOT THROUGH ────────────────────────────────────────────────────────────────────
 *   middleware.ts: `startsWith('/api/rep')` also matched /api/reports/vat-summary — a tenant's VAT
 *   return. Shipping the rep portal would have 404'd it on the apex.
 *   rep-auth-gate: /email\s*:/ also matched `contact_email:` — the address a rep may edit — and flagged
 *   a correct route as writing the credential.
 * Both on 2026-09-09, both the substring trap, which this suite had met eight times before them. Each
 * author re-implemented the anchoring, so each author had a fresh chance to get it wrong. The anchoring
 * now lives once, in lib/anchored-match, and this gate is what stops the hand-written idiom coming back
 * — the gate-origin-gate arrangement, which has held since it shipped.
 *
 * ── WHAT IS BANNED ──────────────────────────────────────────────────────────────────────────────
 *   In every script: a regex literal (or new RegExp string) whose HEAD — after any hand-written
 *   anchor such as ^, \b, (^|[^_\w]) or a lookbehind — is a property key: /verified: true/,
 *   /(^|[^_\w])email\s*:/, /"stale"\s*:\s*true/. A regex literal whose head is a path: /\/admin\/login/.
 *   A string path test: .startsWith('/api/rep'), .includes('/api/x'), .indexOf('/x').
 *   In app code (middleware, pages, components, lib): the path forms. That is where /api/rep lived.
 *
 * ── WHAT THIS DOES NOT CATCH — said here, where the mechanism lives ─────────────────────────────
 * (Rule F's lesson: a partial check that reads as complete retires the vigilance covering the rest.)
 *   a key in the MIDDLE of a regex, /\{ id: x \}/ — its left context is the anchoring, written out;
 *   a key or path built by concatenation or template; an indexOf('email:') on a non-path string;
 *   a regex whose first token is not a key but whose claim is still the wrong shape. None of the
 *   other eight instances of the trap (a term in its own comment, an import mistaken for a render, a
 *   definition mistaken for a call) is a key or a path — this gate does not touch them, and finding it
 *   green is not evidence a new scan is anchored. Red-proving is.
 *   `.endsWith('/x')` is NOT banned: a leading slash and the end of the string anchor both edges.
 *
 * ── WAIVERS ─────────────────────────────────────────────────────────────────────────────────────
 * `// @anchored-ok: <why>` on the line or the line above, for something SHAPED like a key that is not
 * one — a URL scheme (tel:), a limiter key prefix, a token prefix. A waiver with no reason does not
 * count. Every waiver is printed below with its reason, so none is silent.
 */
import './_gate-preflight.mjs';
import './_ts.mjs';
const A = await import('../lib/anchored-match.ts');
const { readFileSync, readdirSync, existsSync } = await import('node:fs');
const { join } = await import('node:path');

/**
 * ONE NAMED EXEMPTION: this file. It carries the banned shapes — the two historical lines verbatim —
 * as the test data that proves the scan can fail. Instance eight of the trap was a scanner matching
 * its own test data; the exemption is the answer to that, named rather than discovered.
 */
const SELF = 'anchored-match-gate.mjs';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const code = (src) => src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

// ── THE SCANNER, exported so the cases below test the real one ────────────────────────────────────
// A regex literal: opened after an operator, a bracket, an arrow or `return` — the arrow was missing
// from the first version, which is how rep-auth-gate's `bites` helper hid from it.
const LIT = /(?:(?<=[(,=:!&|?{;\[>]\s*)|(?<=^\s*)|(?<=\breturn\s+))(\/(?![/*])(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n\[])+\/[dgimsuy]*)/g;
const ANCHORS = [/^\^/, /^\\b/, /^\\s[*+?]?/, /^\\W/, /^\(\?:\^\|[^)]*\)/, /^\(\^\|[^)]*\)/, /^\[\^[^\]]*\]/, /^\(\?<[!=][^)]*\)/, /^ \*/];
const HEAD_KEY = /^(?:\(\?:|\()?\\?["']?[A-Za-z_$][\w$]*(?:\|[A-Za-z_$][\w$]*)*\)?\\?["']?(?:\\\?)?(?:\\s[*+?]?| \*| )?:/;
const HEAD_PATH = /^\\\/[A-Za-z_]/;
// A path in a string: the quote the string opened with closes it — a quote of the other kind inside
// (indexOf('/admin/settings"')) is part of the path, and the first version stopped at it.
const STR_PATH = /\.(startsWith|includes|indexOf|lastIndexOf)\(\s*(['"`])\/[A-Za-z_](?:(?!\2).)*\2/g;
const WAIVED = /@anchored-ok:\s*\S/;

export function stripAnchors(body) {
  let b = body, moved = true;
  while (moved) { moved = false; for (const a of ANCHORS) { const m = b.match(a); if (m && m[0].length) { b = b.slice(m[0].length); moved = true; } } }
  return b;
}

/** Every key or path matcher a source writes for itself. `only: 'path'` for app code. */
export function ownMatchers(src, { only } = {}) {
  const found = [];
  const lines = src.split('\n');
  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    if (WAIVED.test(lines[i - 1] ?? '') || WAIVED.test(line)) return;
    for (const m of line.matchAll(LIT)) {
      const lit = m[1];
      const head = stripAnchors(lit.slice(1, lit.lastIndexOf('/')));
      if (only !== 'path' && HEAD_KEY.test(head)) found.push({ line: i + 1, kind: 'key', text: lit });
      else if (HEAD_PATH.test(head)) found.push({ line: i + 1, kind: 'path', text: lit });
    }
    if (only !== 'path') {
      for (const m of line.matchAll(/new RegExp\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g)) {
        if (HEAD_KEY.test(stripAnchors(m[2].replace(/\\\\/g, '\\')))) found.push({ line: i + 1, kind: 'key', text: m[0] });
      }
    }
    for (const m of line.matchAll(STR_PATH)) found.push({ line: i + 1, kind: 'path', text: m[0] });
  });
  return found;
}

/** The waivers a source carries, with their reasons — printed, never silent. */
export function waivers(src) {
  return src.split('\n').flatMap((l, i) => { const m = l.match(/@anchored-ok:\s*(.*)$/); return m && m[1].trim() ? [{ line: i + 1, why: m[1].trim() }] : []; });
}
const regexCount = (src) => code(src).split('\n').reduce((n, l) => n + [...l.matchAll(LIT)].length, 0);

// ── 1. THE HELPER, ON THE TWO REAL CASES ─────────────────────────────────────────────────────────
console.log('\n— the helper, against the two cases that got through —');
check('the tenant VAT return is NOT under /api/rep', existsSync('pages/api/reports/vat-summary.ts') && !A.underPath('/api/reports/vat-summary', '/api/rep'),
  'pages/api/reports/vat-summary.ts exists — the real route startsWith(\'/api/rep\') took');
check('  …while a real rep route IS', existsSync('pages/api/rep/prospects.ts') && A.underPath('/api/rep/prospects', '/api/rep') && A.underPath('/api/rep', '/api/rep'),
  'the positive case, on a route that exists — a helper that says no to everything passes the line above');
check('  …and the tenant\'s own /admin/settings/rep is not the rep portal', !A.underPath('/admin/settings/rep', '/rep'),
  'one directory up, and one rename from colliding');
const profile = code(readFileSync('pages/api/rep/profile.ts', 'utf8'));
check('the REAL profile route writes contact_email', A.hasKey(profile, 'contact_email'),
  'the positive case: the file the old scan misread is still the file under test');
check('  …and the helper does not read it as the credential', !A.hasKey(profile, 'email'),
  'contact_email is the address on a rep\'s invoice; `email` is the one they sign in with');
check('  …while a real `email:` key IS found', A.hasKey('prisma.rep.update({ data: { email: x } })', 'email'),
  'otherwise "not found" is true of a helper that finds nothing');

console.log('\n— and both historical sites now call it —');
const mw = code(readFileSync('middleware.ts', 'utf8'));
check('middleware routes the rep portal through underPath',
  /const isRepPortal = \(p: string\) => underPath\(p, '\/rep'\) \|\| underPath\(p, '\/api\/rep'\);/.test(mw)
  && /import \{ underPath \} from '@\/lib\/anchored-match';/.test(mw));
check('rep-auth-gate finds the credential through hasKey',
  /FORBIDDEN_KEYS\.some\(\(k\) => hasKey\(s, k\)\)/.test(code(readFileSync('scripts/rep-auth-gate.mjs', 'utf8'))));

// A THIRD, FOUND BY THE SWEEP THIS GATE RUNS: /^\/ie(\/|$)/ was anchored by hand, correctly for a
// path — and it was handed asPath / resolvedUrl, which carry the QUERY. /ie?ref=abc resolved GB.
const { resolveConsentRegion } = await import('../lib/consent-config.ts');
check('an Irish page with a query string is still Irish', resolveConsentRegion('/ie?ref=abc') === 'IE' && resolveConsentRegion('/ie') === 'IE',
  `/ie?ref=abc → ${resolveConsentRegion('/ie?ref=abc')} — a referral link used to land Ireland on GB consent copy`);
check('  …and a path that merely starts with ie is not', resolveConsentRegion('/ieee') === 'GB' && resolveConsentRegion('/') === 'GB');

// ── 2. THE SCAN BITES ─────────────────────────────────────────────────────────────────────────────
console.log('\n— the scan flags the two historical lines, verbatim —');
const MW_HISTORICAL = "const isRepPortal = (p: string) => p === '/rep' || p.startsWith('/rep') || p === '/api/rep' || p.startsWith('/api/rep');";
const MW_HAND_ANCHORED = "const isRepPortal = (p: string) => p === '/rep' || p.startsWith('/rep/') || p === '/api/rep' || p.startsWith('/api/rep/');";
check('the bare prefix that took /api/reports is FLAGGED', ownMatchers(MW_HISTORICAL, { only: 'path' }).length === 2);
check('  …and so is the hand-anchored version that replaced it', ownMatchers(MW_HAND_ANCHORED, { only: 'path' }).length === 2,
  'correct today, and still one author\'s own rule — the next copy is the one that forgets the slash');
const RA_HISTORICAL = String.raw`const FORBIDDEN_KEYS = /(email|bank_account_name|bank_sort_code|bank_account_number)\s*:/;`;
const RA_HAND_ANCHORED = String.raw`const FORBIDDEN_KEYS = /(^|[^_\w])(email|bank_account_name|bank_sort_code|bank_account_number)\s*:/;`;
check('the credential regex that took contact_email is FLAGGED', ownMatchers(RA_HISTORICAL).length === 1);
check('  …and so is its hand-anchored replacement', ownMatchers(RA_HAND_ANCHORED).length === 1);
check('  …and its twin written after an arrow', ownMatchers(String.raw`const bites = (s) => /(^|[^_\w])(email|bank_sort_code)\s*:/.test(s);`).length === 1,
  'the first version of this scanner did not see a regex after `=>`, and missed exactly this line');

console.log('\n— and the shapes around them —');
check('an unanchored key pin is flagged', ownMatchers('check(x, /verified: true/.test(src));').length === 1,
  '/verified: true/ is also true of `unverified: true`');
check('  …as is one anchored by hand with \\b', ownMatchers(String.raw`/\bvat_registered_at_issue: true\b/.test(s)`).length === 1);
check('  …and a quoted JSON key', ownMatchers(String.raw`return /"stale"\s*:\s*true/.test(t);`).length === 1);
check('  …and a URL regex', ownMatchers(String.raw`!/\/admin\/login/.test(page.url())`).length === 1);
check('  …and a network filter by substring', ownMatchers("page.waitForResponse((r) => r.url().includes('/api/marketing-car'))").length === 1,
  '/api/marketing-car is also the start of /api/marketing-cars');
check('  …and a path string with a quote inside it', ownMatchers(`layout.indexOf('/admin/settings"')`).length === 1,
  'the first version stopped at the inner quote and saw nothing');
check('the helper calls are not', ownMatchers("keyRegex('verified', 'true').test(s); hasKey(s, 'email'); underPath(p, '/api/rep'); urlUnder(r.url(), '/api/x');").length === 0);
check('  …nor is a comment quoting the ban', ownMatchers("// never write p.startsWith('/api/rep') or /email\\s*:/\nunderPath(p, '/api/rep');").length === 0,
  'a file must be able to say what it no longer does — middleware.ts now does exactly that');
check('  …nor endsWith, which a leading slash already anchors', ownMatchers("page.url().endsWith('/rep')").length === 0);
check('a waiver WITH a reason is honoured', ownMatchers('// @anchored-ok: a URL scheme, not a key\ncheck(/tel:/.test(page));').length === 0);
check('  …and one without a reason is not', ownMatchers('// @anchored-ok:\ncheck(/tel:/.test(page));').length === 1,
  'the price of a waiver is a sentence saying which kind of match it is');

// ── 3. THE SWEEP ──────────────────────────────────────────────────────────────────────────────────
console.log('\n— no script writes its own —');
const files = readdirSync('scripts').filter((f) => f.endsWith('.mjs') && f !== SELF);
const offenders = [];
let literals = 0, helperCalls = 0;
const waived = [];
for (const f of files) {
  const s = readFileSync(`scripts/${f}`, 'utf8');
  for (const h of ownMatchers(s)) offenders.push(`${f}:${h.line} [${h.kind}] ${h.text.slice(0, 90)}`);
  for (const w of waivers(s)) waived.push(`${f}:${w.line} — ${w.why}`);
  literals += regexCount(s);
  helperCalls += (code(s).match(/\b(keyRegex|hasKey|countKey|pathRegex|hasPath|underPath|urlUnder)\(/g) ?? []).length;
}
check('every key and path matcher in the suite is lib/anchored-match', offenders.length === 0,
  offenders.length ? `\n    ${offenders.join('\n    ')}\n    Call keyRegex / hasKey / pathRegex / urlUnder / underPath — or waive with // @anchored-ok: <why>` : `${files.length} scripts, none writing its own`);
check('  …and the sweep really read the suite', files.length >= 100 && literals >= 1000,
  `${files.length} scripts, ${literals} regex literals examined`);
// THE OTHER HALF, ON THE SUITE ITSELF. "Zero offenders" is also what a blind scan reports. The
// waived lines are real suite lines of exactly the banned shape — so with their waivers stripped, the
// sweep must flag every one of them, and nothing else.
const unwaived = waived.map((w) => w.split(':')[0]).filter((f, i, a) => a.indexOf(f) === i).flatMap((f) =>
  ownMatchers(readFileSync(`scripts/${f}`, 'utf8').replace(/@anchored-ok:[^\n]*/g, '')).map((h) => `${f}:${h.line}`));
check('  …and it SEES the real banned shape: every waived line is flagged once its waiver goes',
  waived.length > 0 && unwaived.length >= waived.length && waived.every((w) => unwaived.some((u) => {
    const [f, l] = w.split(' — ')[0].split(':'); const [uf, ul] = u.split(':');
    return uf === f && (Number(ul) === Number(l) || Number(ul) === Number(l) + 1); // a waiver sits on the line or the one above
  })),
  `${unwaived.length} flagged across ${waived.length} waivers — ${helperCalls} helper call sites in the suite`);
check(`  …with every waiver saying why (${waived.length})`, waived.length > 0,
  `\n    ${waived.join('\n    ')}`);

// ── 4. THE APP ────────────────────────────────────────────────────────────────────────────────────
console.log('\n— and no reader in the app writes its own path prefix —');
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(d, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [join(d, e.name)] : []);
const appFiles = ['middleware.ts', ...['pages', 'components', 'lib'].flatMap(walk)];
const appOffenders = appFiles.flatMap((f) => ownMatchers(readFileSync(f, 'utf8'), { only: 'path' }).map((h) => `${f}:${h.line} ${h.text.slice(0, 80)}`));
check('no page, component, lib or middleware tests a path by prefix', appOffenders.length === 0,
  appOffenders.length ? `\n    ${appOffenders.join('\n    ')}` : `${appFiles.length} files — startsWith('/m') in _app.tsx took every public page beginning with m out from under the consent banner`);
check('  …and the sweep really read the app', appFiles.length >= 300 && appFiles.includes('middleware.ts'), `${appFiles.length} files`);

console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
process.exit(out.includes('F') ? 1 : 0);
