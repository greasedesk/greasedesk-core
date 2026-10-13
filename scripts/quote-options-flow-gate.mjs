/**
 * File: scripts/quote-options-flow-gate.mjs
 * @gate-requires: db, server
 *
 * A QUOTE WITH OPTIONS, FROM THE CUSTOMER'S PAGE TO THE AGREED LINES.
 *
 * ── WHAT THIS IS FOR ────────────────────────────────────────────────────────────────────────────
 * An acceptance is the act the job card, the parts and the invoice all follow from, and
 * lib/invoice-issue bills a COLUMN COPY of the one version that reads `accepted`. So the clause
 * this gate exists for is that a selection resolves to exactly those lines and no others — and
 * that there is still exactly ONE accepted version afterwards, because two would make the bill
 * depend on an ordering nobody declared.
 *
 * It also holds the line that the printed page asks no arithmetic of the reader, under real print
 * media emulation: `hidden print:block` is a CSS claim, and asserting it from the HTML would prove
 * only that the markup exists.
 *
 * FIXTURES on ZZ, prefix ZZQO, swept before and after.
 */
import './_gate-preflight.mjs';
const { gatePrisma, describeError, ZZ_GROUP, gateOrigin, serverReady , onTeardown, declineIfLimiterExhausted} = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const R = '/Users/hugh/Developer/greasedesk-core';
const XQ = 'ZZQO';
const INTERNAL = 'ZZQO INTERNAL customer is a nightmare do not quote cheap';

let prisma; let browser = null;

const step = async (n, f) => { try { await f(); } catch (e) { console.log(`  teardown ${n}: ${describeError(e).slice(0, 110)}`); } };

/**
 * ── ONE SWEEP, TWO CALLERS, AND THE SIGNAL PATH ────────────────────────────────────────────────
 * This gate had the sweep written TWICE — once before the run and once in the finally — and they
 * had already drifted: only the second cleared the new option drafts. Two spellings of one rule is
 * the defect this suite keeps finding in product code, written here in a gate about options.
 * Registered with onTeardown so the runner's cap can run it over SIGTERM. Idempotent.
 */
const sweepFixtures = async () => {
  // A signal can arrive before gatePrisma() resolves; there is nothing to sweep yet if it does.
  if (!prisma) return 0;
  const vs = await prisma.vehicle.findMany({ where: { group_id: ZZ_GROUP, registration: { startsWith: XQ } }, select: { id: true } });
  const ids = vs.map((v) => v.id);
  const cards = (await prisma.jobCard.findMany({ where: { vehicle_id: { in: ids } }, select: { id: true } })).map((c) => c.id);
  await step('links', () => prisma.customerMagicLink.deleteMany({ where: { job_card_id: { in: cards } } }));
  const vers = (await prisma.quoteVersion.findMany({ where: { job_card_id: { in: cards } }, select: { id: true } })).map((v) => v.id);
  await step('version lines', () => prisma.quoteVersionLine.deleteMany({ where: { quote_version_id: { in: vers } } }));
  await step('options', () => prisma.quoteOption.deleteMany({ where: { quote_version_id: { in: vers } } }));
  await step('versions', () => prisma.quoteVersion.deleteMany({ where: { id: { in: vers } } }));
  await step('drafts', () => prisma.quoteOptionDraft.deleteMany({ where: { job_card_id: { in: cards } } }));
  await step('items', () => prisma.jobCardItem.deleteMany({ where: { job_card_id: { in: cards } } }));
  await step('cards', () => prisma.jobCard.deleteMany({ where: { id: { in: cards } } }));
  await step('vehicles', () => prisma.vehicle.deleteMany({ where: { id: { in: ids } } }));
  await step('customers', () => prisma.customer.deleteMany({ where: { group_id: ZZ_GROUP, name: { startsWith: XQ } } }));
  return ids.length;
};
onTeardown(sweepFixtures);

try {
  const origin = gateOrigin();
  await serverReady(origin);
  prisma = await gatePrisma();
  const { createMagicLink } = await import(`${R}/lib/magic-link.ts`);
  const { acceptQuote } = await import(`${R}/lib/quote-acceptance.ts`);

  await sweepFixtures();

  const site = await prisma.site.findFirst({ where: { group_id: ZZ_GROUP }, select: { id: true } });
  const user = await prisma.user.findFirst({ where: { group_id: ZZ_GROUP }, select: { id: true } });
  const cust = await prisma.customer.create({ data: { group_id: ZZ_GROUP, site_id: site.id, name: `${XQ} Customer`, address: '1 Road', email: 'zzqo@example.invalid' }, select: { id: true } });
  const veh = await prisma.vehicle.create({ data: { group_id: ZZ_GROUP, registration: `${XQ}01`, registration_normalized: `${XQ}01`, make: 'MINI', model: 'Cooper' }, select: { id: true } });
  const card = await prisma.jobCard.create({
    data: { group_id: ZZ_GROUP, site_id: site.id, customer_id: cust.id, vehicle_id: veh.id,
      status: 'quoted', garage_notes: INTERNAL },
    select: { id: true, status: true },
  });

  const L = (over) => ({ item_type: 'fixed', qty: 1, vat_rate: 20, labour_outsourced: false, ...over });
  const v1 = await prisma.quoteVersion.create({
    data: {
      group_id: ZZ_GROUP, job_card_id: card.id, version: 1, status: 'sent',
      net_pennies: 100000, vat_pennies: 20000, gross_pennies: 120000,
      vat_registered: true, tax_label: 'VAT', created_by_user: user.id,
      narrative: 'The engine needs a rebuild. I would do the pump at the same time while it is apart.',
      lines: { create: [
        L({ position: 1, description: 'Engine rebuild', unit_price: 800, line_vat: 160, line_total: 800 }),
        L({ position: 2, description: 'Gaskets', unit_price: 200, line_vat: 40, line_total: 200 }),
      ] },
    },
    select: { id: true },
  });

  // ── THE OFFER, AS THREE INDEPENDENT GROUPS ────────────────────────────────────────────────────
  // One of each shape the model has, plus the case the shape exists FOR: extras that hang off a
  // base. `kind` and `group_key` are still written because the columns are still NOT NULL / still
  // there — they are the retiring flat shape and nothing reads them any more.
  const mkGroup = async (g) => prisma.quoteOptionGroup.create({ data: { quote_version_id: v1.id, ...g }, select: { id: true } });
  const gExtras = await mkGroup({ shape: 'base_plus_extras', position: 1, title: 'You can also add' });
  const gService = await mkGroup({ shape: 'pick_one', position: 2, title: 'Service level' });
  const gBrakes = await mkGroup({ shape: 'base_plus_extras', position: 3, title: 'Brakes' });

  const mkOpt = async (o) => prisma.quoteOption.create({ data: { quote_version_id: v1.id, ...o }, select: { id: true } });
  // gExtras has NO base: the base is the MAIN QUOTE, which is always happening. This is the old
  // standalone `addition`, and it must keep behaving exactly as it did.
  const pump = await mkOpt({ kind: 'addition', group_id: gExtras.id, position: 1, title: 'Water pump', net_pennies: 10000, vat_pennies: 2000, gross_pennies: 12000,
    incentive_kind: 'amount_off', incentive_label: '£50 off with the rebuild', incentive_ex_pennies: 5000, incentive_vatable: true, incentive_gross_off_pennies: 6000 });
  const clutch = await mkOpt({ kind: 'addition', group_id: gExtras.id, position: 2, title: 'Clutch and flywheel', net_pennies: 30000, vat_pennies: 6000, gross_pennies: 36000 });
  const bronze = await mkOpt({ kind: 'variation', group_id: gService.id, position: 3, group_key: 'service', title: 'Bronze service', net_pennies: 7500, vat_pennies: 1500, gross_pennies: 9000 });
  const silver = await mkOpt({ kind: 'variation', group_id: gService.id, position: 4, group_key: 'service', title: 'Silver service', net_pennies: 12500, vat_pennies: 2500, gross_pennies: 15000 });
  const gold = await mkOpt({ kind: 'variation', group_id: gService.id, position: 5, group_key: 'service', title: 'Gold service', net_pennies: 20000, vat_pennies: 4000, gross_pennies: 24000,
    incentive_kind: 'included', incentive_label: 'a free diagnostic' });
  // gBrakes HAS a base, so its extra is only orderable while the base is being done.
  const discs = await mkOpt({ kind: 'addition', group_id: gBrakes.id, is_base: true, position: 6, title: 'Front discs and pads', net_pennies: 15000, vat_pennies: 3000, gross_pennies: 18000 });
  // percent_off, with the pennies FROZEN as lib/quote-version resolves them: 10% of a 5000 net
  // line is 500, and of the 6000 gross line is 600. The rate is the wording; the pennies are the
  // promise, and nothing recomputes them after this.
  const fluid = await mkOpt({ kind: 'addition', group_id: gBrakes.id, position: 7, title: 'Brake fluid change', net_pennies: 5000, vat_pennies: 1000, gross_pennies: 6000,
    incentive_kind: 'percent_off', incentive_label: '10% off while it is in', incentive_percent_bp: 1000,
    incentive_ex_pennies: 500, incentive_vatable: true, incentive_gross_off_pennies: 600 });
  // Each option's own lines — the ones a selection pulls in.
  await prisma.quoteVersionLine.createMany({ data: [
    L({ quote_version_id: v1.id, option_id: pump.id, position: 10, description: 'Water pump', unit_price: 100, line_vat: 20, line_total: 100 }),
    L({ quote_version_id: v1.id, option_id: clutch.id, position: 11, description: 'Clutch kit', unit_price: 300, line_vat: 60, line_total: 300 }),
    L({ quote_version_id: v1.id, option_id: bronze.id, position: 12, description: 'Bronze service', unit_price: 75, line_vat: 15, line_total: 75 }),
    L({ quote_version_id: v1.id, option_id: silver.id, position: 13, description: 'Silver service', unit_price: 125, line_vat: 25, line_total: 125 }),
    L({ quote_version_id: v1.id, option_id: gold.id, position: 14, description: 'Gold service', unit_price: 200, line_vat: 40, line_total: 200 }),
    L({ quote_version_id: v1.id, option_id: discs.id, position: 15, description: 'Front discs and pads', unit_price: 150, line_vat: 30, line_total: 150 }),
    L({ quote_version_id: v1.id, option_id: fluid.id, position: 16, description: 'Brake fluid change', unit_price: 50, line_vat: 10, line_total: 50 }),
  ] });

  const link = await createMagicLink({ groupId: ZZ_GROUP, jobCardId: card.id, purpose: 'quote_view', recipient: 'zzqo@example.invalid', baseUrl: origin });
  /**
   * THE VERSION RECORDS THE CREDENTIAL MINTED FOR IT, as the real send does — pages/c/[token]
   * resolves the offer by `magic_link_id` and quite correctly refuses a link bound to no version.
   * The first run of this gate failed here with `no_quote`, which was the fixture skipping a step
   * of the path it claims to walk, not a defect.
   */
  await prisma.quoteVersion.update({ where: { id: v1.id }, data: { magic_link_id: link.id } });

  // ════════════════════════════════════════════════════════════════════════════════════════════
  console.log('— WHAT THE CUSTOMER SEES —');
  browser = await chromium.launch({ channel: 'chrome' });
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 1400 } });
  const page = await ctx.newPage();
  const custErrors = [];
  page.on('pageerror', (e) => custErrors.push(String(e.message).slice(0, 160)));
  page.on('console', (m) => { if (m.type() === 'error') custErrors.push(m.text().slice(0, 160)); });
  await page.goto(link.url, { waitUntil: 'domcontentloaded' });
  /**
   * TOLERANT, AND IT SAYS WHAT IT SAW. A bare `waitForSelector` here threw, ended the gate, and
   * scored one RED on a timeout — which is what three red-proof mutations "proved" before anybody
   * read the page. The page was saying, in words: "Too many links have been opened from this
   * connection in the last hour." The magic-link limiter is 60 per IP per hour (lib/magic-link
   * MAGIC_LIMITS) and re-running this gate fifteen times spends it.
   *
   * The RUNNER reaps loopback limiter rows at the start of a tier; a standalone re-run does not, so
   * a gate that mints a link is cheap to run once and expensive to run in a loop. If this clause
   * ever fails again, read the body before reading the code.
   */
  const custPanel = await page.waitForSelector('[data-testid="quote-options"]', { timeout: 60000 }).catch(() => null);
  // Before concluding anything about the code, ask the page whether it is simply out of links.
  if (!custPanel) declineIfLimiterExhausted(await page.textContent('body').catch(() => ''));
  check('the customer page shows the options', !!custPanel, custPanel ? 'rendered' : `NOT RENDERED — ${((await page.textContent('body')) ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)}`);
  if (!custPanel) throw new Error('no options on the customer page; the clauses below describe a page that is not there');

  const narrative = await page.textContent('[data-testid="quote-narrative"]').catch(() => null);
  check('the garage’s own explanation leads the page', !!narrative && /needs a rebuild/.test(narrative), (narrative ?? 'ABSENT').trim().slice(0, 70));
  /** THE LEAK. garage_notes is documented as internal staff notes and used to render here. */
  const body = (await page.textContent('body')) ?? '';
  check('and the card’s INTERNAL staff notes are nowhere on the customer’s page',
    !body.includes('do not quote cheap'), body.includes('do not quote cheap') ? 'INTERNAL NOTE VISIBLE' : 'absent');

  const grp = (id) => page.locator(`[data-testid="option-group"][data-group="${id}"]`);
  check('the three groups are offered independently, each with its own shape',
    (await page.locator('[data-testid="option-group"]').count()) === 3
    && (await grp(gService.id).getAttribute('data-shape')) === 'pick_one'
    && (await grp(gBrakes.id).getAttribute('data-shape')) === 'base_plus_extras');
  check('  …the pick_one offers three alternatives as radios',
    (await grp(gService.id).locator('[data-testid="option-row"] input[type="radio"]').count()) === 3);
  /** THE OWNER'S RULING, ON THE SCREEN: no default, and declining all of them is offered first. */
  const noneChecked = await grp(gService.id).locator('[data-testid="option-none"] input').isChecked();
  check('  …with “None of these” offered and SELECTED by default', noneChecked, noneChecked ? 'nothing pre-selected' : 'SOMETHING WAS PRE-SELECTED');
  check('  …and the base-less group offers independent tick boxes',
    (await grp(gExtras.id).locator('[data-testid="option-row"] input[type="checkbox"]').count()) === 2);
  check('the total starts at the main quote alone',
    (await page.textContent('[data-testid="live-total"]')) === '£1200.00', await page.textContent('[data-testid="live-total"]'));

  console.log('\n— THE TOTAL MOVES WITH THE CHOICE —');
  await page.locator(`[data-option="${gold.id}"] input`).check();
  await page.waitForFunction(() => document.querySelector('[data-testid="live-total"]')?.textContent !== '£1200.00', { timeout: 5000 });
  check('choosing gold adds gold, and only gold', (await page.textContent('[data-testid="live-total"]')) === '£1440.00', await page.textContent('[data-testid="live-total"]'));
  await page.locator(`[data-option="${silver.id}"] input`).check();
  check('  …and choosing silver REPLACES gold rather than adding to it',
    (await page.textContent('[data-testid="live-total"]')) === '£1350.00', await page.textContent('[data-testid="live-total"]'));
  await page.locator(`[data-option="${pump.id}"] input`).check();
  check('ticking the pump adds it with its £50 saving already taken off',
    (await page.textContent('[data-testid="live-total"]')) === '£1410.00',
    `${await page.textContent('[data-testid="live-total"]')} = 1350 + 120 − 60`);
  const disc = await page.textContent('[data-testid="discount-note"]').catch(() => null);
  check('  …and says so in words', !!disc && /£50 off with the rebuild/.test(disc) && /£60\.00 off/.test(disc), (disc ?? 'ABSENT').trim());
  await page.locator(`[data-option="${gold.id}"] input`).check();
  const inc = await page.textContent('[data-testid="included-note"]').catch(() => null);
  check('gold’s free diagnostic is named as INCLUDED and moves no money',
    !!inc && /Includes a free diagnostic/.test(inc) && (await page.textContent('[data-testid="live-total"]')) === '£1500.00',
    `${inc?.trim()} · ${await page.textContent('[data-testid="live-total"]')} = 1200 + 240 + 120 − 60`);

  console.log('\n— AN EXTRA IS ONLY ORDERABLE WHILE ITS BASE IS —');
  const fluidBox = grp(gBrakes.id).locator(`[data-option="${fluid.id}"] input`);
  check('the extra is NOT tickable before its base', await fluidBox.isDisabled(),
    'fitting pads on a car that is not in for brakes is an order nothing is holding up');
  const why = await grp(gBrakes.id).locator('[data-testid="needs-base"]').textContent().catch(() => null);
  check('  …and the page SAYS WHY rather than just refusing', !!why && /Front discs and pads/.test(why),
    (why ?? 'ABSENT').replace(/\s+/g, ' ').trim().slice(0, 100));
  await grp(gBrakes.id).locator(`[data-option="${discs.id}"] input`).check();
  check('  …ticking the base adds it and frees the extra',
    (await page.textContent('[data-testid="live-total"]')) === '£1680.00' && !(await fluidBox.isDisabled()),
    `${await page.textContent('[data-testid="live-total"]')} = 1500 + 180`);
  await fluidBox.check();
  check('the percentage comes off as the PENNIES that were frozen, not a fresh sum',
    (await page.textContent('[data-testid="live-total"]')) === '£1734.00',
    `${await page.textContent('[data-testid="live-total"]')} = 1680 + 60 − 6`);

  console.log('\n— WHAT THEY SAVED —');
  const saved = await page.textContent('[data-testid="savings-total"]').catch(() => null);
  check('the savings figure is the money-moving incentives, added up',
    !!saved && /£66\.00/.test(saved), `${(saved ?? 'ABSENT').trim()} — £60 off the pump + £6 off the fluid`);
  check('  …and the free diagnostic is NOT in it, though it is on the page',
    !!saved && !/£306|£66\.00 \(incl/.test(saved)
    && /Includes a free diagnostic/.test(await page.textContent('[data-testid="included-note"]') ?? ''),
    'a saving the invoice does not show is a figure that will not match it');

  /** UNTICKING THE BASE TAKES ITS EXTRAS WITH IT. Left ticked, the customer would be sending an
   *  order for work with nothing holding it up — and the total would carry it. */
  await grp(gBrakes.id).locator(`[data-option="${discs.id}"] input`).uncheck();
  check('dropping the base drops its extras with it',
    (await page.textContent('[data-testid="live-total"]')) === '£1500.00' && !(await fluidBox.isChecked()),
    `${await page.textContent('[data-testid="live-total"]')} — back to the main quote plus gold and the pump`);

  /** PRINTED, UNDER REAL PRINT EMULATION. `hidden print:block` is a CSS claim and the HTML cannot
   *  settle it — a markup-only assertion would pass on a page that prints nothing. */
  console.log('\n— THE PRINTED PAGE —');
  await page.emulateMedia({ media: 'print' });
  const printedVisible = await page.locator('[data-testid="printed-options"]').isVisible();
  const controlsVisible = await page.locator('[data-testid="quote-options"]').isVisible();
  check('printing shows the static option tables', printedVisible);
  check('  …and hides every control, because a printed radio button records no answer', !controlsVisible);
  const pgrp = (id) => page.locator(`[data-testid="printed-group"]`).filter({ hasText: id });
  const prow = await page.locator('[data-testid="printed-group"][data-shape="pick_one"] [data-testid="printed-option-row"]').allTextContents();
  check('each alternative prints a COMPLETE price including the work above',
    prow.some((t) => t.includes('£1290.00')) && prow.some((t) => t.includes('£1350.00')) && prow.some((t) => t.includes('£1440.00')),
    prow.map((t) => t.replace(/\s+/g, ' ').trim()).join(' | ').slice(0, 120));
  const arow = await page.locator('[data-testid="printed-group"][data-shape="base_plus_extras"] [data-testid="printed-option-row"]').allTextContents();
  check('an extra off the MAIN quote prints its own price and the total with the work above',
    arow.some((t) => t.includes('£120.00') && t.includes('£1260.00')),
    arow.map((t) => t.replace(/\s+/g, ' ').trim()).join(' | ').slice(0, 130));
  /** INSIDE A GROUP WITH A BASE there is no complete price to print: it depends on the base AND on
   *  which other extras are ticked, so a figure there would be a different total for every reader. */
  check('  …but inside a group WITH a base, no complete price is printed at all',
    arow.some((t) => t.includes('£60.00') && !t.includes('with the work above')),
    arow.filter((t) => t.includes('£60.00')).join(' | ').replace(/\s+/g, ' ').trim().slice(0, 120));
  const noTotal = await page.textContent('[data-testid="printed-no-total"]');
  check('there is NO grand total while a choice is open, and the page says why',
    /no single total until you choose/.test(noTotal ?? '') && /which service/.test(noTotal ?? ''), (noTotal ?? '').trim().slice(0, 110));
  await page.emulateMedia({ media: 'screen' });

  console.log('\n— ACCEPTING WITHOUT CHOOSING —');
  const noSel = await ctx.request.post(`${origin}/api/quote-respond`, { data: { token: link.rawToken, action: 'accept' } });
  const noSelBody = await noSel.json().catch(() => ({}));
  check('a yes to a quote with options and no choice is REFUSED, not defaulted',
    noSel.status() === 400 && noSelBody.code === 'selection_required', `HTTP ${noSel.status()} ${noSelBody.code ?? ''}`);
  const stillSent = await prisma.quoteVersion.findUnique({ where: { id: v1.id }, select: { status: true } });
  check('  …and nothing was accepted', stillSent?.status === 'sent', String(stillSent?.status));

  console.log('\n— THE SELECTION BECOMES THE AGREEMENT —');
  const ok = await ctx.request.post(`${origin}/api/quote-respond`, {
    data: { token: link.rawToken, action: 'accept', selection: { byGroup: { [gExtras.id]: [pump.id], [gService.id]: [gold.id] } } },
  });
  check('accepting with a choice succeeds', ok.status() === 200, `HTTP ${ok.status()} ${JSON.stringify(await ok.json().catch(() => ({}))).slice(0, 80)}`);

  const versions = await prisma.quoteVersion.findMany({
    where: { job_card_id: card.id }, orderBy: { version: 'asc' },
    select: { version: true, status: true, net_pennies: true, vat_pennies: true, gross_pennies: true,
      resolved_from_version: true, selection_json: true, narrative: true,
      lines: { orderBy: { position: 'asc' }, select: { description: true, line_total: true, line_vat: true, option_id: true } } },
  });
  check('a resolved version was minted', versions.length === 2 && versions[1].version === 2, `${versions.length} version(s)`);
  /** EXACTLY ONE. lib/invoice-issue bills the accepted version; two would make the bill depend on
   *  an ordering nobody declared. */
  check('  …and there is EXACTLY ONE accepted version, the resolved one',
    versions.filter((v) => v.status === 'accepted').length === 1 && versions[1].status === 'accepted' && versions[0].status === 'superseded',
    versions.map((v) => `v${v.version}=${v.status}`).join(', '));
  check('  …which records what it resolved from, and what was chosen',
    versions[1].resolved_from_version === 1
    && versions[1].selection_json?.byGroup?.[gService.id]?.[0] === gold.id
    && versions[1].selection_json?.byGroup?.[gExtras.id]?.[0] === pump.id,
    JSON.stringify(versions[1].selection_json));
  check('  …and carries the same narrative the customer read', /needs a rebuild/.test(versions[1].narrative ?? ''));

  const rl = versions[1].lines;
  const descs = rl.map((l) => l.description);
  check('the agreed lines are the main work, the chosen option, and the saving — and nothing else',
    descs.join(' | ') === 'Engine rebuild | Gaskets | Water pump | Gold service | £50 off with the rebuild',
    descs.join(' | '));
  check('  …with no line left pointing at an option, because these ARE the quote now',
    rl.every((l) => l.option_id === null));
  const discLine = rl.find((l) => l.description.startsWith('£50 off'));
  check('  …and the saving is one negative line whose VAT falls out of the frozen figures',
    Number(discLine.line_total) === -50 && Number(discLine.line_vat) === -10,
    `net ${discLine.line_total}, vat ${discLine.line_vat} (gross £60 off)`);
  const sumNet = rl.reduce((t, l) => t + Number(l.line_total), 0);
  const sumVat = rl.reduce((t, l) => t + Number(l.line_vat), 0);
  check('the version totals are the SUM of its own lines, not a recompute',
    versions[1].net_pennies === Math.round(sumNet * 100) && versions[1].vat_pennies === Math.round(sumVat * 100)
    && versions[1].gross_pennies === Math.round((sumNet + sumVat) * 100),
    `net ${versions[1].net_pennies} vat ${versions[1].vat_pennies} gross ${versions[1].gross_pennies}`);
  check('  …and the agreed total is what the page showed when they pressed the button',
    versions[1].gross_pennies === 150000, `£${(versions[1].gross_pennies / 100).toFixed(2)}`);

  const after = await prisma.jobCard.findUnique({ where: { id: card.id }, select: { status: true, accepted_at: true } });
  check('the card is accepted and dated, as it is for every other door', after?.status === 'accepted' && !!after.accepted_at);

  /** THE STATED RULE, AGAINST THE DATA: a sent version's gross is the MAIN quote, not the sum of
   *  everything on offer. */
  const { grossAgreesWithRule } = await import(`${R}/lib/quote-options.ts`);
  check('gross_pennies on the options version is the main quote as sent',
    versions[0] && grossAgreesWithRule(120000, { netPennies: 100000, vatPennies: 20000, grossPennies: 120000 }),
    'the sum of every option would have been £1,968.00');

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // AUTHORED AS A DRAFT, FROZEN AT SEND
  // ════════════════════════════════════════════════════════════════════════════════════════════
  console.log('\n— A DRAFT OPTION BECOMES A FROZEN ONE —');
  {
    const { freezeQuoteVersion } = await import(`${R}/lib/quote-version.ts`);
    const c2 = await prisma.customer.create({ data: { group_id: ZZ_GROUP, site_id: site.id, name: `${XQ} Draft` }, select: { id: true } });
    const v2 = await prisma.vehicle.create({ data: { group_id: ZZ_GROUP, registration: `${XQ}02`, registration_normalized: `${XQ}02` }, select: { id: true } });
    const card2 = await prisma.jobCard.create({ data: { group_id: ZZ_GROUP, site_id: site.id, customer_id: c2.id, vehicle_id: v2.id, status: 'quoted' }, select: { id: true } });

    const dPump = await prisma.quoteOptionDraft.create({ data: { job_card_id: card2.id, kind: 'addition', position: 1, title: 'Water pump',
      incentive_kind: 'amount_off', incentive_label: '50 off', incentive_ex_pennies: 5000, incentive_vatable: true, incentive_gross_off_pennies: 6000 }, select: { id: true } });
    const dGold = await prisma.quoteOptionDraft.create({ data: { job_card_id: card2.id, kind: 'variation', position: 2, group_key: 'service', title: 'Gold' }, select: { id: true } });
    const dSilver = await prisma.quoteOptionDraft.create({ data: { job_card_id: card2.id, kind: 'variation', position: 3, group_key: 'service', title: 'Silver' }, select: { id: true } });
    /** A draft option nobody put a line on. Not an offer — see the clause below. */
    await prisma.quoteOptionDraft.create({ data: { job_card_id: card2.id, kind: 'addition', position: 4, title: 'Nothing on it' } });

    const item = (description, unit_price, vat_amount, option_draft_id) => ({
      job_card_id: card2.id, description, qty: 1, unit_price, vat_rate: 20, vat_amount,
      item_type: 'fixed', option_draft_id,
    });
    await prisma.jobCardItem.createMany({ data: [
      item('Engine rebuild', 800, 160, null),
      item('Gaskets', 200, 40, null),
      item('Water pump', 100, 20, dPump.id),
      item('Gold service', 200, 40, dGold.id),
      item('Silver service', 125, 25, dSilver.id),
    ] });

    const frozen = await freezeQuoteVersion({ groupId: ZZ_GROUP, jobCardId: card2.id, vatRegistered: true, taxLabel: 'VAT', createdByUserId: user.id });
    const fv = await prisma.quoteVersion.findUnique({
      where: { id: frozen.id },
      select: { gross_pennies: true, net_pennies: true,
        options: { orderBy: { position: 'asc' } },
        lines: { select: { description: true, option_id: true } } },
    });
    /** THE RULE, AT THE MOMENT IT IS WRITTEN. A version whose gross counted every option would
     *  report the price of taking all three at once — a number nobody was ever offered. */
    check('the frozen version gross is the MAIN quote, excluding every option',
      fv.gross_pennies === 120000 && fv.net_pennies === 100000,
      `${fv.gross_pennies}p (main plus all options would be ${120000 + 12000 + 24000 + 15000}p)`);
    check('each draft option became a frozen one, in order',
      fv.options.map((o) => o.title).join(', ') === 'Water pump, Gold, Silver',
      fv.options.map((o) => o.title).join(', '));
    /** AN OPTION WITH NO LINES IS NOT AN OFFER. Freezing it would print a zero-priced choice. */
    check('  …and the draft nobody put a line on was NOT frozen as a zero-priced choice',
      !fv.options.some((o) => o.title === 'Nothing on it'), `${fv.options.length} option(s)`);
    const pump = fv.options.find((o) => o.title === 'Water pump');
    check('an option frozen total is the sum of its OWN lines',
      pump.net_pennies === 10000 && pump.vat_pennies === 2000 && pump.gross_pennies === 12000,
      `net ${pump.net_pennies} vat ${pump.vat_pennies}`);
    check('  …and its incentive came across whole', pump.incentive_kind === 'amount_off'
      && pump.incentive_ex_pennies === 5000 && pump.incentive_gross_off_pennies === 6000 && pump.incentive_vatable === true);
    check('the main lines carry no option and the option lines carry theirs',
      fv.lines.filter((l) => l.option_id === null).map((l) => l.description).sort().join(', ') === 'Engine rebuild, Gaskets'
      && fv.lines.filter((l) => l.option_id !== null).length === 3,
      `${fv.lines.filter((l) => l.option_id === null).length} main, ${fv.lines.filter((l) => l.option_id !== null).length} on options`);
    check('  …and the variations share one group, so they read as one choice',
      new Set(fv.options.filter((o) => o.kind === 'variation').map((o) => o.group_key)).size === 1);
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // AND A GARAGE CAN ACTUALLY BUILD ONE
  // ════════════════════════════════════════════════════════════════════════════════════════════
  console.log('\n— THE AUTHORING SURFACE —');
  {
    const c3 = await prisma.customer.create({ data: { group_id: ZZ_GROUP, site_id: site.id, name: `${XQ} Author` }, select: { id: true } });
    const v3 = await prisma.vehicle.create({ data: { group_id: ZZ_GROUP, registration: `${XQ}03`, registration_normalized: `${XQ}03` }, select: { id: true } });
    /**
     * `stage_details_done` IS THE GATE. The Quote tab is reachable only once Details is complete
     * (lib/jobcard-tabs: `quote: { reachable: detailsComplete }`), so a fixture that skips it lands
     * on a card showing a padlock — which is exactly what the first version of this clause hit, and
     * reported as "the panel is missing" for five diagnostics before the page said 🔒Quote out loud.
     * The estimator does this by filling in the customer and pressing done; the fixture has to too.
     */
    const card3 = await prisma.jobCard.create({ data: { group_id: ZZ_GROUP, site_id: site.id, customer_id: c3.id, vehicle_id: v3.id, status: 'quoted', stage_details_done: true }, select: { id: true } });
    await prisma.jobCardItem.createMany({ data: [
      { job_card_id: card3.id, description: 'Engine rebuild', qty: 1, unit_price: 800, vat_rate: 20, vat_amount: 160, item_type: 'fixed' },
      { job_card_id: card3.id, description: 'Water pump', qty: 1, unit_price: 100, vat_rate: 20, vat_amount: 20, item_type: 'part' },
    ] });

    /**
     * A FRESH CONTEXT FOR THE STAFF SESSION. `ctx` has been driving the CUSTOMER's magic-link page
     * and carries its cookies; signing a garage user in on top of that is a state no real browser
     * is in, and it is not what this clause is about.
     */
    const staff = await browser.newContext({ viewport: { width: 1280, height: 1200 } });
    const pg = await staff.newPage();
    const jsErrors = [];
    pg.on('pageerror', (e) => jsErrors.push(String(e.message).slice(0, 180)));
    pg.on('console', (m) => { if (m.type() === 'error') jsErrors.push(m.text().slice(0, 180)); });
    await pg.goto(`${origin}/admin/login`, { waitUntil: 'domcontentloaded' });
    await pg.fill('input[type="email"]', 'owner@zzgategarage.test');
    await pg.fill('input[type="password"]', 'GateGarage!2026');
    await Promise.all([pg.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }), pg.click('button[type="submit"]')]);
    await pg.goto(`${origin}/admin/jobcards/${card3.id}?tab=quote`, { waitUntil: 'domcontentloaded' });
    /**
     * THIS WORKSPACE IS CLIENT-RENDERED: the server sends the nav and __NEXT_DATA__, and every
     * control appears only after hydration. So the wait is for HYDRATION, not for a response — and
     * hydration on a dev server that this gate has just spent two minutes hammering is slower than
     * on an idle one, which is why 25s passed standalone and failed here.
     *
     * TOLERANT, because a throw ends the gate and every clause after it goes unrun — a missing
     * panel would then be reported as silence rather than as the one thing that is wrong.
     */
    await pg.waitForLoadState('networkidle').catch(() => {});
    const panel = await pg.waitForSelector('[data-testid="estimate-options"]', { timeout: 60000 }).catch(() => null);
    check('the estimate screen offers an options section at all', !!panel,
      panel ? 'it is reachable' : `NOT RENDERED at ${pg.url().replace(origin, '')} — main says: ${((await pg.locator('main').first().textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim().slice(0, 160)}`);
    if (!panel) throw new Error('no options panel; the clauses below describe a screen that is not there');
    check('  …and explains the two kinds before any exist',
      /added to the quote if the customer wants it/.test((await pg.textContent('[data-testid="no-options"]')) ?? ''),
      ((await pg.textContent('[data-testid="no-options"]')) ?? 'ABSENT').trim().slice(0, 80));

    await pg.click('[data-testid="add-addition"]');
    await pg.waitForSelector('[data-testid="option-editor"]', { timeout: 10000 });
    await pg.fill('[data-testid="option-title"]', 'Water pump');
    /** TICK THE LINE THAT BELONGS TO IT. Unticked everywhere stays the main quote. */
    const ticks = pg.locator('[data-testid="option-line-tick"] input');
    await ticks.nth(1).check();
    await pg.selectOption('[data-testid="option-incentive"]', 'amount_off');
    await pg.fill('[data-testid="incentive-label"]', '50 off with the rebuild');
    await pg.fill('[data-testid="incentive-amount"]', '60.00');
    // Saved by the card's own save, the way an estimator leaves the screen.
    await pg.keyboard.press('Tab');
    await pg.waitForFunction(async () => {
      const r = await fetch(window.location.pathname, { method: 'HEAD' }); return !!r;
    }, { timeout: 5000 }).catch(() => {});
    await pg.waitForTimeout(2500);   // autosave debounce; the DB poll below is the real condition

    /**
     * WAIT FOR THE CONDITION THIS CLAUSE IS ABOUT. Waiting merely for the draft to EXIST passed on
     * the first autosave — fired after the title was typed and before the incentive was — and then
     * reported null incentive figures as a defect. The clause is about the incentive, so that is
     * what the wait is for.
     */
    const landed = await (async () => {
      const deadline = Date.now() + 25000;
      let last = null;
      while (Date.now() < deadline) {
        last = await prisma.quoteOptionDraft.findFirst({ where: { job_card_id: card3.id } });
        if (last?.incentive_gross_off_pennies === 6000) return last;
        await new Promise((r) => setTimeout(r, 400));
      }
      return last;
    })();
    check('an option typed on the screen reaches the database', !!landed && landed.title === 'Water pump',
      landed ? `${landed.kind} "${landed.title}"` : 'NOTHING SAVED');
    check('  …with the incentive, and BOTH figures derived from the one number typed',
      !!landed && landed.incentive_kind === 'amount_off' && landed.incentive_gross_off_pennies === 6000
      && landed.incentive_ex_pennies === 5000 && landed.incentive_vatable === true,
      landed ? `gross off ${landed.incentive_gross_off_pennies}p, ex ${landed.incentive_ex_pennies}p` : '—');
    const tagged = await prisma.jobCardItem.findMany({ where: { job_card_id: card3.id }, select: { description: true, option_draft_id: true } });
    check('  …and the ticked line belongs to it while the other stays the main quote',
      tagged.find((x) => x.description === 'Water pump')?.option_draft_id === landed?.id
      && tagged.find((x) => x.description === 'Engine rebuild')?.option_draft_id === null,
      tagged.map((x) => `${x.description}=${x.option_draft_id ? 'option' : 'main'}`).join(', '));
    /**
     * ── REMOVING AN OPTION IS REGROUPING, NOT DELETING ────────────────────────────────────────
     * Its lines go back to the MAIN quote. Deleting work somebody typed because they changed their
     * mind about how to group it is the kind of loss nobody notices until the invoice is short.
     * Found by a 0 RED: nothing reached the removal path, so the rule was unproved.
     */
    await pg.click('[data-testid="remove-option"]');
    const survived = await (async () => {
      const deadline = Date.now() + 25000;
      let rows = [];
      while (Date.now() < deadline) {
        const drafts = await prisma.quoteOptionDraft.count({ where: { job_card_id: card3.id } });
        rows = await prisma.jobCardItem.findMany({ where: { job_card_id: card3.id }, select: { description: true, option_draft_id: true } });
        if (drafts === 0) return rows;
        await new Promise((r) => setTimeout(r, 400));
      }
      return rows;
    })();
    check('removing an option returns its work to the main quote rather than deleting it',
      survived.length === 2 && survived.every((x) => x.option_draft_id === null),
      survived.map((x) => `${x.description}=${x.option_draft_id ? 'option' : 'main'}`).join(', ') || 'NO LINES LEFT');

    await staff.close();
  }

} catch (e) {
  check('run completed', false, describeError(e).slice(0, 300));
} finally {
  await browser?.close().catch(() => {});
  if (prisma) {
    try {
      await sweepFixtures();
      const left = await prisma.vehicle.count({ where: { group_id: ZZ_GROUP, registration: { startsWith: XQ } } });
      check('teardown left none of this gate’s rows', left === 0, `${left} left`);
    } catch (e) { check('teardown ran', false, describeError(e).slice(0, 120)); }
    await prisma.$disconnect().catch(() => {});
  }
  const f = out.filter((x) => x === 'F').length;
  console.log(`\n${f} failures of ${out.length}`);
  process.exit(f ? 1 : 0);
}
