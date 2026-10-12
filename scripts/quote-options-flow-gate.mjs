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
const { gatePrisma, describeError, ZZ_GROUP, gateOrigin, serverReady } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const R = '/Users/hugh/Developer/greasedesk-core';
const XQ = 'ZZQO';
const INTERNAL = 'ZZQO INTERNAL customer is a nightmare do not quote cheap';

let prisma; let browser = null;
try {
  const origin = gateOrigin();
  await serverReady(origin);
  prisma = await gatePrisma();
  const { createMagicLink } = await import(`${R}/lib/magic-link.ts`);
  const { acceptQuote } = await import(`${R}/lib/quote-acceptance.ts`);

  const sweep = async () => {
    const vs = await prisma.vehicle.findMany({ where: { group_id: ZZ_GROUP, registration: { startsWith: XQ } }, select: { id: true } });
    const ids = vs.map((v) => v.id);
    const cards = (await prisma.jobCard.findMany({ where: { vehicle_id: { in: ids } }, select: { id: true } })).map((c) => c.id);
    await prisma.customerMagicLink.deleteMany({ where: { job_card_id: { in: cards } } });
    const vers = (await prisma.quoteVersion.findMany({ where: { job_card_id: { in: cards } }, select: { id: true } })).map((v) => v.id);
    await prisma.quoteVersionLine.deleteMany({ where: { quote_version_id: { in: vers } } });
    await prisma.quoteOption.deleteMany({ where: { quote_version_id: { in: vers } } });
    await prisma.quoteVersion.deleteMany({ where: { id: { in: vers } } });
    await prisma.jobCard.deleteMany({ where: { id: { in: cards } } });
    await prisma.vehicle.deleteMany({ where: { id: { in: ids } } });
    await prisma.customer.deleteMany({ where: { group_id: ZZ_GROUP, name: { startsWith: XQ } } });
    return ids.length;
  };
  await sweep();

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

  const mkOpt = async (o) => prisma.quoteOption.create({ data: { quote_version_id: v1.id, ...o }, select: { id: true } });
  const pump = await mkOpt({ kind: 'addition', position: 1, title: 'Water pump', net_pennies: 10000, vat_pennies: 2000, gross_pennies: 12000,
    incentive_kind: 'amount_off', incentive_label: '£50 off with the rebuild', incentive_ex_pennies: 5000, incentive_vatable: true, incentive_gross_off_pennies: 6000 });
  const clutch = await mkOpt({ kind: 'addition', position: 2, title: 'Clutch and flywheel', net_pennies: 30000, vat_pennies: 6000, gross_pennies: 36000 });
  const bronze = await mkOpt({ kind: 'variation', position: 3, group_key: 'service', title: 'Bronze service', net_pennies: 7500, vat_pennies: 1500, gross_pennies: 9000 });
  const silver = await mkOpt({ kind: 'variation', position: 4, group_key: 'service', title: 'Silver service', net_pennies: 12500, vat_pennies: 2500, gross_pennies: 15000 });
  const gold = await mkOpt({ kind: 'variation', position: 5, group_key: 'service', title: 'Gold service', net_pennies: 20000, vat_pennies: 4000, gross_pennies: 24000,
    incentive_kind: 'included', incentive_label: 'a free diagnostic' });
  // Each option's own lines — the ones a selection pulls in.
  await prisma.quoteVersionLine.createMany({ data: [
    L({ quote_version_id: v1.id, option_id: pump.id, position: 10, description: 'Water pump', unit_price: 100, line_vat: 20, line_total: 100 }),
    L({ quote_version_id: v1.id, option_id: clutch.id, position: 11, description: 'Clutch kit', unit_price: 300, line_vat: 60, line_total: 300 }),
    L({ quote_version_id: v1.id, option_id: bronze.id, position: 12, description: 'Bronze service', unit_price: 75, line_vat: 15, line_total: 75 }),
    L({ quote_version_id: v1.id, option_id: silver.id, position: 13, description: 'Silver service', unit_price: 125, line_vat: 25, line_total: 125 }),
    L({ quote_version_id: v1.id, option_id: gold.id, position: 14, description: 'Gold service', unit_price: 200, line_vat: 40, line_total: 200 }),
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
  await page.goto(link.url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="quote-options"]', { timeout: 25000 });

  const narrative = await page.textContent('[data-testid="quote-narrative"]').catch(() => null);
  check('the garage’s own explanation leads the page', !!narrative && /needs a rebuild/.test(narrative), (narrative ?? 'ABSENT').trim().slice(0, 70));
  /** THE LEAK. garage_notes is documented as internal staff notes and used to render here. */
  const body = (await page.textContent('body')) ?? '';
  check('and the card’s INTERNAL staff notes are nowhere on the customer’s page',
    !body.includes('do not quote cheap'), body.includes('do not quote cheap') ? 'INTERNAL NOTE VISIBLE' : 'absent');

  check('three variations are offered as one exclusive choice',
    (await page.locator('[data-testid="variation-group"]').count()) === 1
    && (await page.locator('[data-testid="variation-row"]').count()) === 3);
  /** THE OWNER'S RULING, ON THE SCREEN: no default, and declining all of them is offered first. */
  const noneChecked = await page.locator('[data-testid="variation-none"] input').isChecked();
  check('  …with “None of these” offered and SELECTED by default', noneChecked, noneChecked ? 'no variation pre-selected' : 'SOMETHING WAS PRE-SELECTED');
  check('two additions are offered as independent tick boxes',
    (await page.locator('[data-testid="addition-row"]').count()) === 2
    && (await page.locator('[data-testid="addition-row"] input[type="checkbox"]').count()) === 2);
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

  /** PRINTED, UNDER REAL PRINT EMULATION. `hidden print:block` is a CSS claim and the HTML cannot
   *  settle it — a markup-only assertion would pass on a page that prints nothing. */
  console.log('\n— THE PRINTED PAGE —');
  await page.emulateMedia({ media: 'print' });
  const printedVisible = await page.locator('[data-testid="printed-options"]').isVisible();
  const controlsVisible = await page.locator('[data-testid="quote-options"]').isVisible();
  check('printing shows the static option tables', printedVisible);
  check('  …and hides every control, because a printed radio button records no answer', !controlsVisible);
  const prow = await page.locator('[data-testid="printed-variation-row"]').allTextContents();
  check('each variation prints a COMPLETE price including the work above',
    prow.some((t) => t.includes('£1290.00')) && prow.some((t) => t.includes('£1350.00')) && prow.some((t) => t.includes('£1440.00')),
    prow.map((t) => t.replace(/\s+/g, ' ').trim()).join(' | ').slice(0, 120));
  check('  …and not its own price alone, which a reader adds to the wrong base',
    !prow.some((t) => /£90\.00|£150\.00|£240\.00/.test(t)));
  const arow = await page.locator('[data-testid="printed-addition-row"]').allTextContents();
  check('each addition prints its own price AND the total with the work above',
    arow[0].includes('£120.00') && arow[0].includes('£1260.00'), arow[0].replace(/\s+/g, ' ').trim().slice(0, 110));
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
    data: { token: link.rawToken, action: 'accept', selection: { additionIds: [pump.id], variationByGroup: { service: gold.id } } },
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
    && versions[1].selection_json?.variationByGroup?.service === gold.id
    && versions[1].selection_json?.additionIds?.[0] === pump.id,
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

} catch (e) {
  check('run completed', false, describeError(e).slice(0, 300));
} finally {
  await browser?.close().catch(() => {});
  if (prisma) {
    try {
      const vs = await prisma.vehicle.findMany({ where: { group_id: ZZ_GROUP, registration: { startsWith: XQ } }, select: { id: true } });
      const ids = vs.map((v) => v.id);
      const cards = (await prisma.jobCard.findMany({ where: { vehicle_id: { in: ids } }, select: { id: true } })).map((c) => c.id);
      await prisma.customerMagicLink.deleteMany({ where: { job_card_id: { in: cards } } });
      const vers = (await prisma.quoteVersion.findMany({ where: { job_card_id: { in: cards } }, select: { id: true } })).map((v) => v.id);
      await prisma.quoteVersionLine.deleteMany({ where: { quote_version_id: { in: vers } } });
      await prisma.quoteOption.deleteMany({ where: { quote_version_id: { in: vers } } });
      await prisma.quoteVersion.deleteMany({ where: { id: { in: vers } } });
      await prisma.jobCard.deleteMany({ where: { id: { in: cards } } });
      await prisma.vehicle.deleteMany({ where: { id: { in: ids } } });
      await prisma.customer.deleteMany({ where: { group_id: ZZ_GROUP, name: { startsWith: XQ } } });
      const left = await prisma.vehicle.count({ where: { group_id: ZZ_GROUP, registration: { startsWith: XQ } } });
      check('teardown left none of this gate’s rows', left === 0, `${left} left`);
    } catch (e) { check('teardown ran', false, describeError(e).slice(0, 120)); }
    await prisma.$disconnect().catch(() => {});
  }
  const f = out.filter((x) => x === 'F').length;
  console.log(`\n${f} failures of ${out.length}`);
  process.exit(f ? 1 : 0);
}
