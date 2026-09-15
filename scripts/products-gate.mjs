/**
 * File: scripts/products-gate.mjs
 * @gate-requires: db, server
 *
 * THE PRODUCTS PAGE — because NO GATE OPENED IT AT ALL, and that is why two months of a broken
 * Edit button went unnoticed while the suite stayed green.
 *
 * ── THE DEFECT THIS EXISTS FOR ──────────────────────────────────────────────────────────────────
 * One editor panel rendered ABOVE the product list. As a catalogue grew past a screenful, clicking
 * Edit on a product low in the list opened that panel several hundred pixels above the viewport.
 * Measured 2026-09-15: the last of eleven products opened its editor at y = -615, and the page then
 * scrolled DOWN as it opened, carrying it further away.
 *
 * THE EDITOR MOUNTED EVERY SINGLE TIME. `editorExists === true` was true throughout, which is why
 * the clause below asserts the editor is IN THE VIEWPORT and never merely that it is in the DOM.
 * A gate written the easy way would have passed for the whole two months.
 *
 * NO BREAKING COMMIT EXISTS. scrollIntoView was never in the file and the panel had sat above the
 * list since the page was built; what changed was the DATA. Nobody would have bisected for this.
 *
 * FIXTURES ON ZZ ONLY, swept before and after, by this gate's own code prefix.
 */
import './_gate-preflight.mjs';
const { gatePrisma, describeError, ZZ_GROUP, gateOrigin, serverReady } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const PREFIX = 'ZZPG-';

let prisma;
let browser = null;
try {
  prisma = await gatePrisma();

  // SWEEP BEFORE: a killed run must not make the next one fail on a duplicate code.
  const sweep = async () => (await prisma.catalogueItem.deleteMany({
    where: { group_id: ZZ_GROUP, code: { startsWith: PREFIX } },
  })).count;
  const before = await sweep();
  if (before) console.log(`  (swept ${before} fixture product(s) left by an earlier run)`);

  /**
   * A LIST LONGER THAN A SCREEN. The defect is invisible on a short list — that is the whole shape
   * of it — so the fixture must be long enough to push the last row below the fold. Twelve at the
   * row height this page uses clears 768px with the header and both collapsed panels above it.
   */
  const N = 12;
  for (let i = 1; i <= N; i++) {
    await prisma.catalogueItem.create({ data: {
      group_id: ZZ_GROUP, code: `${PREFIX}${String(i).padStart(2, '0')}`,
      title: `ZZ Products Gate ${i}`, name: `ZZ Products Gate ${i}`,
      item_type: 'part', unit_cost: 10, unit_price: 20, vat_rate: 20, active: true,
    } });
  }

  const ready = await serverReady();
  check('the dev server serves pages before we drive it', ready.ok, `HTTP ${ready.status}`);
  const origin = gateOrigin();
  browser = await chromium.launch({ channel: 'chrome' });
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  const page = await ctx.newPage();
  await page.goto(`${origin}/admin/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', 'owner@zzgategarage.test');
  await page.fill('input[type="password"]', 'GateGarage!2026');
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }), page.click('button[type="submit"]')]);
  await page.goto(`${origin}/admin/products`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(`text=${PREFIX}01`, { timeout: 25000 });

  console.log('\n— the list shows what the API returned —');
  const api = await (await ctx.request.get(`${origin}/api/catalogue`)).json();
  const apiCodes = api.items.map((i) => i.code).filter((c) => c.startsWith(PREFIX)).sort();
  const onPage = await page.$$eval('button', (bs) => bs.filter((b) => /Edit product/i.test(b.textContent || '')).length);
  check('every product the API returns has a row on the page', apiCodes.length === N && onPage >= N,
    `${apiCodes.length} from the API, ${onPage} Edit buttons rendered`);

  console.log('\n— EDIT OPENS WHERE YOU CAN SEE IT, on the LAST row of a long list —');
  const openLast = async () => page.evaluate(async () => {
    window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 250));
    const bs = [...document.querySelectorAll('button')].filter((b) => /Edit product/i.test(b.textContent || ''));
    const b = bs[bs.length - 1];
    b.scrollIntoView({ block: 'center' });
    await new Promise((r) => setTimeout(r, 300));
    const btnTop = Math.round(b.getBoundingClientRect().top);
    b.click();
    await new Promise((r) => setTimeout(r, 700));
    const ed = document.querySelector('[data-testid="product-editor"]');
    const t = ed ? Math.round(ed.getBoundingClientRect().top) : null;
    return { btnTop, exists: !!ed, top: t, inViewport: t !== null && t >= 0 && t < window.innerHeight, viewportH: window.innerHeight };
  });
  const last = await openLast();
  check('the last row is genuinely below the fold, so this is the real case',
    last.btnTop > 0 && last.btnTop < last.viewportH,
    `button at y=${last.btnTop} of ${last.viewportH} after scrolling to it`);
  check('the editor MOUNTS', last.exists,
    'true for the whole two months this was broken — necessary, and nowhere near sufficient');
  /**
   * THE CLAUSE THAT MATTERS. Not `exists`. The defect was an editor that mounted at y = -615, and any
   * assertion about the DOM alone would have been green while the button did nothing a person could see.
   */
  check('…AND IT IS IN THE VIEWPORT, which is the whole bug', last.inViewport,
    `editor top = ${last.top}, viewport ${last.viewportH} — negative means above the fold, where it used to open`);
  check('  …and it opens AT the row you clicked, not somewhere else on the page',
    last.top !== null && Math.abs(last.top - last.btnTop) < 120,
    `button y=${last.btnTop}, editor y=${last.top} — in place needs no scroll logic and cannot drift`);

  console.log('\n— a required field SAYS so, rather than silently disabling Save —');
  const emptied = await page.evaluate(async () => {
    const setVal = (el, v) => {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const ed = document.querySelector('[data-testid="product-editor"]');
    const ta = ed.querySelector('textarea');
    setVal(ta, '');
    await new Promise((r) => setTimeout(r, 400));
    const save = [...ed.querySelectorAll('button')].find((b) => /^save$/i.test((b.textContent || '').trim()));
    const hint = ed.querySelector('[data-testid="required-name"]');
    return { saveDisabled: !!save?.disabled, hintText: hint ? hint.textContent.trim() : null };
  });
  check('clearing the description disables Save', emptied.saveDisabled,
    'the rule itself is right — it was the silence that was the defect');
  check('  …AND the field says why, in words, beside the field',
    !!emptied.hintText && /description is required/i.test(emptied.hintText),
    emptied.hintText ?? 'NOTHING — a control that does nothing and does not say why is the reported bug');
  const refilled = await page.evaluate(async () => {
    const ed = document.querySelector('[data-testid="product-editor"]');
    const ta = ed.querySelector('textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, 'ZZ refilled');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
    const save = [...ed.querySelectorAll('button')].find((b) => /^save$/i.test((b.textContent || '').trim()));
    return { saveDisabled: !!save?.disabled, hintGone: !ed.querySelector('[data-testid="required-name"]') };
  });
  check('  …and filling it clears the hint and enables Save',
    !refilled.saveDisabled && refilled.hintGone,
    'a hint that outlives the problem is furniture');

  console.log('\n— Add opens, saves, and the product appears —');
  await page.goto(`${origin}/admin/products`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(`text=${PREFIX}01`, { timeout: 25000 });
  const addCode = `${PREFIX}NEW`;
  const added = await page.evaluate(async (code) => {
    const setVal = (el, v) => {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const addBtn = [...document.querySelectorAll('button')].find((b) => /add product/i.test(b.textContent || ''));
    addBtn.click();
    await new Promise((r) => setTimeout(r, 600));
    const ed = document.querySelector('[data-testid="product-editor"]');
    if (!ed) return { opened: false };
    const openTop = Math.round(ed.getBoundingClientRect().top);
    const inputs = [...ed.querySelectorAll('input')];
    setVal(inputs[0], code);
    setVal(ed.querySelector('textarea'), 'ZZ added by the gate');
    const nums = [...ed.querySelectorAll('input[type=number]')];
    setVal(nums[0], '10'); setVal(nums[1], '20');
    await new Promise((r) => setTimeout(r, 400));
    const save = [...ed.querySelectorAll('button')].find((b) => /^save$/i.test((b.textContent || '').trim()));
    const wasDisabled = !!save.disabled;
    save.click();
    await new Promise((r) => setTimeout(r, 1500));
    return { opened: true, openTop, wasDisabled, listHasIt: document.body.innerText.includes(code) };
  }, addCode);
  check('Add opens the editor, and in the viewport', added.opened && added.openTop >= 0 && added.openTop < 768,
    `top = ${added.openTop}`);
  check('  …Save is enabled once the required fields are filled', added.wasDisabled === false);
  check('  …and the saved product appears in the list', added.listHasIt,
    'without this, "it saved" is a claim about a network call rather than about the page');
  const inDb = await prisma.catalogueItem.count({ where: { group_id: ZZ_GROUP, code: addCode } });
  check('  …and it is really on the tenant, not only on the screen', inDb === 1);

} catch (e) {
  check('run completed', false, describeError(e).slice(0, 200));
} finally {
  await browser?.close().catch(() => {});
  if (prisma) {
    try {
      const gone = await prisma.catalogueItem.deleteMany({
        where: { group_id: ZZ_GROUP, code: { startsWith: PREFIX } },
      });
      check('teardown removed the fixture products', true, `${gone.count} removed`);
      const left = await prisma.catalogueItem.count({ where: { group_id: ZZ_GROUP, code: { startsWith: PREFIX } } });
      check('  …and ZZ holds none of this gate’s products again', left === 0, `${left}`);
    } catch (e) { check('teardown completed', false, describeError(e).slice(0, 200)); }
  }
}
console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
await prisma?.$disconnect();
process.exit(out.includes('F') ? 1 : 0);
