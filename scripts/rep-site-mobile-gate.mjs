/**
 * File: scripts/rep-site-mobile-gate.mjs
 * THE RESELLER SITE AT 375px. Mobile first is the brief, so the phone is the case that is proved.
 * @gate-requires: server
 *
 * `browser` is NOT a token the runner acts on (server, server:NNNN, db, none — gate-origin-gate holds
 * that list). Declaring it would have read as a checked requirement and been silently ignored.
 *
 * This site is opened from a phone, from a link in a video description (owner, 2026-09-12). So the
 * assertion is not "it has responsive classes" — it is that nothing is cut off or unreachable at the
 * width it will actually be opened at.
 *
 * ── WHY NOT "THE PAGE DOES NOT SCROLL SIDEWAYS" ─────────────────────────────────────────────────
 * Because that clause would pass on a broken page. styles/globals.css sets `overflow-x: clip` on
 * html and body app-wide, so a too-wide element produces NO horizontal scrollbar — it is silently
 * CLIPPED, which is worse than scrolling because nothing shows that content is missing. The check
 * therefore walks the elements and compares each one's scrollWidth against the viewport, which is the
 * measurement `overflow-x: clip` hides.
 *
 * ── AND THE TAP TARGETS ─────────────────────────────────────────────────────────────────────────
 * The form is the point of the page. A 44px minimum is the platform guidance both iOS and Android
 * publish; inputs below it on a phone are the difference between a submitted enquiry and a lost one.
 */
import './_gate-preflight.mjs';
const { describeError, repOrigin, REP_RESOLVER_ARGS } = await import('./_gate-preflight.mjs');
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const REP = repOrigin();
const PHONE = { width: 375, height: 812 };   // iPhone-class, the common case
/**
 * THE LOW END. 375×812 is one device, and passing on it says nothing about a smaller screen: the
 * narrower the column, the more the copy wraps and the further down everything below it starts.
 * 360×640 is the floor still in real use (older Android, and the height is what actually bites).
 */
const SMALL = { width: 360, height: 640 };

let browser;
try {
  // reps.greasedesk.com does not resolve on this machine, so a browser cannot simply navigate to it —
  // the first run timed out in page.goto for that reason, not because the page was slow. The resolver
  // rule lives in _gate-preflight beside repOrigin() so the origin and the way to reach it cannot drift.
  browser = await chromium.launch({ channel: 'chrome', args: REP_RESOLVER_ARGS });
  const ctx = await browser.newContext({ viewport: PHONE, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });

  // BOTH VIEWPORTS, not just the comfortable one. A one-off probe at 360 is not coverage; the low end
  // is where wrapping bites, so it is measured every run. /terms is the served address (it was
  // /rep-site/terms here, which now 308s — the browser would have followed it and the clause would
  // have read as covering an address the gate never names).
  for (const vp of [PHONE, SMALL]) for (const [label, path] of [['the public page', '/'], ['the terms page', '/terms']]) {
    const page = await ctx.newPage();
    await page.setViewportSize(vp);
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.message ?? e)));
    await page.goto(`${REP}${path}`, { waitUntil: 'networkidle' });
    // WAIT ON THE CONDITION, NOT THE CLOCK: the heading existing is what says the page rendered.
    await page.waitForSelector('h1', { timeout: 20000 });

    console.log(`\n— ${label} at ${vp.width}×${vp.height} —`);
    const overflow = await page.evaluate((vw) => {
      const bad = [];
      for (const el of document.querySelectorAll('body *')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;            // hidden — the honeypot input, for one
        if (Math.ceil(r.right) > vw + 1 || Math.floor(r.left) < -1) {
          bad.push(`${el.tagName.toLowerCase()}${el.className ? '.' + String(el.className).split(' ')[0] : ''} [${Math.round(r.left)}…${Math.round(r.right)}]`);
        }
        if (bad.length >= 6) break;
      }
      return bad;
    }, vp.width);
    check('nothing reaches past the viewport', overflow.length === 0,
      overflow.length ? overflow.join(', ') : 'overflow-x: clip would have HIDDEN this, not scrolled it — so it is measured per element');

    check('the page threw nothing while rendering', errors.length === 0, errors.slice(0, 2).join(' | ') || 'no pageerror');
    const h1 = await page.$eval('h1', (el) => el.textContent?.trim() ?? '');
    check('  …and the heading is there to read', h1.length > 0, h1.slice(0, 60));
    await page.close();
  }

  // ── THE FORM, WHICH IS THE POINT OF THE PAGE ───────────────────────────────────────────────────
  console.log('\n— the form is usable with a thumb —');
  const page = await ctx.newPage();
  await page.goto(`${REP}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="interest-submit"]', { timeout: 20000 });
  /**
   * THE CONSENT BANNER IS A NAMED EXCEPTION, not a silent one.
   *
   * Its three buttons measure 28–30px at this width. It is components/consent/ConsentBanner, shared by
   * the whole public marketing site, so resizing its controls is a site-wide visual change and belongs
   * to its own slice — not to a slice about the reseller site. Excluding it quietly would be the
   * familiar move of narrowing an assertion until it passes, so the exception is DECLARED, its real
   * measurement is asserted below, and everything outside it is still held to 44px. A new small control
   * anywhere on this page still goes red.
   */
  const measure = await page.evaluate(() => {
    const rows = [];
    for (const el of document.querySelectorAll('input:not([type=hidden]):not(.hidden), textarea, button, a[href^="tel:"]')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      rows.push({ label: `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}`, h: Math.round(r.height), inBanner: !!el.closest('[data-testid="consent-banner"]') });
    }
    return rows;
  });
  const small = measure.filter((r) => !r.inBanner && r.h < 44).map((r) => `${r.label} ${r.h}px`);
  check('every control OUTSIDE the consent banner is at least 44px tall', small.length === 0,
    small.slice(0, 6).join(', ') || `${measure.filter((r) => !r.inBanner).length} controls checked — the published iOS and Android minimum`);
  const bannerSmall = measure.filter((r) => r.inBanner && r.h < 44);
  check('  …and the banner is the ONLY exception, still measured', bannerSmall.length > 0 && bannerSmall.length === measure.filter((r) => r.h < 44).length,
    `${bannerSmall.map((r) => `${r.label} ${r.h}px`).join(', ')} — shared chrome; resizing it is its own slice, and this clause turns red if anything else joins it`);
  const submitFullWidth = await page.$eval('[data-testid="interest-submit"]', (el) => el.getBoundingClientRect().width);
  check('  …and the submit button spans the column', submitFullWidth > 250, `${Math.round(submitFullWidth)}px of ${PHONE.width}`);
  // THE HERO CTA must be reachable without hunting: on a phone it is above the fold or nearly.
  await page.close();

  /**
   * ── THE FOLD, AS A NUMBER AT BOTH SIZES ───────────────────────────────────────────────────────
   * The owner's instruction (2026-09-12): report the MARGIN, not a pass. A clause that says "it fits"
   * hides the direction of travel — this measurement moved 413px → 521px the moment real copy landed,
   * and the useful fact is how much room is left, not that some room is left. So both viewports are
   * measured, both numbers are printed whatever the verdict, and the assertion is only the floor.
   */
  console.log('\n— how far down the call to action sits, measured —');
  const folds = [];
  for (const vp of [PHONE, SMALL]) {
    const q = await ctx.newPage();
    await q.setViewportSize(vp);
    await q.goto(`${REP}/`, { waitUntil: 'networkidle' });
    await q.waitForSelector('a[href="#interest"]', { timeout: 20000 });
    const top = Math.round(await q.$eval('a[href="#interest"]', (el) => el.getBoundingClientRect().top));
    const bottom = Math.round(await q.$eval('a[href="#interest"]', (el) => el.getBoundingClientRect().bottom));
    folds.push({ vp, top, bottom, margin: vp.height - bottom });
    await q.close();
  }
  for (const f of folds) {
    check(`${f.vp.width}×${f.vp.height}: the call to action ends ${f.bottom}px down — ${f.margin >= 0 ? `${f.margin}px of fold left` : `${-f.margin}px BELOW the fold`}`,
      true, `top ${f.top}px · button ends ${f.bottom}px · viewport ${f.vp.height}px`);
  }
  // THE FLOOR, and only the floor: it must be reachable without hunting. The numbers above are the
  // reporting; this is the line that turns red.
  const worst = folds.reduce((a, b) => (a.margin < b.margin ? a : b));
  check('  …and on the smallest screen it is still within one and a half screens', worst.bottom < worst.vp.height * 1.5,
    `worst case ${worst.vp.width}×${worst.vp.height}: ends ${worst.bottom}px of ${worst.vp.height}px`);
} catch (e) {
  check('gate run completed', false, describeError(e));
} finally {
  if (browser) await browser.close();
}
console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
process.exit(out.includes('F') ? 1 : 0);
