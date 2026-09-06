/**
 * File: scripts/engine-room-palette-gate.mjs
 * THE ENGINE ROOM IS DARK IN THE SAME PALETTE, NOT A SECOND ONE.
 * @gate-requires: server:3000
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────────────────────────
 * tailwind.config says it plainly: "never raw slate/blue or hex", and "do not reintroduce a second
 * palette". AdminLayout obeys it. The Engine Room did not: 320 hardcoded colours across 15 files —
 * slate classes, and inline hex that had copied the RAIL's own values (#7C8AA3 is --sidebar-muted).
 *
 * ── THE RULE IS TOKENS, NOT A THEME ─────────────────────────────────────────────────────────────
 * This gate briefly asserted that the Engine Room was DARK — that _document stamped data-theme and
 * that --surface resolved to #1E293B. That was a fact about a decision, and the decision changed
 * the same day: the workspace is light again, like the tenant app.
 *
 * What survives the decision is that every colour comes from a TOKEN. So that is what is asserted,
 * and for ALL raw Tailwind scales rather than slate alone — the first version banned slate and hex
 * and let 84 status classes through (bg-emerald-900/50, text-amber-200), tuned for a dark ground
 * and wrong on a light one. A ban that names one colour family teaches the next person to reach for
 * a different family.
 *
 * ── AND THE TOKENS MUST RESOLVE ─────────────────────────────────────────────────────────────────
 * A scan proves the classes are gone; it cannot prove they RESOLVE. So the custom properties are
 * read off the served document, and the check is that the workspace is the SAME ground the tenant
 * app uses — not a particular colour this gate has opinions about.
 *
 * Read-only: no fixtures, no tenant, no credentials. /superadmin/login is pre-auth, which is why
 * the theme can be proved without standing up an operator.
 */
import './_gate-preflight.mjs';
const { serverReady, describeError } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');
const { readFileSync, readdirSync, existsSync } = await import('node:fs');

/**
 * THE THREE PLACES THE BRAND ASSET IS NAMED, and the one thing that can silently break them.
 *
 * The file is greasedesk-Logo.png — CAPITAL L. macOS is case-insensitive, so a lowercased path
 * resolves locally, passes every check that asks the filesystem, and 404s on Vercel. So the name is
 * compared against readdirSync's OUTPUT, which is the real directory entry, rather than against
 * existsSync, which would forgive the mistake this exists to catch.
 */
const BRAND_ASSET = '/greasedesk-Logo.png';

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
  console.log('\n— no second palette, and no third one —');
  const offenders = [];
  for (const f of erFiles) {
    const raw = [...code(f).matchAll(/\b(?:bg|text|border|ring|divide|decoration|from|to|via)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d+/g)].length;
    const hex = [...code(f).matchAll(/#[0-9a-fA-F]{6}\b/g)].length;
    if (raw + hex) offenders.push(`${f.replace('pages/superadmin/', '')}:${raw}slate${hex ? `+${hex}hex` : ''}`);
  }
  check('no raw Tailwind colour scale or hex anywhere in the Engine Room', offenders.length === 0, offenders.join(' ') || `${erFiles.length} files clean`);
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
  console.log('\n— one brand asset, named identically in three places —');
  const publicNames = readdirSync('public');
  check('the asset exists with EXACTLY that case', publicNames.includes(BRAND_ASSET.slice(1)),
    `${BRAND_ASSET} — matched against the real directory entry, not a case-insensitive filesystem`);
  check('BrandLogo points at it', code('components/BrandLogo.tsx').includes(`'${BRAND_ASSET}'`),
    'the 1.93 MB glow render is not a UI asset');
  check('the middleware opens exactly it', code('middleware.ts').includes(`BRAND_ASSET = '${BRAND_ASSET}'`),
    'er. serves only the Engine Room, so this one path is the whole of /public it can reach');
  // AND NOTHING STILL REACHES FOR THE OLD ONE. A stale reference would 404 on er. and weigh
  // 1.93 MB everywhere else, which is the shape that survives review.
  const stale = ['components/BrandLogo.tsx', 'middleware.ts', 'scripts/engine-room-palette-gate.mjs']
    .filter((f) => /greasedesk-logo-source\.png/.test(code(f)));
  check('  …and none of the three still names the old asset', stale.length === 0, stale.join(', ') || 'clean');

  // NOTHING STAMPS A THEME. _document briefly set data-theme for /superadmin; a leftover would put
  // the workspace back on the dark tokens while every class name still looked right.
  check('_document stamps no theme at all', !/data-theme/.test(doc),
    'the Engine Room and the tenant app render on the same tokens, unswitched');

  // ── 4. AND THE TOKENS ACTUALLY RESOLVE ───────────────────────────────────────────────────────
  // The half a scan cannot reach: `bg-surface` with no data-theme is a WHITE workspace with the
  // right class name.
  console.log('\n— and the tokens resolve to the same values the tenant app uses —');
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
  check('the Engine Room is NOT on a theme of its own', read.theme === null,
    `data-theme=${read.theme} — the distinction from the tenant app is the hostname and the label`);
  check('  …so the workspace is the tenant app\'s own surface', read.surface.toUpperCase() === '#FFFFFF', read.surface);
  check('  …and the tenant app\'s own ink', read.text.toUpperCase() === '#0F1E33', read.text);
  check('  …on the tenant app\'s own ground', read.content.toUpperCase() === '#F4F6FA', read.content);
  check('the rail is the tenant app\'s own navy', read.sidebar.toUpperCase() === '#0B1E3B', read.sidebar);
  check('  …and the accent is the tenant app\'s own blue', read.accent.toUpperCase() === '#2563EB', read.accent);
  check('the page painted on that ground', /^rgb\(244, 246, 250\)$/.test(read.bodyBg), read.bodyBg);

  const logo = await page.evaluate(async () => {
    const r = await fetch('/greasedesk-Logo.png', { method: 'GET' });
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
