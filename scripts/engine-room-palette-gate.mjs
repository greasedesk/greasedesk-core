/**
 * File: scripts/engine-room-palette-gate.mjs
 * THE ENGINE ROOM IS DARK IN THE SAME PALETTE, NOT A SECOND ONE.
 * @gate-requires: server:3000
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────────────────────────
 * tailwind.config says it plainly: "Use these everywhere (bg-surface, text-ink, bg-accent, …);
 * never raw slate/blue or hex." AdminLayout obeys it — zero raw slate. The Engine Room did not:
 * 178 raw `slate-*` classes across pages/superadmin and 14 more in its layout, and NOT ONE token.
 *
 * The divergence was deliberate and argued for — an operator with both portals open must never
 * confuse them. The argument survives; the second palette does not. The tenant rail is already dark
 * navy (#0B1E3B) while the ER rail was slate-900 (#0F172A): near enough to look like a mistake,
 * far enough to be one. The distinction that actually reads is DARK THROUGHOUT against a light
 * workspace, and the token set has carried a dark theme all along — `:root[data-theme="dark"]`,
 * written as a scaffold and never wired to anything.
 *
 * ── WHY THE COMPUTED COLOUR, NOT JUST THE CLASS NAMES ───────────────────────────────────────────
 * A scan proves the raw classes are gone. It cannot prove the tokens RESOLVE: `bg-surface` on a
 * page where data-theme was never stamped is a white workspace wearing the right class name, and
 * the scan would be green. So this reads the custom properties off the served document and checks
 * they carry the dark values.
 *
 * Read-only: no fixtures, no tenant, no credentials. /superadmin/login is pre-auth, which is why
 * the theme can be proved without standing up an operator.
 */
import './_gate-preflight.mjs';
const { serverReady, describeError } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');
const { readFileSync, readdirSync, existsSync } = await import('node:fs');

const ER = 'http://er.greasedesk.com:3000';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
/** Code only. A comment may say what the file no longer does. */
const code = (f) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l)).join('\n') : '');
let browser = null;

const erFiles = [
  'components/layout/EngineRoomLayout.tsx',
  ...readdirSync('pages/superadmin').filter((f) => f.endsWith('.tsx')).map((f) => `pages/superadmin/${f}`),
  ...readdirSync('pages/superadmin/tenants').filter((f) => f.endsWith('.tsx')).map((f) => `pages/superadmin/tenants/${f}`),
];

try {
  // ── 1. ONE PALETTE ───────────────────────────────────────────────────────────────────────────
  console.log('\n— no second palette —');
  const offenders = [];
  for (const f of erFiles) {
    const raw = [...code(f).matchAll(/\b(?:bg|text|border|ring|divide|from|to|via)-slate-\d+/g)].length;
    const hex = [...code(f).matchAll(/#[0-9a-fA-F]{6}\b/g)].length;
    if (raw + hex) offenders.push(`${f.replace('pages/superadmin/', '')}:${raw}slate${hex ? `+${hex}hex` : ''}`);
  }
  check('no raw slate or hex anywhere in the Engine Room', offenders.length === 0, offenders.join(' ') || `${erFiles.length} files clean`);
  // POSITIVE: the scan must be looking at something. An empty file list would pass the check above.
  check('  …and the scan really covered the Engine Room', erFiles.length >= 14, `${erFiles.length} files`);
  const layout = code('components/layout/EngineRoomLayout.tsx');
  check('the layout uses the semantic tokens', /bg-sidebar\b/.test(layout) && /border-sidebar-line\b/.test(layout)
    && /bg-accent\b/.test(layout), 'rail on bg-sidebar, active item on bg-accent');

  // ── 2. THE MARK ──────────────────────────────────────────────────────────────────────────────
  console.log('\n— the same logo the tenant app uses —');
  check('the rail renders BrandLogo', /BrandLogo/.test(layout) && /from '@\/components\/BrandLogo'/.test(layout));
  check('  …on its plate, because the rail is dark', !/plate=\{false\}/.test(layout),
    'the PNG has dark-navy parts and would not read against the rail without it');
  // THE PLATE MUST NOT FOLLOW THE THEME. bg-surface is #1E293B under data-theme=dark, so the plate
  // went dark and swallowed the logo's dark-navy half — the plate defeating the reason it exists.
  check('  …and the plate is a guaranteed LIGHT ground', /bg-white/.test(code('components/BrandLogo.tsx'))
    && !/inline-block bg-surface/.test(code('components/BrandLogo.tsx')),
    'it is artwork that cannot change colour, not chrome that should follow the theme');
  check('  …and the hand-rolled ER square is gone', !/>ER</.test(layout));
  check('  …while the Engine Room label is kept', /Engine Room/.test(layout));

  // ── 3. THE THEME IS WIRED ────────────────────────────────────────────────────────────────────
  const doc = code('pages/_document.tsx');
  check('_document stamps the dark theme on Engine Room routes',
    /data-theme/.test(doc) && /superadmin/.test(doc), 'SSR, so the page never paints light first');

  // ── 4. AND THE TOKENS ACTUALLY RESOLVE ───────────────────────────────────────────────────────
  // The half a scan cannot reach: `bg-surface` with no data-theme is a WHITE workspace with the
  // right class name.
  console.log('\n— and the tokens resolve to the dark values in the served page —');
  const ready = await serverReady();
  check('the dev server serves pages before we drive it', ready.ok, `HTTP ${ready.status} after ${ready.attempts} attempt(s)`);
  browser = await chromium.launch({ channel: 'chrome', args: ['--host-resolver-rules=MAP er.greasedesk.com 127.0.0.1'] });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await page.goto(`${ER}/superadmin/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(300);
  const read = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    return { theme: document.documentElement.getAttribute('data-theme'),
      surface: v('--surface'), text: v('--text'), content: v('--content-bg'),
      sidebar: v('--sidebar-bg'), accent: v('--accent'),
      bodyBg: getComputedStyle(document.body).backgroundColor };
  });
  check('the Engine Room document is stamped dark', read.theme === 'dark', `data-theme=${read.theme}`);
  check('  …so --surface is the dark surface, not white', read.surface.toUpperCase() === '#1E293B', read.surface);
  check('  …and --text is the light ink', read.text.toUpperCase() === '#F1F5F9', read.text);
  check('  …and the workspace ground is dark', read.content.toUpperCase() === '#0F172A', read.content);
  // UNCHANGED BY THE THEME, and that is the point of one palette: the rail and the accent are the
  // SAME brand values the tenant app uses, on both themes.
  check('the rail is the tenant app\'s own navy', read.sidebar.toUpperCase() === '#0B1E3B', read.sidebar);
  check('  …and the accent is the tenant app\'s own blue', read.accent.toUpperCase() === '#2563EB', read.accent);
  check('the page actually painted dark', /^rgb\(15, 23, 42\)$/.test(read.bodyBg), read.bodyBg);

  const logo = await page.evaluate(async () => {
    const r = await fetch('/greasedesk-logo-source.png', { method: 'GET' });
    return { status: r.status, type: r.headers.get('content-type') };
  });
  check('the brand image actually loads on the er. host', logo.status === 200,
    `HTTP ${logo.status} ${logo.type ?? ''} — er. serves only the Engine Room, so /public 404s unless allowed`);
} catch (e) {
  check('gate run completed', false, describeError(e).slice(0, 300));
} finally {
  if (browser) await browser.close().catch(() => {});
}

console.log(`\n${out.filter((x) => x === 'F').length} failures of ${out.length}`);
process.exit(out.includes('F') ? 1 : 0);
