/**
 * File: scripts/purchase-model-gate.mjs
 * THE VAT IS RIGHT, THE MODEL MOVES, AND NOTHING ON THE PAGE PRETENDS TO BE MEASURED.
 * @gate-requires: server, db
 *
 * ── THE NUMBERS, NOT THE SHAPE (owner, 2026-09-12) ──────────────────────────────────────────────
 * Being wrong about VAT costs money rather than credibility, so the worked case is asserted as
 * ARITHMETIC: £8,000 in, £10,000 out — £333 on the margin scheme, £1,667 if the car is VAT
 * qualifying. A clause that checked "returns a number" would pass on both a correct implementation
 * and one that is out by a factor of five on every car a garage buys.
 *
 * ── AND THE MOVEMENT, BECAUSE THAT IS THE PRODUCT ───────────────────────────────────────────────
 * Dragging days in stock must visibly take money out; dragging prep hours must halve the workshop
 * cost. Those are properties of the model, provable as arithmetic, and they are what separates this
 * from a calculator that happens to render.
 */
import './_gate-preflight.mjs';
import './_ts.mjs';
const { gatePrisma, describeError, gateOrigin, serverReady, ZZ_GROUP } = await import('./_gate-preflight.mjs');
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');
const { readFileSync } = await import('node:fs');
const { randomUUID } = await import('node:crypto');
// KEY MATCHERS COME FROM ONE PLACE — a hand-written /label: 'x'/ matches the substring, not the key.
const { hasKey } = await import('../lib/anchored-match.ts');
const M = await import('../lib/purchase-model.ts');
const S = await import('../lib/purchase-model-store.ts');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const code = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const prisma = await gatePrisma();
const made = [];
let browser = null;
const pounds = (p) => Math.round(p / 100);

try {
  // ── 1. THE WORKED CASE, AS NUMBERS ───────────────────────────────────────────────────────────
  console.log('\n— £8,000 in, £10,000 out —');
  const IN = 800000, OUT = 1000000;
  const margin = M.vatDuePence(IN, OUT, 'margin');
  const qualifying = M.vatDuePence(IN, OUT, 'qualifying');
  check('margin scheme VAT is £333', pounds(margin) === 333, `${margin}p = £${(margin / 100).toFixed(2)}`);
  check('VAT qualifying is £1,667', pounds(qualifying) === 1667, `${qualifying}p = £${(qualifying / 100).toFixed(2)}`);
  // FIVE TIMES, TO THE PENNY OF ROUNDING. 10000/6 and 2000/6 are exactly 5:1 before rounding; each is
  // then rounded to its own penny, which leaves 2p. Demanding exact equality was MY error, not the
  // model's — and a tolerance of a few pence still catches the error that matters here, which is a
  // factor, not a penny.
  check('  …and they are FIVE TIMES apart, which is why it is a toggle', Math.abs(qualifying - margin * 5) <= 5,
    `${qualifying}p vs ${margin}p × 5 = ${margin * 5}p — guessing this costs money on every car, not credibility`);
  check('the margin is one sixth of the margin, not of the price', margin === Math.round((OUT - IN) / 6));
  check('the qualifying figure is one sixth of the PRICE', qualifying === Math.round(OUT / 6));

  /**
   * ── THE FOUR ROWS, AS NUMBERS ─────────────────────────────────────────────────────────────────
   * The shipped version charged full output VAT with no reclaim, which is algebraically the PLUS-VAT
   * case — correct for the trade convention it silently assumed, and understated by £1,333 when the
   * garage typed a VAT-inclusive price. Neither reading announced itself. All of it is asserted as
   * arithmetic, because a clause about shape would have passed on the version that was wrong.
   *
   * Tolerances are ±2p and stated: each figure is rounded to its own penny, so "identical" between
   * two schemes is identical to the rounding, not to the last unit. A factor still gets caught.
   */
  console.log('\n— the three answers on £8,000 in, £10,000 out —');
  const bare = { ...M.defaultInputs(), purchasePence: IN, salePence: OUT,
    prepHours: 0, partsPence: 0, daysInStock: 0, advertisingPence: 0, warrantyPence: 0, deliveryInPence: 0, deliveryOutPence: 0 };
  const caseOf = (o) => M.computeModel({ ...bare, ...o });
  const mgn = caseOf({ vatStatus: 'margin' });
  const inc = caseOf({ vatStatus: 'qualifying', purchaseIncludesVat: true });
  const plus = caseOf({ vatStatus: 'qualifying', purchaseIncludesVat: false });
  const near = (a, b) => Math.abs(a - b) <= 2;

  check('MARGIN: £333.33 to HMRC, £1,666.67 profit, £8,000 out',
    near(mgn.vat.vatToHmrcPence, 33333) && near(mgn.contributionPence, 166667) && mgn.vat.cashOutPence === 800000,
    `${mgn.vat.vatToHmrcPence}p · ${mgn.contributionPence}p · ${mgn.vat.cashOutPence}p`);
  check('QUALIFYING, price INCLUDES VAT: £333.33 to HMRC, £1,666.67 profit, £8,000 out',
    near(inc.vat.vatToHmrcPence, 33333) && near(inc.contributionPence, 166667) && inc.vat.cashOutPence === 800000,
    `${inc.vat.vatToHmrcPence}p · ${inc.contributionPence}p · ${inc.vat.cashOutPence}p`);
  check('QUALIFYING, price PLUS VAT: £66.67 to HMRC, £333.33 profit, £9,600 out',
    near(plus.vat.vatToHmrcPence, 6667) && near(plus.contributionPence, 33333) && plus.vat.cashOutPence === 960000,
    `${plus.vat.vatToHmrcPence}p · ${plus.contributionPence}p · ${plus.vat.cashOutPence}p`);
  check('  …so margin and inclusive-VAT are THE SAME PROFIT — the reclaim cancels the output VAT',
    near(mgn.contributionPence, inc.contributionPence),
    `${mgn.contributionPence}p vs ${inc.contributionPence}p — the shipped version claimed the toggle was worth £1,333 here`);
  check('  …and plus-VAT is the one that differs, by £1,333', near(inc.contributionPence - plus.contributionPence, 133333),
    `${(inc.contributionPence - plus.contributionPence) / 100} pounds`);

  console.log('\n— cash out is not cost, and the cost of money is charged on the cash —');
  check('a plus-VAT purchase takes 20% more out of the bank than the car costs',
    plus.vat.cashOutPence === 960000 && plus.vat.netCostPence === 800000,
    `${plus.vat.cashOutPence}p out, ${plus.vat.netCostPence}p of cost`);
  check('  …and an inclusive one does not', inc.vat.cashOutPence === 800000 && inc.vat.netCostPence === 800000 - inc.vat.inputVatPence);
  const held = { daysInStock: 90, costOfMoneyAnnualPct: 10 };
  const stockPlus = caseOf({ vatStatus: 'qualifying', purchaseIncludesVat: false, ...held }).stockingCostPence;
  const stockInc = caseOf({ vatStatus: 'qualifying', purchaseIncludesVat: true, ...held }).stockingCostPence;
  const expected = (basePence) => Math.round(basePence * (held.costOfMoneyAnnualPct / 100) * (held.daysInStock / 365));
  check('the cost of money is charged on CASH OUT, not on cost', Math.abs(stockPlus - expected(960000)) <= 2,
    `${stockPlus}p — interest on £9,600 is ${expected(960000)}p, on £8,000 it would be ${expected(800000)}p`);
  check('  …and on the inclusive purchase that base is £8,000', Math.abs(stockInc - expected(800000)) <= 2,
    `${stockInc}p vs ${expected(800000)}p — a tool about tied-up capital that charged interest on the smaller number would be wrong about its subject`);
  check('  …so the two differ by exactly the 20% the VAT adds', Math.abs(stockPlus - Math.round(stockInc * 1.2)) <= 2,
    `${stockPlus}p vs ${Math.round(stockInc * 1.2)}p`);
  check('the margin scheme reclaims nothing, whatever the answer to the question',
    caseOf({ vatStatus: 'margin', purchaseIncludesVat: true }).vat.inputVatPence === 0
    && caseOf({ vatStatus: 'margin', purchaseIncludesVat: true }).vat.cashOutPence === 800000,
    'the question is meaningless there, and the arithmetic says so rather than the form merely hiding it');

  console.log('\n— the page says which reading is in force, and what it is assuming —');
  const pg = code(readFileSync('pages/admin/purchase.tsx', 'utf8'));
  check('it asks the question as the invoice in front of them', /Is that purchase price/.test(pg) && /Plus VAT/.test(pg) && /Includes VAT/.test(pg));
  check('  …only when the car is VAT qualifying', /inputs\.vatStatus === 'qualifying' && \(/.test(pg),
    'on the margin scheme nothing is recoverable and the typed figure is simply what was paid');
  check('  …and SAYS which answer is in force', /data-testid="inc-vat-inforce"/.test(pg) && /leaves the bank/.test(pg),
    'the whole defect was that neither reading announced itself');
  check('the default is PLUS VAT — the conservative reading', M.defaultInputs().purchaseIncludesVat === false
    && S.normaliseInputs({}).purchaseIncludesVat === false,
    'it preserves what shipped and produces the LOWER profit, so an absent field is never the generous answer');
  check('cash out is shown SEPARATELY from cost', /data-testid="out-cash"/.test(pg) && /Cash out to buy it/.test(pg));
  check('the reclaim timing is NAMED, not modelled', /data-testid="reclaim-timing"/.test(pg) && /next VAT return/.test(pg) && /four months/.test(pg));
  check('  …and so is the stock-for-resale assumption', /data-testid="stock-assumption"/.test(pg) && /stock for resale/.test(pg),
    'a tool telling a garage they can reclaim £1,600 is making a claim about their tax position');
  check('the qualifying route is HIDDEN when the tenant is not VAT registered',
    /const qualifyingAvailable = vatRegistered;/.test(pg) && /qualifyingAvailable \? \(/.test(pg)
    && /data-testid="not-vat-registered"/.test(pg),
    'the branch existing says nothing about what DECIDES it — the prop must be what does');
  check('  …read from the TENANT\'s tax profile, not GreaseDesk\'s own', /getTaxProfile\(gate\.vis\.groupId/.test(pg)
    && !/garageVatRegistered/.test(pg),
    'garageVatRegistered() is GreaseDesk Ltd\'s status for its own pricing and says nothing about the garage');
  check('  …and it fails towards the SIMPLER tool', /profile\?\.isRegistered === true/.test(pg),
    'an unreadable profile offers the margin scheme only — offering a reclaim that cannot be made is the expensive direction');

  console.log('\n— and the edges of the scheme —');
  check('no margin, no VAT', M.vatDuePence(1000000, 1000000, 'margin') === 0, 'a car sold at cost owes nothing on the margin scheme');
  check('  …and a LOSS owes nothing either, never a negative', M.vatDuePence(1000000, 800000, 'margin') === 0,
    'a negative VAT figure here would read as money back');
  check('  …while a qualifying car still owes VAT on the full price', M.vatDuePence(1000000, 800000, 'qualifying') === Math.round(800000 / 6),
    'the scheme charges on the sale, not on the outcome');
  check('a free car on the margin scheme owes nothing', M.vatDuePence(0, 0, 'margin') === 0);

  // ── 2. THE MOVEMENT ──────────────────────────────────────────────────────────────────────────
  console.log('\n— the point is the movement —');
  const base = { ...M.defaultInputs(), purchasePence: IN, salePence: OUT, vatStatus: 'margin' };
  const at = (patch) => M.computeModel({ ...base, ...patch });
  const d30 = at({ daysInStock: 30 }), d90 = at({ daysInStock: 90 });
  check('dragging days in stock 30 → 90 takes money OUT', d90.contributionPence < d30.contributionPence,
    `${(d30.contributionPence - d90.contributionPence) / 100} pounds of stocking cost appears`);
  check('  …and it is the stocking cost that moved, nothing else', d90.stockingCostPence > d30.stockingCostPence
    && d90.workshopCostPence === d30.workshopCostPence && d90.otherCostsPence === d30.otherCostsPence,
    `${d30.stockingCostPence}p → ${d90.stockingCostPence}p`);
  // Same rounding, same lesson: each figure is rounded to its own penny, so 3× is 3× ±1p. The
  // property being asserted is LINEARITY — that there is no compounding and no calendar — and a
  // penny of tolerance does not weaken it.
  check('  …tripling the days triples the cost of money', Math.abs(d90.stockingCostPence - d30.stockingCostPence * 3) <= 3,
    `${d30.stockingCostPence}p × 3 = ${d30.stockingCostPence * 3}p vs ${d90.stockingCostPence}p — simple interest, no compounding, no calendar`);
  const h4 = at({ prepHours: 4 }), h2 = at({ prepHours: 2 });
  check('halving prep hours halves the workshop cost', h2.workshopCostPence * 2 === h4.workshopCostPence,
    `${h4.workshopCostPence}p → ${h2.workshopCostPence}p`);
  check('  …and the profit moves by exactly that', h2.contributionPence - h4.contributionPence === h4.workshopCostPence - h2.workshopCostPence);
  check('the two costs a garage rarely counts are separable', at({}).contributionBeforeWorkshopAndMoneyPence - at({}).contributionPence
    === at({}).workshopCostPence + at({}).stockingCostPence,
    'so the tool can say what they take out, rather than only netting them silently');
  check('a zero-day, zero-hour model charges neither', at({ daysInStock: 0, prepHours: 0 }).stockingCostPence === 0
    && at({ daysInStock: 0, prepHours: 0 }).workshopCostPence === 0, 'the discriminator: they are not constants');

  // ── 3. THE RANKING, AND ITS LIMIT ────────────────────────────────────────────────────────────
  console.log('\n— which input moves the answer most —');
  const ranked = M.sensitivity(base);
  check('every slider is ranked', ranked.length === M.SLIDERS.length, `${ranked.length} of ${M.SLIDERS.length}`);
  check('  …in descending order of swing', ranked.every((x, i) => i === 0 || ranked[i - 1].swingPence >= x.swingPence));
  check('  …and the swing is the profit across that slider\'s OWN range, others held', (() => {
    const s = M.SLIDERS.find((x) => x.key === 'daysInStock');
    const lo = M.computeModel({ ...base, daysInStock: s.min }).contributionPence;
    const hi = M.computeModel({ ...base, daysInStock: s.max }).contributionPence;
    return ranked.find((x) => x.key === 'daysInStock').swingPence === Math.abs(hi - lo);
  })());
  // IT IS LOCAL, and that is the property the label promises. Change one input and the ranking may
  // legitimately change — a ranking that never moved would not be local, it would be a table.
  const cheap = M.sensitivity({ ...base, purchasePence: 50000 });
  check('  …and it is LOCAL: a different purchase price can re-rank it', JSON.stringify(ranked.map((x) => x.key)) !== JSON.stringify(cheap.map((x) => x.key)),
    'holding the others is what makes it local; a fixed order would be a table pretending to be analysis');

  // ── 4. NOTHING PRETENDS TO BE MEASURED ───────────────────────────────────────────────────────
  console.log('\n— every slider looks like an assumption, and the ranking says what it is not —');
  const page = code(readFileSync('pages/admin/purchase.tsx', 'utf8'));
  check('the page says once, plainly, that nothing is measured', /Nothing here is measured from your own data/.test(page)
    && /data-testid="assumption-notice"/.test(page));
  check('every slider shows its RANGE as well as its value', /Range \{showSlider\(s\.key, s\.min\)\}/.test(page),
    'a bare number implies somebody knows what normal is');
  check('  …and every slider carries a note saying what it covers', M.SLIDERS.every((s) => s.note.length > 20),
    M.SLIDERS.filter((s) => s.note.length <= 20).map((s) => s.key).join(', ') || `${M.SLIDERS.length} notes`);
  check('the RANKING carries the limit, in the words the owner set', /this model’s inputs under these assumptions/i.test(page)
    && /not a claim about your business/i.test(page),
    'a ranking arrives sorted, which is the shape of a finding — it reads as analysis in a way a slider does not');
  /**
   * ── AND THE NUMBER SAYS WHAT IT IS, NOT JUST THE HEADER ───────────────────────────────────────
   * The swings sat right-aligned in the same column as nine slider VALUES, formatted identically —
   * £2,000 of swing beside £800 of parts. The owner read his own feature as a mismatch. A sorted
   * list under a heading is not enough: the FIGURE has to carry it, because a reader who takes in
   * only the label and the number must still know it is not money spent.
   */
  check('the swing column is TITLED', /data-testid="sensitivity-heading"/.test(page) && /Moves contribution by/.test(page));
  check('  …every figure is prefixed ± and carries the word "swing"', /±\{money\(x\.swingPence\)\}/.test(page) && /swing<\/span>/.test(page),
    'a bare right-aligned amount in a column of amounts reads as an amount');
  check('  …and the page says outright they are not costs', /data-testid="sensitivity-not-cost"/.test(page)
    && /These are not costs/.test(page) && /lowest and its highest/.test(page));
  check('  …while the summary teaches it in words for the top one', /dragging it across its range moves contribution by/.test(page),
    'the one figure most likely to be read alone');
  check('  …and the limit is beside the ranking, not in a footer', page.indexOf('sensitivity-limit') < page.indexOf('sensitivity-list'));
  check('no figure from the garage\'s own accounts reaches this page', !/monthlyWageBill|costsInWindow|charged-labour|getAvailableHours/.test(page),
    'every number on it was typed or dragged by the person looking at it');

  /**
   * ── AND THE PAGE ACTUALLY RENDERS ─────────────────────────────────────────────────────────────
   * Every clause above reads the page's SOURCE. On 2026-09-12 all of them passed while the file had
   * an unbalanced </section> and could not compile — a scan of text cannot tell a working page from
   * a broken one, and `tsc` was the only thing that knew. So the page is FETCHED, and its key parts
   * are identified by data-testid rather than by rendered words (SSR HTML carries __NEXT_DATA__, so
   * a text match there is a false positive waiting to happen).
   */
  console.log('\n— and the page renders, which no source scan can tell you —');
  const jar2 = new Map();
  const keep2 = (r) => { for (const c of r.headers.getSetCookie?.() ?? []) { const kv = c.split(';')[0]; const i = kv.indexOf('='); jar2.set(kv.slice(0, i), kv.slice(i + 1)); } };
  const cookies2 = () => [...jar2].map(([k, v]) => `${k}=${v}`).join('; ');
  const csrf2 = await fetch(`${gateOrigin()}/api/auth/csrf`); keep2(csrf2);
  keep2(await fetch(`${gateOrigin()}/api/auth/callback/credentials`, {
    method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', cookie: cookies2() },
    body: new URLSearchParams({ email: 'owner@zzgategarage.test', password: 'GateGarage!2026', csrfToken: (await csrf2.json()).csrfToken, json: 'true' }),
  }));
  const pageRes = await fetch(`${gateOrigin()}/admin/purchase`, { headers: { cookie: cookies2() }, cache: 'no-store' });
  const html = await pageRes.text();
  check('the page answers 200 for a signed-in admin', pageRes.status === 200, `HTTP ${pageRes.status}`);
  for (const t of ['sliders', 'sensitivity-list', 'sensitivity-heading', 'sensitivity-not-cost', 'answer', 'out-cash',
    'contribution', 'contribution-means', 'input-autotrader', 'autotrader-note'])
    check(`  …and renders [${t}]`, html.includes(`data-testid="${t}"`), t);
  /**
   * Read the swing cells the way a PERSON reads them, not as a substring of the page. React's SSR
   * puts a <!-- --> separator between adjacent text nodes, so the served markup is `±<!-- -->£2,000`
   * and a /±£/ test fails on a page that is perfectly correct — which is exactly what it did when I
   * first wrote this clause. HTML has its own semantics; assert through something that honours them.
   */
  const cellText = (testid) => {
    const m = new RegExp(`data-testid="${testid}"[^>]*>([\\s\\S]*?)</span></li>`).exec(html);
    return m ? m[1].replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : null;
  };
  const swingIds = [...html.matchAll(/data-testid="(swing-[A-Za-z]+)"/g)].map((m) => m[1]);
  check('every swing cell in the SERVED page reads "±<amount> swing"', swingIds.length >= 3
    && swingIds.every((id) => /^±£[\d,]+(\.\d\d)? swing$/.test(cellText(id) ?? '')),
    `${swingIds.length} cells; first reads ${JSON.stringify(cellText(swingIds[0]))} — a reader who sees only the number and the label cannot take it for money spent`);

  /**
   * ── THE WORD, AND THE FIXED COST THAT IS NOT DIVIDED ──────────────────────────────────────────
   * The headline figure counts nothing the business pays whether the car exists or not, so it is a
   * CONTRIBUTION. It was labelled "Profit" in 24px bold, which is the same class of error as the
   * swing column: a word that invites the reading the number cannot support.
   *
   * And Autotrader broke the premise underneath the advertising slider. It is a MONTHLY CONTRACT —
   * about £1,500 for ten cars — so a per-car figure depends on turnover, which is partly what the
   * model exists to work out. The page therefore divides NOTHING: it asks the question the other way
   * round, which is answerable from one car.
   */
  console.log('\n— a contribution, and a contract that is never divided —');
  check('the headline is a CONTRIBUTION, not a profit', hasKey(page, 'label', "'Contribution'")
    && !/>Profit</.test(page) && !/'Profit'/.test(page),
    'banning the old word too: the next reader will reach for it for the same reason I did');
  check('  …and ONE expression feeds both places it is shown', (() => {
    // answer.label / answer.text are read by the sticky line and by the panel at the foot. Counting the
    // readers is what stops a later edit hardcoding the figure in one of them and letting them diverge.
    const reads = (page.match(/answer\.(label|text|negative)/g) ?? []).length;
    return /const answer = \{/.test(page) && reads >= 5;
  })(), 'two renderings of one number is a divergence waiting to happen');
  check('  …and the page says what that means', /data-testid="contribution-means"/.test(page)
    && /before your fixed monthly costs/.test(page) && /not profit/.test(page));
  /**
   * ── THE SPLIT IS BY PLATFORM, NOT BY COST SHAPE ───────────────────────────────────────────────
   * Autotrader has its own named monthly line because it is the industry standard and the one
   * advertising figure a dealer can recite. The slider is EVERYTHING ELSE, and its note names the
   * examples — "additional" means nothing until you know what it is additional to.
   */
  const adSlider = M.SLIDERS.find((x) => x.key === 'advertisingPence');
  check('the per-car slider is ADDITIONAL advertising', adSlider.label === 'Additional advertising',
    JSON.stringify(adSlider.label));
  check('  …and its note names the platforms it covers', ['eBay', 'Gumtree', 'Facebook Marketplace']
    .every((x) => adSlider.note.includes(x)) && /beyond the Autotrader subscription/.test(adSlider.note),
    JSON.stringify(adSlider.note));
  check('  …and no longer promises every platform', !/across every platform/.test(adSlider.note),
    'the dominant platform is a subscription, and this field cannot cover it');
  check('the monthly field is named for Autotrader, on the page', /data-testid="input-autotrader"/.test(page)
    && /Autotrader, per month/.test(page),
    'its own line rather than a generic "platform contracts", because that is the number a dealer knows');
  check('  …and its note says it is the subscription and is NOT divided into this car',
    /data-testid="autotrader-note"/.test(page) && /Your Autotrader subscription/.test(page)
    && /not<\/strong> divided into this car/.test(page),
    'the denominator is exactly what the page cannot know');
  check('  …and points at the slider for everything else', /Additional advertising<\/strong> slider/.test(page));
  check('the break-even sentence names the subscription', /Autotrader subscription\s*\n?\s*needs/.test(page)
    || /Autotrader subscription/.test(page),
    'what the sales have to cover is a named contract, not "advertising"');

  // AND THE KEY THAT EXISTED FOR A FEW HOURS IS STILL READ. `adContractMonthlyPence` was the field's
  // name before it became the named Autotrader line; a model saved in that window holds the figure under
  // the old key, and dropping the fallback would silently zero somebody's subscription. Asserted,
  // because I wrote that fallback and then removed it in a red-proof with NO clause noticing.
  check('a model saved under the OLD monthly key keeps its figure',
    S.normaliseInputs({ adContractMonthlyPence: 150000 }).autotraderMonthlyPence === 150000,
    '£1,500 typed before the rename still reads £1,500 after it');
  check('  …and the new key wins when both are present',
    S.normaliseInputs({ adContractMonthlyPence: 150000, autotraderMonthlyPence: 500000 }).autotraderMonthlyPence === 500000,
    'the fallback is a fallback, not an override');

  /** THE RANKING ROW FOLLOWS THE SLIDER, because both read SLIDERS — asserted, not assumed. */
  const rankedLabels = M.sensitivity(M.defaultInputs()).map((x) => x.label);
  check('the ranking row reads "Additional advertising"', rankedLabels.includes('Additional advertising'),
    JSON.stringify(rankedLabels.filter((l) => /advertis/i.test(l))));
  check('  …and the subscription is NOT a row in it', !rankedLabels.some((l) => /Autotrader/i.test(l)),
    'a fixed monthly cost has no range to swing across');

  // THE ARITHMETIC OF THE REFUSAL, as a pure function, with each case named.
  check('sales-to-cover divides the contract by the contribution', M.salesToCoverMonthly(50000, 150000) === 3,
    '£1,500 a month over £500 a car = 3 sales');
  check('  …and ROUNDS UP, because a part-sale covers nothing', M.salesToCoverMonthly(40000, 150000) === 4,
    '3.75 → 4');
  check('  …no contract, no sentence', M.salesToCoverMonthly(50000, 0) === null);
  check('  …and a contribution of zero or less has NO answer, not infinity', M.salesToCoverMonthly(0, 150000) === null
    && M.salesToCoverMonthly(-1, 150000) === null,
    'no quantity of a car that loses money covers a fixed cost — a rounded-up division would print a confident figure for an impossible question');

  // AND IT IS NOT A COST. The whole point: it must change no figure in the breakdown.
  const noAd = M.computeModel({ ...M.defaultInputs(), autotraderMonthlyPence: 0 });
  const bigAd = M.computeModel({ ...M.defaultInputs(), autotraderMonthlyPence: 500000 });
  check('the monthly contract changes NOTHING in the per-car answer', noAd.contributionPence === bigAd.contributionPence
    && noAd.totalCostsPence === bigAd.totalCostsPence && noAd.otherCostsPence === bigAd.otherCostsPence,
    `£0 and £5,000/month both give ${noAd.contributionPence}p — the moment it enters a cost, the page is dividing a fixed cost by a turnover it does not know`);
  check('  …and it is not in the ranking either', !M.sensitivity(M.defaultInputs()).some((x) => x.key === 'autotraderMonthlyPence'),
    'the ranking swings sliders across their range; a monthly contract is not one of them');

  /**
   * ── WHERE IT CAME FROM, AND WHAT A FEE DOES ABOUT IT ──────────────────────────────────────────
   * On a margin car an auction's buyer fee is invoiced as part of the price of the GOODS, so it raises
   * the figure the margin is measured from: a £300 fee costs £250, because the margin falls £300 and
   * the VAT on it £50. The same £300 from a dealer is a separate standard-rated service — a flat cost
   * that never touches the margin. Same money typed, two answers £50 apart.
   */
  console.log('\n— two fees on one invoice, and they are different mechanisms —');

  /**
   * ── THE WORKED INVOICE (owner, from a real Manheim invoice) ────────────────────────────────────
   * hammer £1,250.00 · premium £265.20 · indemnities £68.00 net + £13.60 VAT
   *   → margin base £1,515.20 · reclaimable input VAT £13.60 · cash out £1,596.80
   *
   * Asserted as EXACT pennies. These are not derived figures with a rounding question — they are the
   * numbers printed on the invoice, and a tolerance here would be a tolerance on arithmetic that has
   * only one right answer.
   */
  const HAMMER = 125000, PREMIUM = 26520, INDEMNITIES = 6800, INDEMNITY_VAT = 1360;
  const invoiceCase = {
    ...M.defaultInputs(), source: 'auction', vatStatus: 'margin',
    purchasePence: HAMMER, salePence: 200000, premiumPence: PREMIUM, servicesPence: INDEMNITIES,
    prepHours: 0, partsPence: 0, advertisingPence: 0, warrantyPence: 0,
    deliveryInPence: 0, deliveryOutPence: 0, daysInStock: 0,
  };
  const fees = M.feePosition('auction', { premiumPence: PREMIUM, servicesPence: INDEMNITIES }, true);
  check('the premium goes INTO the margin base', fees.inMarginBasePence === PREMIUM,
    `${fees.inMarginBasePence}p — VAT is inside it (VAT Notice 718/1), so it is part of the price of the goods`);
  check('  …so the margin base is £1,515.20', HAMMER + fees.inMarginBasePence === 151520,
    `${HAMMER + fees.inMarginBasePence}p = hammer £1,250.00 + premium £265.20`);
  check('  …and NOTHING is reclaimable from the premium', (() => {
    const premiumOnly = M.feePosition('auction', { premiumPence: PREMIUM, servicesPence: 0 }, true);
    return premiumOnly.reclaimablePence === 0;
  })(), 'its VAT is already inside the figure; recovering it as well would be counting it twice');
  check('  …and no VAT is ADDED to it either', (() => {
    const premiumOnly = M.feePosition('auction', { premiumPence: PREMIUM, servicesPence: 0 }, true);
    return premiumOnly.cashOutPence === PREMIUM;
  })(), 'typed exactly as the invoice prints it — £265.20 leaves the bank, not £318.24');

  check('the indemnities are standard rated, VAT worked out', fees.servicesVatPence === INDEMNITY_VAT,
    `£68.00 net → ${fees.servicesVatPence}p VAT, and the invoice shows £13.60`);
  check('  …reclaimable input VAT is £13.60', fees.reclaimablePence === INDEMNITY_VAT, `${fees.reclaimablePence}p`);
  check('  …and they are NOT in the margin base', (() => {
    const servicesOnly = M.feePosition('auction', { premiumPence: 0, servicesPence: INDEMNITIES }, true);
    return servicesOnly.inMarginBasePence === 0;
  })(), 'a separate service, so the margin never sees it');

  const whole = M.computeModel(invoiceCase, { vatRegistered: true });
  check('cash out is £1,596.80', whole.vat.cashOutPence + whole.fee.cashOutPence === 159680,
    `${whole.vat.cashOutPence + whole.fee.cashOutPence}p = £1,250.00 + £265.20 + £68.00 + £13.60`);
  check('  …and the VAT on the sale is worked out from the £1,515.20 base', (() => {
    // margin = 2000.00 − 1515.20 = 484.80; VAT at 1/6 = 80.80
    const noPremium = M.computeModel({ ...invoiceCase, premiumPence: 0 }, { vatRegistered: true });
    return Math.abs(whole.vat.outputVatPence - 8080) <= 1 && noPremium.vat.outputVatPence > whole.vat.outputVatPence;
  })(), `${whole.vat.outputVatPence}p on a £484.80 margin — and it is LOWER than without the premium, which is the whole mechanism`);

  /**
   * THE INVARIANT, NOW ACROSS TWO FEE TYPES AND EVERY SOURCE: in the margin base OR reclaimable, never
   * both and NEVER NEITHER. Tested with the garage REGISTERED, because that is the case in which both
   * routes are open — an unregistered garage reclaims nothing, and a missing route would hide behind it.
   */
  for (const src of M.SOURCES) {
    for (const f of M.SOURCE_RULES[src].fees) {
      const only = M.feePosition(src, { premiumPence: f.slot === 'premium' ? 10000 : 0, servicesPence: f.slot === 'services' ? 10000 : 0 }, true);
      const inBase = only.inMarginBasePence > 0, reclaim = only.reclaimablePence > 0;
      check(`  …${src}/${f.slot} (${f.label}): exactly one relief route`, inBase !== reclaim,
        `in margin base: ${inBase}, reclaimable: ${reclaim} — both is double counting, neither is a fee quietly costing more than it should`);
    }
  }
  check('a private sale and a part-exchange carry NO fee at all',
    M.feePosition('private', { premiumPence: 30000, servicesPence: 30000 }, true).cashOutPence === 0
    && M.feePosition('part_exchange', { premiumPence: 30000, servicesPence: 30000 }, true).cashOutPence === 0,
    'a typed figure on an invoice that cannot carry it is a stale field, not a cost');
  check('a dealer invoice carries the SERVICE fee and no premium',
    M.hasFeeSlot('trade', 'services') === true && M.hasFeeSlot('trade', 'premium') === false,
    'an admin fee is mechanically an indemnity; there is no premium on a trade invoice');
  check('an unregistered garage reclaims nothing and carries the VAT as cost', (() => {
    const u = M.feePosition('trade', { premiumPence: 0, servicesPence: 30000 }, false);
    return u.reclaimablePence === 0 && u.netCostPence === 36000;
  })(), '£300 + VAT is a £360 cost when there is nothing to reclaim it against');

  /** THE LABELS ARE THE INVOICE'S OWN WORDS, because that is what the garage is reading while they type. */
  const auctionFees = M.SOURCE_RULES.auction.fees.map((f) => f.label);
  check('the auction labels are "Buyer’s premium" and "Indemnities"',
    auctionFees.some((l) => /Buyer’s premium/.test(l)) && auctionFees.some((l) => /Indemnities/.test(l)),
    JSON.stringify(auctionFees));
  check('  …and the premium’s note says the VAT is inside it',
    /VAT is inside this figure and not shown separately/.test(M.SOURCE_RULES.auction.fees[0].note));
  check('  …and the indemnities’ note asks for the NET figure',
    /Type the NET figure/.test(M.SOURCE_RULES.auction.fees[1].note));

  /**
   * AND THE ONE-FIELD MODELS STILL READ THE SAME. `buyerFeePence` MEANT different things by source, so it
   * migrates to the slot that source already applied it to. Mapping it to one slot for both would have
   * changed every stored auction model by 20% of the fee, silently.
   */
  const legacyAuction = S.normaliseInputs({ source: 'auction', buyerFeePence: 26520, purchasePence: HAMMER, salePence: 200000 });
  const legacyTrade = S.normaliseInputs({ source: 'trade', buyerFeePence: 30000, purchasePence: HAMMER, salePence: 200000 });
  check('an old AUCTION fee becomes the premium', legacyAuction.premiumPence === 26520 && legacyAuction.servicesPence === 0,
    'the old rules folded it into the margin base with its VAT inside — that is a premium');
  check('  …and an old TRADE fee becomes the service', legacyTrade.servicesPence === 30000 && legacyTrade.premiumPence === 0,
    'the old rules treated it as a net standard-rated service');
  check('  …and neither is counted twice', legacyAuction.premiumPence + legacyAuction.servicesPence === 26520
    && legacyTrade.premiumPence + legacyTrade.servicesPence === 30000);

  /**
   * ── THE WRONG ANSWER THAT WAS TWO CLICKS AWAY ─────────────────────────────────────────────────
   * A car bought privately cannot be VAT qualifying — there is no VAT invoice to reclaim against — and
   * the toggle was free. The rule is enforced in the WRITER, not only in the form: a hidden control is
   * not a rule, and a model saved before the source question existed comes back through the same door.
   */
  check('private and part-exchange can only be margin', M.availableVatStatuses('private').join() === 'margin'
    && M.availableVatStatuses('part_exchange').join() === 'margin');
  check('  …while auction and trade can be either', M.availableVatStatuses('auction').length === 2
    && M.availableVatStatuses('trade').length === 2);
  const forced = S.normaliseInputs({ source: 'private', vatStatus: 'qualifying', premiumPence: 30000, servicesPence: 30000 });
  check('the WRITER refuses an impossible pair, not just the form', forced.vatStatus === 'margin',
    'posted source=private + vatStatus=qualifying, stored as margin — this is what a hand-made POST meets');
  check('  …and drops fees the source cannot charge', forced.premiumPence === 0 && forced.servicesPence === 0,
    `premium ${forced.premiumPence}p, services ${forced.servicesPence}p`);
  check('  …and an unknown source falls back rather than throwing', S.normaliseInputs({ source: 'ebay' }).source === 'auction',
    'normalising a document, not validating a form');

  /**
   * AND NOTHING MOVED FOR A MODEL WITHOUT A FEE. The margin base defaults to the purchase price, so
   * every answer that predates the source question is identical — asserted rather than assumed,
   * because "it defaults to the old behaviour" is the claim most often made and least often checked.
   */
  const legacy = { ...M.defaultInputs(), premiumPence: 0, servicesPence: 0 };
  const viaDefault = M.vatPosition(800000, 1000000, 'margin', false);
  const viaBase = M.vatPosition(800000, 1000000, 'margin', false, 800000);
  check('vatPosition with no margin base given == the base being the purchase price',
    JSON.stringify(viaDefault) === JSON.stringify(viaBase), 'the new parameter changes nothing when nobody passes it');
  check('  …and fees of zero leave the whole answer untouched',
    M.computeModel(legacy).contributionPence === M.computeModel({ ...legacy, source: 'trade' }).contributionPence
    && M.computeModel(legacy).contributionPence === M.computeModel({ ...legacy, source: 'private' }).contributionPence,
    'the source alone moves no money; only a fee does');

  /**
   * ── THREE SHAPES, AND ONLY TWO OF THEM ARE INTEREST ───────────────────────────────────────────
   * A facility CURTAILS: it takes a slice of the advance back every month whether or not the car has
   * sold. That is a repayment schedule, and an annual percentage gets both halves wrong — the interest,
   * because the balance declines, and the cash, because money must be found before the sale.
   */
  console.log('\n— the funding plan, and the cash it wants before the sale —');
  const fundArgs = { amountPence: 800000, daysInStock: 90, annualPct: 9 };
  const cash = M.fundingCost({ kind: 'cash' }, fundArgs);
  const od = M.fundingCost({ kind: 'overdraft', arrangementFeePence: 15000 }, fundArgs);
  const fac = M.fundingCost({ kind: 'facility', advancePct: 100, monthlyPctOfAdvance: 1.5,
    curtailPctPerMonth: 10, graceDays: 0, perUnitFeePence: 3000, termDays: 120 }, fundArgs);

  check('cash is simple interest over the days held', Math.abs(cash.interestPence - Math.round(800000 * 0.09 * (90 / 365))) <= 1,
    `${cash.interestPence}p on £8,000 at 9% for 90 days`);
  check('  …and demands nothing before the sale', cash.cashBeforeSalePence === 0 && cash.schedule.length === 0);
  check('an overdraft is the same interest plus its fee', od.interestPence === cash.interestPence
    && od.feesPence === 15000 && od.totalPence === cash.interestPence + 15000,
    'a rate and a flat charge — the same SHAPE as cash, which is why they share the slider');
  check('  …and also demands nothing before the sale', od.cashBeforeSalePence === 0,
    'the balance is flat until the car sells; nothing is called in');

  /**
   * THE NUMBER NO ANNUAL PERCENTAGE CAN EXPRESS. At 10% of the advance a month over ninety days, three
   * curtailments fall due before any buyer appears — 30% of an £8,000 car, £2,400, out of the bank.
   */
  check('a facility demands CASH BEFORE THE SALE', fac.cashBeforeSalePence > 0 && fac.schedule.length === 3,
    `${fac.cashBeforeSalePence}p across ${fac.schedule.length} payments at days ${fac.schedule.map((x) => x.day).join(', ')}`);
  check('  …and it is the curtailments, not the interest', (() => {
    const principal = fac.schedule.reduce((a, x) => a + x.principalPence, 0);
    return principal === 240000 && fac.cashBeforeSalePence > principal;   // 3 × 10% of £8,000
  })(), '£2,400 of principal over 90 days — 30% of the car, before a buyer appears');
  check('  …charged on a DECLINING balance, so it is not 3 × the first month', (() => {
    const charges = fac.schedule.map((x) => x.chargePence);
    return charges[0] > charges[1] && charges[1] > charges[2];
  })(), `${fac.schedule.map((x) => x.chargePence).join('p, ')}p — each month is charged on what is left`);
  check('  …and a grace period moves the first payment out', (() => {
    const g = M.fundingCost({ kind: 'facility', advancePct: 100, monthlyPctOfAdvance: 1.5, curtailPctPerMonth: 10,
      graceDays: 60, perUnitFeePence: 0, termDays: 0 }, fundArgs);
    return g.schedule.length === 1 && g.schedule[0].day === 90;
  })(), '60 days of grace over a 90-day hold leaves one payment, not three');

  /** OVER TERM IS A REFUSAL, NOT A COST — and an unstated term is not a satisfied one. */
  // BOTH DIRECTIONS. 90 days inside a 120-day term must NOT be flagged — a guard that fires on a hold
  // the agreement allows would teach the reader to ignore it.
  check('a hold INSIDE the term is not flagged', fac.overTerm === false, '90 days held against a 120-day term');
  check('  …and 150 days on that same term IS', M.fundingCost({ kind: 'facility', advancePct: 100, monthlyPctOfAdvance: 1,
    curtailPctPerMonth: 10, graceDays: 0, perUnitFeePence: 0, termDays: 120 }, { ...fundArgs, daysInStock: 150 }).overTerm === true,
    'the balance falls due before the car sells — a plan that does not work, not a cost to add');
  check('  …and an UNSTATED term answers null, never false', M.fundingCost({ kind: 'facility', advancePct: 100,
    monthlyPctOfAdvance: 1, curtailPctPerMonth: 10, graceDays: 0, perUnitFeePence: 0, termDays: 0 }, fundArgs).overTerm === null,
    'an unknown term is not a satisfied one — three states, not a boolean');

  /** NOBODY'S RATE CARD SHIPS AS A DEFAULT. */
  const blank = M.blankFacility();
  check('a blank facility claims nothing', M.fundingCost(blank, fundArgs).totalPence === 0
    && M.fundingCost(blank, fundArgs).cashBeforeSalePence === 0,
    'every field zero until the garage reads their own agreement');
  check('  …and no facility figure is a default anywhere', Object.entries(blank).every(([k, v]) => k === 'kind' || v === 0),
    JSON.stringify(blank) + ' — "roughly 10% a month" describes one product, and a default is the strongest claim an interface can make');
  check('  …and the page says to read the agreement', /data-testid="facility-read-your-agreement"/.test(page)
    && /read it rather than guessing/.test(page));

  /**
   * ── A STORED MODEL'S ANSWER CANNOT MOVE ───────────────────────────────────────────────────────
   * Every model saved before this slice has no `funding` key. Asserted by normalising a document with
   * no plan in it and comparing the WHOLE result against the arithmetic that shipped — not by reasoning
   * that the cash branch looks the same.
   */
  const legacyDoc = { purchasePence: 800000, salePence: 1000000, vatStatus: 'margin', daysInStock: 45, costOfMoneyAnnualPct: 9 };
  const reread = S.normaliseInputs(legacyDoc);
  check('a saved model with NO funding key reads back as cash', reread.funding.kind === 'cash',
    JSON.stringify(reread.funding));
  check('  …and its cost of money is the simple-interest line that shipped', (() => {
    const got = M.computeModel(reread).stockingCostPence;
    const shipped = Math.round(M.computeModel(reread).vat.cashOutPence * (9 / 100) * (45 / 365));
    return got === shipped;
  })(), 'the figure is recomputed here from the old formula and compared, so "it defaults to the old behaviour" is checked rather than claimed');
  check('  …and an unrecognised plan is cash too, not a crash', S.normaliseInputs({ ...legacyDoc, funding: { kind: 'crypto' } }).funding.kind === 'cash',
    'normalising a document, not validating a form');
  check('  …and a facility\'s missing numbers are zero, never invented', (() => {
    const f = S.normaliseInputs({ ...legacyDoc, funding: { kind: 'facility' } }).funding;
    return f.kind === 'facility' && f.advancePct === 0 && f.curtailPctPerMonth === 0 && f.termDays === 0;
  })());

  /** THE RANKING STAYS ON THE SLIDERS, AND SAYS SO. */
  check('the funding plan is not in the ranking', !M.sensitivity(M.defaultInputs()).some((x) => String(x.key).includes('funding')),
    'a plan is a choice between shapes, not a number with a range — it cannot be swung');
  check('  …and the page says that outright, beside the list', /data-testid="sensitivity-scope"/.test(page)
    && /ranks the sliders only/.test(page) && /not a range/.test(page),
    'a ranking that silently omitted the biggest lever would be the same lie as a swing read as a cost');
  check('  …so it is compared instead', /data-testid="funding-compare"/.test(page)
    && /data-testid={`compare-\${c.kind}`}/.test(page));

  /**
   * ── EVERY BROWSER CLAUSE RUNS LAST, AND THAT IS DELIBERATE ────────────────────────────────────
   * A waitForSelector that times out THROWS, and the catch ends the run — so every clause after it is
   * never reached and reports nothing. On 2026-09-13 a mutation letting a private purchase be VAT
   * qualifying was red-proved and produced ONE failure: "run completed — Timeout". The pure clause
   * written to name that exact defect sat below the browser leg and never ran; 78 of 121 clauses
   * executed and the gate said nothing about why.
   *
   * So the cheap, pure, always-available assertions come first, and anything driving a real browser
   * comes last. A gate that dies tells you nothing about the clauses it never reached.
   */
  /**
   * ── THE BREAK-EVEN SENTENCE, DRIVEN ───────────────────────────────────────────────────────────
   * It only exists once a contract is typed, and the contract lives in React state — so the served
   * HTML with default inputs cannot show it and a source scan would be the only other option. That
   * is precisely the trap this gate fell into a day earlier: 71 of 71 green on a page serving a 500.
   * So it is typed into the real control, in a real browser, and the sentence is read off the screen.
   */
  console.log('\n— typed into the real control, read off the real screen —');
  const ready = await serverReady();
  check('the dev server serves pages before we drive it', ready.ok, `HTTP ${ready.status} after ${ready.attempts} attempt(s)`);
  browser = await chromium.launch({ channel: 'chrome' });
  const bpage = await (await browser.newContext()).newPage();
  await bpage.goto(`${gateOrigin()}/admin/login`, { waitUntil: 'domcontentloaded' });
  await bpage.fill('input[type="email"]', 'owner@zzgategarage.test');
  await bpage.fill('input[type="password"]', 'GateGarage!2026');
  await Promise.all([bpage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }), bpage.click('button[type="submit"]')]);
  await bpage.goto(`${gateOrigin()}/admin/purchase`, { waitUntil: 'domcontentloaded' });
  await bpage.waitForSelector('[data-testid="input-autotrader"]', { timeout: 25000 });

  // NOTHING TYPED, NOTHING CLAIMED. The default is blank, so there is no sentence to misread.
  check('with no contract typed there is no break-even sentence',
    (await bpage.locator('[data-testid="break-even"]').count()) === 0
    && (await bpage.locator('[data-testid="break-even-impossible"]').count()) === 0,
    'blank by default — £1,500 is one dealer\'s quote, not a typical figure');

  // £1,500 a month against the default car. WAIT ON THE CONDITION (the sentence appearing), never a sleep.
  await bpage.fill('[data-testid="input-autotrader"]', '1500');
  await bpage.waitForSelector('[data-testid="break-even"]', { timeout: 15000 });
  const sentence = ((await bpage.locator('[data-testid="break-even"]').textContent()) ?? '').replace(/\s+/g, ' ').trim();
  // THE NUMBER IS DERIVED HERE TOO, from the same pure function against the shown contribution — so the
  // clause compares the screen with the rule, not with a constant I typed and would have to maintain.
  const shown = ((await bpage.locator('[data-testid="contribution"]').textContent()) ?? '').replace(/[£,\s]/g, '');
  const expect = M.salesToCoverMonthly(Math.round(Number(shown) * 100), 150000);
  check('the sentence says how many sales cover the contract', /needs \d+ sales? a month/.test(sentence) && sentence.includes('£1,500'),
    JSON.stringify(sentence));
  check(`  …and the figure is the rule's own answer (${expect})`, new RegExp(`\\b${expect}\\b`).test(sentence),
    `contribution on screen ${shown}, so ${expect} — compared against the function, not against a number I hardcoded`);

  /**
   * ── THE TWO CLICKS, DRIVEN ────────────────────────────────────────────────────────────────────
   * "Private" plus "VAT qualifying" gave a £1,667 answer that cannot happen, and it was two taps away.
   * The writer refuses the pair (asserted above, as a pure function); this asserts the SCREEN never
   * offers it — which is a different claim, and the one a person actually meets.
   */
  /**
   * ── THE ANSWER IS VISIBLE WHILE A SLIDER MOVES ────────────────────────────────────────────────
   * Measured before it was built: on desktop the panel is `sm:static` and sat 2020px down a 2906px page,
   * 1220px below the fold with a slider under the cursor. The sticky line at the top is the fix, and this
   * drives it the way a person does — scroll to a slider, move it, and look at the top of the screen.
   */
  await bpage.locator('[data-testid="slider-partsPence"]').scrollIntoViewIfNeeded();
  const glance = async () => bpage.evaluate(() => {
    const el = document.querySelector('[data-testid="answer-top"]');
    const r = el?.getBoundingClientRect();
    // NON-ZERO SIZE, THEN POSITION. `top >= 0 && bottom <= innerHeight` is TRUE of a display:none
    // element — its rect is 0×0 at the origin — so the first version of this clause passed with the
    // sticky bar deleted. A visibility check that an invisible element satisfies is not a check.
    const painted = !!r && r.width > 0 && r.height > 0 && !!el.offsetParent;
    return { inViewport: painted && r.top >= 0 && r.bottom <= window.innerHeight,
      text: document.querySelector('[data-testid="contribution-top"]')?.textContent?.trim() ?? null,
      bottom: document.querySelector('[data-testid="contribution"]')?.textContent?.trim() ?? null };
  });
  const atSlider = await glance();
  check('with a slider on screen, the answer is too', atSlider.inViewport === true,
    `contribution reads ${atSlider.text} at the top while the sliders are under the cursor`);
  check('  …and it is the same figure as the panel at the foot', atSlider.text === atSlider.bottom && !!atSlider.text,
    `top ${atSlider.text} · bottom ${atSlider.bottom} — two renderings of one number, from one expression`);
  check('  …and it says CONTRIBUTION, not profit', /Contribution/.test((await bpage.locator('[data-testid="answer-top"]').textContent()) ?? ''),
    'the agreed word, in both places');

  // MOVE A SLIDER AND WATCH THE TOP CHANGE. This is the thing the tool is for.
  await bpage.locator('[data-testid="slider-partsPence"]').focus();
  await bpage.locator('[data-testid="slider-partsPence"]').press('End');
  await bpage.waitForFunction((was) => document.querySelector('[data-testid="contribution-top"]')?.textContent?.trim() !== was,
    atSlider.text, { timeout: 15000 });
  const moved = await glance();
  check('dragging a slider changes the figure at the top, while it is still on screen',
    moved.text !== atSlider.text && moved.inViewport === true && moved.text === moved.bottom,
    `${atSlider.text} → ${moved.text}`);

  /**
   * ── AND NOTHING HIDES BEHIND THE PANEL ON A PHONE ─────────────────────────────────────────────
   * The fixed panel measures 214px on a 360x640 screen and the page reserved 160px (pb-40), so the foot
   * of it sat underneath — including "Save this model", which a person could see and not reach. Measured
   * at the real viewport, against the real panel edge, because the numbers are the whole finding.
   */
  await bpage.setViewportSize({ width: 360, height: 640 });
  await bpage.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const foot = await bpage.evaluate(() => {
    const panel = document.querySelector('[data-testid="answer"]').getBoundingClientRect();
    const focusable = [...document.querySelectorAll('button, input, a[href]')]
      .filter((el) => el.getBoundingClientRect().height > 0 && !el.closest('[data-testid="answer"]'));
    const last = focusable[focusable.length - 1];
    const lr = last.getBoundingClientRect();
    return { label: (last.textContent || last.tagName).trim().slice(0, 24),
      clearPx: Math.round(panel.top - lr.bottom), reachable: lr.bottom <= panel.top,
      panelPosition: getComputedStyle(document.querySelector('[data-testid="answer"]')).position };
  });
  check('at the foot of a 360x640 phone, nothing is behind the answer panel', foot.reachable === true,
    `"${foot.label}" clears the panel by ${foot.clearPx}px`);
  // AND THE REASON IT CANNOT RECUR: there is no fixed overlay to hide behind. A clearance expressed as a
  // fixed padding was wrong in principle — the panel's height changes with state (a stocking facility adds
  // two lines), so pb-56 passed at rest and failed by 13px with a facility chosen.
  check('  …because the panel is in the FLOW, not an overlay', foot.panelPosition === 'static',
    `position: ${foot.panelPosition} — a constant cannot reserve space for a panel whose height varies`);
  await bpage.setViewportSize({ width: 1280, height: 800 });

  /**
   * ── TWO FEE FIELDS, THE INVOICE'S OWN WORDS ───────────────────────────────────────────────────
   */
  await bpage.click('[data-testid="source-auction"]');
  await bpage.waitForSelector('[data-testid="input-premium"]', { timeout: 15000 });
  check('an auction invoice asks for the premium AND the indemnities separately',
    (await bpage.locator('[data-testid="input-premium"]').count()) === 1
    && (await bpage.locator('[data-testid="input-services"]').count()) === 1);
  check('  …under the words the invoice uses',
    /Buyer’s premium/.test((await bpage.locator('[data-testid="fee-field-premium"]').textContent()) ?? '')
    && /Indemnities/.test((await bpage.locator('[data-testid="fee-field-services"]').textContent()) ?? ''));

  // THE REAL INVOICE, TYPED IN: £1,250 hammer, £265.20 premium, £68 indemnities.
  await bpage.fill('[data-testid="input-purchase"]', '1250');
  await bpage.fill('[data-testid="input-premium"]', '265.20');
  await bpage.fill('[data-testid="input-services"]', '68');
  await bpage.waitForSelector('[data-testid="fee-effect-premium"]', { timeout: 15000 });
  const prem = ((await bpage.locator('[data-testid="fee-effect-premium"]').textContent()) ?? '').replace(/\s+/g, ' ').trim();
  const serv = ((await bpage.locator('[data-testid="fee-effect-services"]').textContent()) ?? '').replace(/\s+/g, ' ').trim();
  check('the page states the margin base as £1,515.20', prem.includes('£1,515.20'), JSON.stringify(prem));
  check('  …and says the premium’s VAT is already inside it', /nothing to reclaim/.test(prem));
  check('  …and states the indemnities’ VAT separately, at £13.60', serv.includes('£13.60'), JSON.stringify(serv));
  check('  …and says it is not in the margin', /none of it in your margin/.test(serv));

  /** A PRIVATE SALE ASKS FOR NEITHER, and still cannot be VAT qualifying. */
  await bpage.click('[data-testid="source-private"]');
  await bpage.waitForSelector('[data-testid="vat-forced"]', { timeout: 15000 });
  check('a private purchase does not OFFER VAT qualifying',
    (await bpage.locator('[data-testid="vat-qualifying"]').count()) === 0
    && (await bpage.locator('[data-testid="vat-margin"]').count()) === 1,
    'filtered, not disabled — a greyed control invites "why not?", and the source note answers it already');
  check('  …and asks for neither fee', (await bpage.locator('[data-testid="input-premium"]').count()) === 0
    && (await bpage.locator('[data-testid="input-services"]').count()) === 0,
    'absent rather than zeroed: an empty box invites a number that means nothing');
  await bpage.click('[data-testid="source-trade"]');
  await bpage.waitForSelector('[data-testid="input-services"]', { timeout: 15000 });
  check('a dealer invoice asks for the admin fee only, under its own label',
    (await bpage.locator('[data-testid="input-premium"]').count()) === 0
    && /Admin or delivery fee/.test((await bpage.locator('[data-testid="fee-field-services"]').textContent()) ?? ''));

  /**
   * ── THE FACILITY, TYPED IN AND READ BACK ──────────────────────────────────────────────────────
   * The terms live in React state and the refusal depends on them, so neither can be seen in served
   * HTML. Typed into the real fields, read off the real screen.
   */
  await bpage.click('[data-testid="funding-facility"]');
  await bpage.waitForSelector('[data-testid="facility-terms"]', { timeout: 15000 });
  check('choosing a facility asks for the agreement’s own terms, filled in with nothing',
    /read it rather than guessing/.test((await bpage.locator('[data-testid="facility-read-your-agreement"]').textContent()) ?? '')
    && (await bpage.locator('[data-testid="input-facility-curtailPctPerMonth"]').inputValue()) === '',
    'blank, because a default is the strongest claim an interface can make');
  // AND AN EMPTY FACILITY SAYS NOTHING — no cash demanded, no refusal, no invented rate.
  check('  …and claims nothing until it is filled in',
    (await bpage.locator('[data-testid="cash-before-sale"]').count()) === 0
    && (await bpage.locator('[data-testid="over-term"]').count()) === 0);

  // THE OWNER'S OWN EXAMPLE: 100% advance, 10% a month, no grace, 120-day term — on a 45-day hold.
  for (const [field, value] of [['advancePct', '100'], ['monthlyPctOfAdvance', '1.5'],
    ['curtailPctPerMonth', '10'], ['termDays', '120']]) {
    await bpage.fill(`[data-testid="input-facility-${field}"]`, value);
  }
  await bpage.waitForSelector('[data-testid="cash-before-sale"]', { timeout: 15000 });
  const before = ((await bpage.locator('[data-testid="cash-before-sale"]').textContent()) ?? '').replace(/\s+/g, ' ').trim();
  check('the page states the cash wanted back BEFORE the sale', /must be repaid before the car sells/.test(before)
    && /£/.test(before), JSON.stringify(before));

  // OVER TERM: hold it longer than the agreement allows and the page refuses rather than charging more.
  /**
   * A REAL KEYPRESS ON THE SLIDER. Setting `el.value` — even through HTMLInputElement's native setter,
   * the usual workaround — moves the DOM and leaves React's state at 45: measured, not assumed. The
   * control is focused and End is pressed, which is both reliable and something a person can actually
   * do. 180 days is the slider's own maximum, comfortably past the 120-day term.
   */
  await bpage.locator('[data-testid="slider-daysInStock"]').focus();
  await bpage.locator('[data-testid="slider-daysInStock"]').press('End');
  await bpage.waitForSelector('[data-testid="over-term"]', { timeout: 15000 });
  const overTerm = ((await bpage.locator('[data-testid="over-term"]').textContent()) ?? '').replace(/\s+/g, ' ').trim();
  check('holding it past the term is a REFUSAL, not a bigger number', /not a cost to add/.test(overTerm)
    && /balance falls due before the car sells/.test(overTerm), JSON.stringify(overTerm));

  // THE THREE-WAY COMPARISON, on the same car, with the chosen plan marked.
  const rows = await Promise.all(['cash', 'overdraft', 'facility'].map(async (k) => ({
    k, cost: ((await bpage.locator(`[data-testid="compare-cost-${k}"]`).textContent()) ?? '').trim(),
    first: ((await bpage.locator(`[data-testid="compare-before-${k}"]`).textContent()) ?? '').trim(),
  })));
  check('all three plans are shown on the same car', rows.every((x) => x.cost.startsWith('£')),
    rows.map((x) => `${x.k} ${x.cost}/${x.first}`).join(' · '));
  check('  …and only the facility wants anything back first', rows.find((x) => x.k === 'cash').first === '—'
    && rows.find((x) => x.k === 'overdraft').first === '—'
    && rows.find((x) => x.k === 'facility').first !== '—',
    'the two questions are different: what the money COSTS, and what it DEMANDS before the car sells');

  // AND THE IMPOSSIBLE CASE IS A REFUSAL, NOT INFINITY. Sale below purchase: the contribution goes
  // negative and no quantity of sales covers anything.
  //
  // BOTH FIGURES ARE SET HERE, not just the sale. Earlier clauses in this leg type the worked invoice
  // (£1,250 hammer), so "sale 5000" stopped being a loss and this block waited fifteen seconds for a
  // refusal that was never coming. A clause that inherits state from the one above it is a clause whose
  // meaning changes when somebody edits the one above it.
  await bpage.fill('[data-testid="input-purchase"]', '20000');
  await bpage.fill('[data-testid="input-sale"]', '5000');
  await bpage.waitForSelector('[data-testid="break-even-impossible"]', { timeout: 15000 });
  const refusal = ((await bpage.locator('[data-testid="break-even-impossible"]').textContent()) ?? '').replace(/\s+/g, ' ').trim();
  check('a contribution that cannot cover it says so, and prints no number of sales', /No number of sales covers/.test(refusal)
    && !/\d+ sales? a month/.test(refusal),
    JSON.stringify(refusal));
  check('  …and the confident sentence is GONE, not sitting beside it',
    (await bpage.locator('[data-testid="break-even"]').count()) === 0,
    'a settled refusal replaces the answer; it does not annotate it');

  // ── 5. IT SAVES, AND IT IS NOT A RECORD ──────────────────────────────────────────────────────
  console.log('\n— it saves, and a model is meant to be changed —');
  const owner = await prisma.user.findFirst({ where: { group_id: ZZ_GROUP, email: 'owner@zzgategarage.test' }, select: { id: true } });
  const label = `Gate model ${randomUUID().slice(0, 8)}`;
  const first = await S.saveModel({ groupId: ZZ_GROUP, userId: owner.id, label, vehicleIdent: 'GATE123', inputs: base });
  check('a model saves', 'id' in first);
  made.push(first.id);
  const back = await S.getModel(ZZ_GROUP, first.id);
  check('  …and comes back with the WHOLE input set, not just the answer', back.inputs.daysInStock === base.daysInStock
    && back.inputs.workshopCostPerHourPence === base.workshopCostPerHourPence && back.inputs.vatStatus === 'margin',
    'a model reopened in six months must show what was ASSUMED, not only what was concluded');
  const again = await S.saveModel({ groupId: ZZ_GROUP, userId: owner.id, id: first.id, label, vehicleIdent: 'GATE123', inputs: { ...base, daysInStock: 120 } });
  check('  …and saving over it is ORDINARY — freeze-at-issue does not apply', 'id' in again && again.id === first.id);
  const changed = await S.getModel(ZZ_GROUP, first.id);
  check('  …the model really changed', changed.inputs.daysInStock === 120, `${changed.inputs.daysInStock} days`);
  // THE ANALOGY THAT MUST NOT BE DRAWN. Said in the schema, the leaf and the migration, and asserted
  // here so a later append-only trigger fails a gate rather than passing review.
  const [schema, leaf, mig] = ['prisma/schema.prisma', 'lib/purchase-model.ts', 'prisma/migrations/20260912200000_purchase_model/migration.sql'].map((f) => readFileSync(f, 'utf8'));
  check('the file says freeze-at-issue does NOT apply, and why', /FREEZE-AT-ISSUE DOES NOT APPLY/i.test(schema)
    && /FREEZE-AT-ISSUE DOES NOT APPLY/i.test(leaf) && /FREEZE-AT-ISSUE/i.test(mig));
  const triggers = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relname = 'PurchaseModel' AND NOT t.tgisinternal`);
  check('  …and there is NO append-only trigger on the table', triggers[0].n === 0, `${triggers[0].n} trigger(s)`);

  console.log('\n— the denormalised columns cannot disagree with the inputs —');
  const row = await prisma.purchaseModel.findUnique({ where: { id: first.id }, select: { purchase_pence: true, sale_pence: true, vat_status: true, profit_pence: true, inputs: true, status: true } });
  const recomputed = M.computeModel(S.normaliseInputs(row.inputs));
  check('the stored profit is the profit the stored inputs produce', row.profit_pence === recomputed.contributionPence,
    `${row.profit_pence} vs ${recomputed.contributionPence} — one computation writes both`);
  check('  …and the copies match too', row.purchase_pence === changed.inputs.purchasePence && row.vat_status === changed.inputs.vatStatus);
  check('the status is from the vocabulary, which lives in the leaf not the database', M.MODEL_STATUSES.includes(row.status),
    `'${row.status}' — a CHECK here would make adding 'bought' a constraining migration, which is the room the column exists for`);
  const chk = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = '"PurchaseModel"'::regclass AND contype = 'c' AND conname LIKE '%status%' AND conname NOT LIKE '%vat%'`);
  check('  …so there is deliberately no CHECK on status', chk[0].n === 0, `${chk[0].n} — while vat_status DOES have one, because that vocabulary will not grow`);

  console.log('\n— and the conversion affordances a stock slice will need —');
  check('the vehicle is free TEXT, because the car is not owned', typeof back.vehicle_ident === 'string' && back.vehicle_ident === 'GATE123');
  const cols = await prisma.$queryRawUnsafe(`SELECT column_name FROM information_schema.columns WHERE table_name = 'PurchaseModel' AND column_name IN ('vehicle_id','status','inputs')`);
  check('  …vehicle_id, status and inputs all exist now', cols.length === 3, cols.map((c) => c.column_name).sort().join(', '));
  const fks = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = '"PurchaseModel"'::regclass AND contype = 'f' AND pg_get_constraintdef(oid) LIKE '%Vehicle%'`);
  check('  …and vehicle_id has NO foreign key yet', fks[0].n === 0,
    'so the only migration a stock slice needs is the constraint itself, on its own rather than tangled into a feature');

  // ── 6. THE ENDPOINT IS TENANT-SCOPED ─────────────────────────────────────────────────────────
  console.log('\n— and another garage cannot reach it —');
  const other = await S.getModel('00000000-0000-0000-0000-000000000000', first.id);
  check('a model is invisible to another group', other === null);
  check('  …and cannot be overwritten by one', 'refused' in await S.saveModel({
    groupId: '00000000-0000-0000-0000-000000000000', userId: owner.id, id: first.id, label: 'stolen', vehicleIdent: '', inputs: base }));
  check('  …while the right group still can', 'id' in await S.saveModel({ groupId: ZZ_GROUP, userId: owner.id, id: first.id, label, vehicleIdent: 'GATE123', inputs: base }),
    'the positive case, in the same run');
  const api = await fetch(`${gateOrigin()}/api/purchase-model`);
  check('the endpoint refuses an unauthenticated caller', api.status === 401, `HTTP ${api.status}`);
  check('a blank label is refused', 'refused' in await S.saveModel({ groupId: ZZ_GROUP, userId: owner.id, label: '   ', vehicleIdent: '', inputs: base }));
  check('a slider outside its range is CLAMPED, not stored', S.normaliseInputs({ ...base, daysInStock: 9999 }).daysInStock
    === M.SLIDERS.find((s) => s.key === 'daysInStock').max, 'the form is the prompt; this is the rule');
} catch (e) {
  check('gate run completed', false, describeError(e));
} finally {
  await browser?.close().catch(() => {});
  try {
    if (made.length) await prisma.purchaseModel.deleteMany({ where: { id: { in: made } } });
    await prisma.purchaseModel.deleteMany({ where: { group_id: ZZ_GROUP, label: { startsWith: 'Gate model ' } } });
    check('teardown removed every fixture', (await prisma.purchaseModel.count({ where: { id: { in: made } } })) === 0);
  } catch (e) { check('teardown completed', false, describeError(e)); }
  await prisma.$disconnect();
}
console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
process.exit(out.includes('F') ? 1 : 0);
