/**
 * File: scripts/admin-shell-gate.mjs
 * NO ADMIN PAGE MOUNTS THE SHELL ITSELF — _app already did.
 *
 * ── WHY A GATE AND NOT A COMMENT ────────────────────────────────────────────────────────────────
 * The comment existed. pages/admin/setup.tsx has carried "_app auto-wraps every /admin page in
 * AdminLayout — do NOT wrap again here" for months, and the Marketing page was written with a
 * second AdminLayout inside the first anyway: two nested sidebars and a broken layout.
 *
 * A comment in one file does not reach somebody writing another. That is the same reach problem as
 * an escalation described in five files with no sender, or a rule stated where nobody looks — and
 * the answer is the same one: make it structural, so the next person is stopped rather than
 * expected to have read the right file first.
 *
 * ── AND IT IS NOT ONLY COSMETIC ─────────────────────────────────────────────────────────────────
 * _app mounts the shell ONCE and keeps it mounted across admin navigations, deliberately: the
 * locations bar does not refetch, tab switches do not tear the shell down, and there is no layout
 * shift. A page that wraps itself remounts the whole thing on every visit, so the bug costs the
 * persistence the design exists for as well as looking wrong.
 *
 * Pure source scan. No fixtures, no database, no server.
 */
import './_gate-preflight.mjs';
const { readFileSync, readdirSync, statSync } = await import('node:fs');
const { join } = await import('node:path');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };

const walk = (dir) => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? walk(p) : (p.endsWith('.tsx') ? [p] : []);
});
const pages = walk('pages/admin');

console.log('\n— the shell is mounted once, in _app —');
// PIN THE RULE, NOT THE SPELLING. This matched the exact expression, so adding a PROP to the
// shell — `<AdminLayout fullHeight={…}>` — read as "the shell is no longer mounted in _app". The
// rule is that the mount is conditional on useAdminShell and falls back to the bare page.
const appSrc = readFileSync('pages/_app.tsx', 'utf8');
check('_app wraps every /admin route except login',
  /useAdminShell\s*\?\s*<AdminLayout[\s>][\s\S]{0,200}?<\/AdminLayout>\s*:\s*page/.test(appSrc));

// The RENDER, not the import: a page may legitimately mention the name in a comment saying not to.
const wrappers = pages.filter((p) => /<AdminLayout[\s>]/.test(readFileSync(p, 'utf8')));
check('no admin page renders it again', wrappers.length === 0,
  wrappers.join(', ') || `${pages.length} pages checked`);

// An unused import is the half-step to the mistake, and setup.tsx had one for months.
const strays = pages.filter((p) => {
  const s = readFileSync(p, 'utf8');
  return /^import AdminLayout /m.test(s) && !/<AdminLayout[\s>]/.test(s);
});
check('  …and none imports it without using it', strays.length === 0,
  strays.join(', ') || 'a dead import is the half-step to the mistake');

// THE SCANNER MUST BE ABLE TO FIRE. A pattern matching nothing proves nothing.
check('  …and the scan would catch a wrapper if one came back',
  /<AdminLayout[\s>]/.test('  return (\n    <AdminLayout>\n      <h1/>'),
  'proven against a sample rather than trusted');

console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
process.exit(out.includes('F') ? 1 : 0);
