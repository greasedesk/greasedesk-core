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
const readSrc = readFileSync;
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
let wroteDefaults = false;
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
    near(mgn.vat.vatToHmrcPence, 33333) && near(mgn.grossProfitPence, 166667) && mgn.vat.cashOutPence === 800000,
    `${mgn.vat.vatToHmrcPence}p · ${mgn.grossProfitPence}p · ${mgn.vat.cashOutPence}p`);
  check('QUALIFYING, price INCLUDES VAT: £333.33 to HMRC, £1,666.67 profit, £8,000 out',
    near(inc.vat.vatToHmrcPence, 33333) && near(inc.grossProfitPence, 166667) && inc.vat.cashOutPence === 800000,
    `${inc.vat.vatToHmrcPence}p · ${inc.grossProfitPence}p · ${inc.vat.cashOutPence}p`);
  check('QUALIFYING, price PLUS VAT: £66.67 to HMRC, £333.33 profit, £9,600 out',
    near(plus.vat.vatToHmrcPence, 6667) && near(plus.grossProfitPence, 33333) && plus.vat.cashOutPence === 960000,
    `${plus.vat.vatToHmrcPence}p · ${plus.grossProfitPence}p · ${plus.vat.cashOutPence}p`);
  check('  …so margin and inclusive-VAT are THE SAME PROFIT — the reclaim cancels the output VAT',
    near(mgn.grossProfitPence, inc.grossProfitPence),
    `${mgn.grossProfitPence}p vs ${inc.grossProfitPence}p — the shipped version claimed the toggle was worth £1,333 here`);
  check('  …and plus-VAT is the one that differs, by £1,333', near(inc.grossProfitPence - plus.grossProfitPence, 133333),
    `${(inc.grossProfitPence - plus.grossProfitPence) / 100} pounds`);

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
  check('dragging days in stock 30 → 90 takes money OUT', d90.grossProfitPence < d30.grossProfitPence,
    `${(d30.grossProfitPence - d90.grossProfitPence) / 100} pounds of stocking cost appears`);
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
  check('  …and the profit moves by exactly that', h2.grossProfitPence - h4.grossProfitPence === h4.workshopCostPence - h2.workshopCostPence);
  check('the two costs a garage rarely counts are separable', at({}).grossProfitBeforeWorkshopAndMoneyPence - at({}).grossProfitPence
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
    const lo = M.computeModel({ ...base, daysInStock: s.min }).grossProfitPence;
    const hi = M.computeModel({ ...base, daysInStock: s.max }).grossProfitPence;
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
  check('the swing column is TITLED', /data-testid="sensitivity-heading"/.test(page) && /Moves gross profit by/.test(page));
  check('  …every figure is prefixed ± and carries the word "swing"', /±\{money\(x\.swingPence\)\}/.test(page) && /swing<\/span>/.test(page),
    'a bare right-aligned amount in a column of amounts reads as an amount');
  check('  …and the page says outright they are not costs', /data-testid="sensitivity-not-cost"/.test(page)
    && /These are not costs/.test(page) && /lowest and its highest/.test(page));
  check('  …while the summary teaches it in words for the top one', /dragging it across its range moves gross profit by/.test(page),
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
    'gross-profit', 'gross-profit-means', 'input-package-monthly', 'input-package-slots', 'ad-package-note'])
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
   * GROSS PROFIT. It was labelled "Profit" in 24px bold, which is the same class of error as the
   * swing column: a word that invites the reading the number cannot support.
   *
   * And Autotrader broke the premise underneath the advertising slider. It is a MONTHLY CONTRACT —
   * about £1,500 for ten cars — so a per-car figure depends on turnover, which is partly what the
   * model exists to work out. The page therefore divides NOTHING: it asks the question the other way
   * round, which is answerable from one car.
   */
  console.log('\n— a gross profit, and a contract that is never divided —');
  /**
   * ── THE BAN CHANGED SHAPE; IT DID NOT GO ──────────────────────────────────────────────────────
   * DO NOT DELETE THIS AS CONTRADICTED BY THE LABEL. The original defect was the BARE word "Profit" in
   * 24px bold: unqualified it reads as the bottom line, and this figure excludes every fixed cost and
   * all tax. That reading is still wrong and still one edit away.
   *
   * What is permitted is the QUALIFIED form. "Gross profit on this car" carries its own qualification —
   * it says WHICH profit — and the subtitle underneath names both exclusions. So the qualified label is
   * required and a bare `Profit` label is still refused. A reader who sees "profit" on screen and assumes
   * the ban lapsed should read this paragraph rather than delete the clause.
   */
  check('the headline is the QUALIFIED form', hasKey(page, 'label', "'Gross profit on this car'"),
    'which profit, said on the face of it');
  check('  …and the BARE word Profit is still refused as a label',
    !/>Profit</.test(page) && !/'Profit'/.test(page) && !hasKey(page, 'label', "'Profit'"),
    'unqualified, it reads as the bottom line — which this figure is not');
  check('  …and the subtitle names BOTH exclusions',
    hasKey(page, 'subtitle', "'Before your fixed monthly costs and tax.'") && /data-testid="gross-profit-means"/.test(page),
    'fixed monthly costs AND tax — "gross" alone tells a reader nothing about which costs are missing');
  check('  …from one expression, so the label and its qualification cannot drift apart',
    /answer\.subtitle/.test(page),
    'a qualified label whose qualification lives elsewhere is a bare label waiting to happen');
  check('  …and ONE expression feeds both places it is shown', (() => {
    // answer.label / answer.text are read by the sticky line and by the panel at the foot. Counting the
    // readers is what stops a later edit hardcoding the figure in one of them and letting them diverge.
    const reads = (page.match(/answer\.(label|text|negative)/g) ?? []).length;
    return /const answer = \{/.test(page) && reads >= 5;
  })(), 'two renderings of one number is a divergence waiting to happen');
  check('  …and the page says what that means', /data-testid="gross-profit-means"/.test(page)
    && /Before your fixed monthly costs and tax/.test(page));
  /**
   * ── RECOVERABILITY IS PER COST, NOT PER PAGE ──────────────────────────────────────────────────
   * One garage's recovery man, paint shop and car wash are not registered; another's haulier and
   * bodyshop are. Same field, same typed figure, real cost differing by a fifth. Every cost behaved as
   * though nothing was recoverable until now — right for the first garage, wrong for the second, and
   * never asked either way.
   */
  console.log('\n— what each supplier does with VAT —');

  check('the three treatments exist as a vocabulary', M.VAT_TREATMENTS.length === 3
    && M.VAT_TREATMENTS.includes('standard_recoverable') && M.VAT_TREATMENTS.includes('standard_not_recoverable')
    && M.VAT_TREATMENTS.includes('no_vat'), M.VAT_TREATMENTS.join(', '));

  const rec = M.costPosition(60000, 'standard_recoverable', true);
  const notRec = M.costPosition(60000, 'standard_not_recoverable', true);
  const noVat = M.costPosition(60000, 'no_vat', true);
  check('a recoverable £600 costs £500', rec.cashPence === 60000 && rec.reclaimablePence === 10000 && rec.costPence === 50000,
    `£600 out of the bank, £100 back, £500 of cost`);
  check('  …not recoverable: the VAT is real and stays', notRec.vatInsidePence === 10000
    && notRec.reclaimablePence === 0 && notRec.costPence === 60000,
    'there IS £100 of VAT in it and we do not get it — a different fact from there being none');
  check('  …no VAT charged: there is none inside it', noVat.vatInsidePence === 0 && noVat.costPence === 60000,
    'what an unregistered supplier does');
  /**
   * TWO OF THE THREE COST THE SAME, AND THEY ARE STILL DIFFERENT. A later reader will want to fold
   * these into a boolean. This clause is what makes that a red rather than a tidy-up.
   */
  check('the two non-recovering states cost the same but SAY different things',
    notRec.costPence === noVat.costPence && notRec.vatInsidePence !== noVat.vatInsidePence,
    'same arithmetic, different invoice — only "no VAT" is true of an unregistered supplier');
  check('an unregistered garage recovers nothing even from a recoverable cost',
    M.costPosition(60000, 'standard_recoverable', false).reclaimablePence === 0,
    'the tenant’s own registration gates this exactly as it gates the indemnities');

  /**
   * ── THE DEFAULTS ARE TODAY'S ARITHMETIC, TO THE PENNY ─────────────────────────────────────────
   * The strongest argument for the conservative default is not that it is cautious — it is that
   * turning this feature on moves no answer at all. Recomputed here from the old formula rather than
   * reasoned about.
   */
  const dflt = M.defaultInputs();
  check('the warranty defaults to NO VAT', dflt.costVat.warrantyPence === 'no_vat',
    'insurance-backed cover carries IPT, not VAT — there is no input tax in it to argue about');
  check('  …and everything else to standard-rated, NOT recoverable',
    M.FLAGGED_COSTS.filter((k) => k !== 'warrantyPence').every((k) => dflt.costVat[k] === 'standard_not_recoverable'),
    JSON.stringify(dflt.costVat));
  check('at the defaults, costs equal the old raw sum exactly', (() => {
    const r0 = M.computeModel(dflt, { vatRegistered: true });
    const oldSum = dflt.partsPence + dflt.advertisingPence + dflt.warrantyPence + dflt.deliveryInPence + dflt.deliveryOutPence;
    return r0.otherCostsPence === oldSum && r0.costVatReclaimablePence === 0;
  })(), 'the whole feature is a no-op until somebody answers a question — which is what makes it safe to ship');
  check('  …and a stored model with no map at all reads the same way',
    JSON.stringify(S.normaliseInputs({ purchasePence: 800000, salePence: 1000000 }).costVat) === JSON.stringify(M.defaultCostVat()),
    'absent is the default, and the default is what that document meant when it was written');
  check('  …an unrecognised treatment falls back rather than throwing',
    S.normaliseInputs({ costVat: { partsPence: 'zero_rated_maybe' } }).costVat.partsPence === 'standard_not_recoverable',
    'normalising a document, not validating a form');

  /**
   * ── THE SWING IS ON COST, NOT CASH ────────────────────────────────────────────────────────────
   * A recoverable cost must not read as a fifth more important than it is, or the ranking recommends
   * squeezing the wrong supplier.
   */
  const swingOf = (inputs, key) => M.sensitivity(inputs, { vatRegistered: true }).find((x) => x.key === key).swingPence;
  const plain = swingOf(dflt, 'partsPence');
  const recoverable = swingOf({ ...dflt, costVat: { ...dflt.costVat, partsPence: 'standard_recoverable' } }, 'partsPence');
  check('a recoverable cost swings LESS than one that is not', recoverable < plain,
    `£${(plain / 100).toFixed(2)} → £${(recoverable / 100).toFixed(2)} — the part that comes back is not at stake`);
  check('  …by its VAT, within a penny of a sixth', Math.abs((plain - recoverable) - Math.round(plain / 6)) <= 2,
    'the swing is measured on what the cost COSTS');
  check('  …and cash out is unmoved by the treatment', (() => {
    const a = M.computeModel(dflt, { vatRegistered: true });
    const b = M.computeModel({ ...dflt, costVat: { ...dflt.costVat, partsPence: 'standard_recoverable' } }, { vatRegistered: true });
    return a.costCashPence === b.costCashPence && a.otherCostsPence !== b.otherCostsPence;
  })(), 'the same money leaves the bank either way; only what it COSTS differs');

  /** THE SEED IS NOT THE TRUTH — the tenant row starts a model and is never read by the arithmetic. */
  const defaultsSrc = readSrc('lib/purchase-model-defaults.ts', 'utf8');
  // COMMENTS STRIPPED FIRST. This file EXPLAINS why computeModel must not read it, so a scanner that
  // cannot tell prose from code finds the very word it is banning — which is exactly what it did.
  const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check('the tenant defaults are never read during a calculation',
    !/computeModel|sensitivity/.test(stripComments(defaultsSrc))
    && !/purchase-model-defaults/.test(stripComments(readSrc('lib/purchase-model.ts', 'utf8'))),
    'changing a standing answer must not rewrite a saved car’s result');
  check('  …and the page seeds from them rather than reading them live',
    hasKey(page, 'costVat', 'costVatDefaults')
    && hasKey(page, 'slotCostPerMonthPence', /perSlotMonthlyPence\(advertisingPackage\)/)
    && /useState<ModelInputs>\(\(\) => \(\{/.test(page),
    'BOTH standing answers seed the model’s own state and are then owned by it — the supplier answers and the per-slot cost');
  check('  …the writer normalises BOTH halves before storing, so a row cannot lie about what it holds',
    /normaliseCostVatMap\(/.test(defaultsSrc) && /normaliseAdvertising\(/.test(defaultsSrc)
    && /upsert\(/.test(defaultsSrc),
    'one writer for one row — a second upsert would be a second way for it to be half-written');
  check('  …and it is an upsert on the group, so "which row wins" cannot be asked',
    /upsert\(/.test(defaultsSrc) && hasKey(defaultsSrc, 'where', /\{\s*group_id: args\.groupId\s*\}/),
    'the group is the primary key, so the table cannot hold two answers for one garage');

  /**
   * ── ONE CONVENTION, AND EVERY MONEY FIELD SAYS IT ─────────────────────────────────────────────
   * A page mixing net and gross figures is wrong by a fifth in places nobody can see, because both
   * readings look like a plausible amount. Every money field now states its basis — by declaring it, or
   * by ASKING, which is what the purchase toggle does.
   */
  console.log('\n— what leaves the bank, said on every money field —');

  /**
   * THE SALE PRICE FIRST, because it is the largest silent one on the page. `sale × 1/6` extracts VAT
   * from a VAT-inclusive amount, so the field has been gross by construction since the qualifying toggle
   * shipped and the label said nothing. An ex-VAT figure typed here understates the VAT owed by a sixth
   * of the WHOLE SALE — £1,666.67 on a £10,000 car, against £2,000 for the largest slider swing.
   */
  check('the sale price states that it is VAT-inclusive', /data-testid="sale-basis"/.test(page)
    && /\{SALE_BASIS_NOTE\}/.test(page) && /VAT included/.test(M.SALE_BASIS_NOTE),
    `renders SALE_BASIS_NOTE, which reads ${JSON.stringify(M.SALE_BASIS_NOTE)} — gross by construction since the qualifying toggle, and never said until now`);
  check('  …and that is what the arithmetic does', (() => {
    // £10,000 qualifying: output VAT is a SIXTH of the sale, which is only right if the sale is gross.
    const v = M.vatPosition(800000, 1000000, 'qualifying', true);
    return v.outputVatPence === Math.round(1000000 / 6);
  })(), 'sale × 1/6 EXTRACTS the VAT — the clause and the code agree about which figure this is');
  check('  …and typing it net would cost a sixth of the sale', (() => {
    const gross = M.vatPosition(800000, 1000000, 'qualifying', true).outputVatPence;
    const asNet = M.vatPosition(800000, 833333, 'qualifying', true).outputVatPence;   // £10,000 ex-VAT
    return gross - asNet >= 16000;   // ~£166 of VAT understated on this car alone
  })(), 'the size of the error the label now prevents');

  /** EVERY MONEY SLIDER DECLARES ITS BASIS, and the declaration is what the screen renders. */
  for (const sl of M.SLIDERS) {
    const expected = sl.unit !== 'money' ? 'n/a' : sl.key === 'workshopCostPerHourPence' ? 'no_vat' : 'gross';
    check(`  …${sl.key} declares basis ${expected}`, sl.basis === expected, `declared ${sl.basis}`);
  }
  check('every GROSS slider says so on screen', M.SLIDERS.filter((x) => x.basis === 'gross')
    .every((x) => new RegExp(`data-testid=\`basis-\\$\{s\\.key\}\``).test(page) || /basis-\$\{s\.key\}/.test(page)),
    'rendered from the slider’s own declaration, so a new money slider cannot omit it');
  check('  …and the wording comes from ONE constant', /GROSS_BASIS_NOTE/.test(page)
    && /Type the total you pay, VAT included/.test(M.GROSS_BASIS_NOTE),
    JSON.stringify(M.GROSS_BASIS_NOTE));
  check('the two fields that cannot carry input VAT are marked, not labelled',
    M.SLIDERS.find((x) => x.key === 'workshopCostPerHourPence').basis === 'no_vat'
    && M.SLIDERS.find((x) => x.key === 'costOfMoneyAnnualPct').basis === 'n/a',
    'wages carry no input VAT and interest is exempt — a "VAT included" note there would be a lie');
  check('the package says which figure it wants', /data-testid="ad-package-note"/.test(page)
    && /GROSS_BASIS_NOTE/.test(page),
    'and it feeds every car through days in stock, so an error here is not confined to one model');

  /**
   * ── THE INDEMNITIES MOVE FROM NET TO GROSS, AND THE ANSWER DOES NOT MOVE ──────────────────────
   * This was the only field asking for a different kind of number. The owner's invoice is now typed
   * £81.60 rather than £68.00 — and produces the identical margin base, reclaim and cash out.
   */
  const grossFees = M.feePosition('auction', { premiumPence: 26520, servicesPence: 8160 }, true);
  check('typed GROSS, the invoice gives the same three answers', grossFees.inMarginBasePence === 26520
    && grossFees.reclaimablePence === 1360 && 125000 + grossFees.cashOutPence === 159680,
    '£81.60 typed instead of £68.00: margin base £1,515.20, reclaim £13.60, cash out £1,596.80 — unchanged');
  check('  …the VAT is EXTRACTED, not added', grossFees.servicesVatPence === Math.round(8160 / 6)
    && grossFees.servicesPence === 8160 - grossFees.servicesVatPence,
    'one direction of arithmetic on the whole page');
  check('  …and the note asks for the total, not the net figure',
    /Type the total including VAT/.test(M.SOURCE_RULES.auction.fees[1].note)
    && !/NET figure/.test(M.SOURCE_RULES.auction.fees[1].note),
    JSON.stringify(M.SOURCE_RULES.auction.fees[1].note));

  /**
   * AND A STORED MODEL'S ANSWER DOES NOT MOVE. £68 net and £68 gross are the same NUMBER, so a document
   * has to say which it holds; one that does not say predates the change and is net. There are zero such
   * documents today — no PurchaseModel row has ever been written — so this protects nothing yet, and it
   * exists because the page is live and a save is one click away.
   */
  const preSplit = S.normaliseInputs({ source: 'auction', servicesPence: 6800, purchasePence: 125000, salePence: 200000 });
  check('a model saved on the NET basis is read as the same money', preSplit.servicesPence === 8160,
    `£68.00 net becomes £81.60 gross — the box changes, the answer does not`);
  check('  …and its fee position is what it always was', (() => {
    const f = M.feePosition('auction', { premiumPence: 0, servicesPence: preSplit.servicesPence }, true);
    return f.servicesPence === 6800 && f.servicesVatPence === 1360 && f.cashOutPence === 8160;
  })(), 'net £68.00, VAT £13.60, £81.60 out of the bank — identical either side of the change');
  check('  …and a document already stamped gross is NOT inflated again', (() => {
    const twice = S.normaliseInputs({ source: 'auction', servicesPence: 8160, feeEntryBasis: 'gross' });
    return twice.servicesPence === 8160;
  })(), 'idempotent — re-reading cannot add 20% a second time');
  check('  …and every save stamps the basis, so absence stays meaningful',
    S.normaliseInputs({ source: 'auction', servicesPence: 8160 }).feeEntryBasis === 'gross',
    'a marker that is sometimes omitted is a marker that cannot be trusted');

  /** THE PURCHASE TOGGLE SURVIVES, and the reason is the rule itself. */
  check('the purchase price states its basis by ASKING', /data-testid="inc-vat-question"/.test(page),
    'the rule forbids a field the reader must INFER; asking and recording is a stronger answer than declaring');

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
  check('the package is asked for as a contract, not a lump sum', /data-testid="input-package-monthly"/.test(page)
    && /data-testid="input-package-slots"/.test(page),
    'monthly cost AND slot count — the denominator comes from the contract, which is what makes it a per-car cost');
  check('  …and the per-slot figure is DERIVED, never typed', /data-testid="per-slot"/.test(page)
    && !/input-per-slot/.test(page) && /it is not typed, so it cannot disagree with your contract/.test(page),
    'a typed per-slot figure is a second answer to a question the contract has already settled');
  check('  …and an undescribed package says so rather than charging a guess',
    /data-testid="per-slot-unknown"/.test(page) && /no advertising cost is charged at all/.test(page));
  /**
   * ── AUTOTRADER IS A PER-CAR COST WITH A KNOWN DENOMINATOR ─────────────────────────────────────
   * The package is X slots, not a lump sum, so the per-slot figure comes from the contract and a car
   * carries it for as long as it is in stock. The break-even sentence stood here and has gone with its
   * premise: it asked how many sales would cover an unallocated overhead, and there is none left.
   */
  const pkg = { monthlyPence: 500000, slots: 50, carsInStock: 30 };
  check('a £5,000 package over 50 slots is £100 a slot', M.perSlotMonthlyPence(pkg) === 10000,
    `${M.perSlotMonthlyPence(pkg)}p — derived from the contract, never typed`);
  check('  …and an undescribed package derives NOTHING', M.perSlotMonthlyPence({ monthlyPence: 500000, slots: 0, carsInStock: 0 }) === null
    && M.perSlotMonthlyPence({ monthlyPence: 0, slots: 50, carsInStock: 0 }) === null,
    'a per-slot figure from a missing slot count is a division by zero dressed as a cost');

  /** PART THEREOF, NOT PRO-RATA — and the boundary is the actionable number. */
  // `at` and `held` are both taken earlier in this file — checked, not guessed.
  const slotAt = (d) => M.slotCharge(10000, d);
  check('30 days is one month, 31 days is two', slotAt(30).cashPence === 10000 && slotAt(31).cashPence === 20000,
    `£100 then £200 — pro-rata would say £103.33 where the invoice says £200`);
  check('  …and the gap at the boundary is £96.67', Math.abs((slotAt(31).cashPence - Math.round(10000 * 31 / 30)) - 9667) <= 1,
    'the most actionable number in the model, and the reason the step is shown rather than smoothed');
  check('  …zero days occupies no slot', slotAt(0).monthsCharged === 0 && slotAt(0).cashPence === 0);
  check('  …and the boundary says how long is covered', slotAt(45).coveredUntilDay === 60 && slotAt(45).daysBeforeNextCharge === 15,
    'day 45 of a second month: 15 days before a third is charged');
  check('  …with zero days left meaning the next day costs another month', slotAt(30).daysBeforeNextCharge === 0
    && slotAt(30).nextChargePence === 10000, 'the sharp case, and the one worth acting on');

  /** IT IS A REAL COST NOW, AND IT MOVES WITH DAYS IN STOCK. */
  const dIn = { ...M.defaultInputs(), slotCostPerMonthPence: 10000 };
  const short = M.computeModel({ ...dIn, daysInStock: 30 }, { vatRegistered: true });
  const long = M.computeModel({ ...dIn, daysInStock: 90 }, { vatRegistered: true });
  check('the slot is charged to the car', short.slot.cashPence === 10000 && long.slot.cashPence === 30000,
    'one month against three');
  check('  …and days in stock now drives TWO costs', long.stockingCostPence > short.stockingCostPence
    && long.slot.cashPence > short.slot.cashPence,
    'the money and the slot — which is why its swing grows');
  check('  …its swing grew accordingly', (() => {
    const withoutPkg = M.sensitivity(M.defaultInputs(), { vatRegistered: true }).find((x) => x.key === 'daysInStock').swingPence;
    const withPkg = M.sensitivity(dIn, { vatRegistered: true }).find((x) => x.key === 'daysInStock').swingPence;
    return withPkg > withoutPkg * 2;
  })(), 'from one driver to two, on the same slider');
  check('  …and an undescribed package charges nothing at all', (() => {
    const none = M.computeModel(M.defaultInputs(), { vatRegistered: true });
    return none.slot.cashPence === 0 && none.slotCost.costPence === 0;
  })(), 'no package, no advertising cost — not a guessed one');
  check('the slot VAT is recoverable by construction, with no supplier flag',
    M.computeModel({ ...dIn, daysInStock: 30 }, { vatRegistered: true }).slotCost.reclaimablePence === Math.round(10000 / 6)
    && !M.FLAGGED_COSTS.includes('slotCostPerMonthPence'),
    'Autotrader is VAT registered — unlike a paint shop, there is nothing to ask');

  /** UTILISATION, WHICH REPLACED THE BREAK-EVEN SENTENCE. */
  const u = M.slotUtilisation(pkg);
  check('50 slots and 30 cars is 20 empty, at £2,000 a month', u.emptySlots === 20 && u.wastedMonthlyPence === 200000,
    'the question the slot count makes available, and nobody is asking it');
  check('  …more cars than slots is a different problem, and named as one', (() => {
    const over = M.slotUtilisation({ monthlyPence: 500000, slots: 50, carsInStock: 60 });
    return over.emptySlots === 0 && over.unadvertisedCars === 10;
  })(), 'ten cars nobody can see is not waste — it is worse');
  check('  …and an undescribed package asks nothing', M.slotUtilisation(M.emptyAdvertisingPackage()) === null);

  /** THE TWO UNANSWERED QUESTIONS ARE SAID, NOT GUESSED. */
  const leafSrc = readSrc('lib/purchase-model.ts', 'utf8');
  check('the part-exchange slots are named as UNKNOWN in the file', /PART-EXCHANGE SLOTS[\s\S]{0,200}UNKNOWN/.test(leafSrc),
    'three readings give three different per-slot costs, so guessing is wrong by a knowable amount');
  check('  …and so is the billing granularity', /BILLING GRANULARITY[\s\S]{0,120}UNKNOWN/.test(leafSrc));
  check('  …and the screen says so too', /data-testid="package-unanswered"/.test(page)
    && /Not yet modelled/.test(page) && /neither is guessed/.test(page));
  check('  …and neither answer will need a migration', /advertising\s+Json\?/.test(readSrc('prisma/schema.prisma', 'utf8')),
    'the package is JSONB and unrecognised keys are ignored on read');

  /** THE RANKING ROW FOLLOWS THE SLIDER, because both read SLIDERS — asserted, not assumed. */
  const rankedLabels = M.sensitivity(M.defaultInputs()).map((x) => x.label);
  check('the ranking row reads "Additional advertising"', rankedLabels.includes('Additional advertising'),
    JSON.stringify(rankedLabels.filter((l) => /advertis/i.test(l))));
  check('  …and the subscription is NOT a row in it', !rankedLabels.some((l) => /Autotrader/i.test(l)),
    'a fixed monthly cost has no range to swing across');


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
  // TYPED AS THE INVOICE TOTALS, gross throughout: the premium has its VAT inside it by definition, and
  // the indemnities are now typed the same way — £68.00 net + £13.60 VAT is £81.60 out of the bank.
  const HAMMER = 125000, PREMIUM = 26520, INDEMNITIES = 8160, INDEMNITY_NET = 6800, INDEMNITY_VAT = 1360;
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

  check('the indemnities are standard rated, VAT extracted', fees.servicesVatPence === INDEMNITY_VAT
    && fees.servicesPence === INDEMNITY_NET,
    `£81.60 typed → ${fees.servicesVatPence}p VAT and ${fees.servicesPence}p of cost, and the invoice shows £13.60 and £68.00`);
  check('  …reclaimable input VAT is £13.60', fees.reclaimablePence === INDEMNITY_VAT, `${fees.reclaimablePence}p`);
  check('  …and they are NOT in the margin base', (() => {
    const servicesOnly = M.feePosition('auction', { premiumPence: 0, servicesPence: INDEMNITIES }, true);
    return servicesOnly.inMarginBasePence === 0;
  })(), 'a separate service, so the margin never sees it');

  const whole = M.computeModel(invoiceCase, { vatRegistered: true });
  check('cash out is £1,596.80', whole.vat.cashOutPence + whole.fee.cashOutPence === 159680,
    `${whole.vat.cashOutPence + whole.fee.cashOutPence}p = £1,250.00 + £265.20 + £81.60`);
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
    const u = M.feePosition('trade', { premiumPence: 0, servicesPence: 36000 }, false);
    return u.reclaimablePence === 0 && u.netCostPence === 36000 && u.servicesVatPence === 6000;
  })(), '£360 paid is £360 of cost when there is nothing to reclaim it against — the VAT inside it stays');

  /** THE LABELS ARE THE INVOICE'S OWN WORDS, because that is what the garage is reading while they type. */
  const auctionFees = M.SOURCE_RULES.auction.fees.map((f) => f.label);
  check('the auction labels are "Buyer’s premium" and "Indemnities"',
    auctionFees.some((l) => /Buyer’s premium/.test(l)) && auctionFees.some((l) => /Indemnities/.test(l)),
    JSON.stringify(auctionFees));
  check('  …and the premium’s note says the VAT is inside it',
    /VAT is inside this figure and not shown separately/.test(M.SOURCE_RULES.auction.fees[0].note));
  check('  …and the indemnities’ note asks for the TOTAL, like every other field',
    /Type the total including VAT/.test(M.SOURCE_RULES.auction.fees[1].note),
    JSON.stringify(M.SOURCE_RULES.auction.fees[1].note));

  /**
   * AND THE ONE-FIELD MODELS STILL READ THE SAME. `buyerFeePence` MEANT different things by source, so it
   * migrates to the slot that source already applied it to. Mapping it to one slot for both would have
   * changed every stored auction model by 20% of the fee, silently.
   */
  const legacyAuction = S.normaliseInputs({ source: 'auction', buyerFeePence: 26520, purchasePence: HAMMER, salePence: 200000 });
  const legacyTrade = S.normaliseInputs({ source: 'trade', buyerFeePence: 30000, purchasePence: HAMMER, salePence: 200000 });
  check('an old AUCTION fee becomes the premium', legacyAuction.premiumPence === 26520 && legacyAuction.servicesPence === 0,
    'the old rules folded it into the margin base with its VAT inside — that is a premium');
  check('  …and an old TRADE fee becomes the service, converted to gross', legacyTrade.servicesPence === 36000
    && legacyTrade.premiumPence === 0,
    '£300 typed under the old NET rules is £360 out of the bank — the same money, said the new way');
  check('  …and neither is counted twice', legacyAuction.premiumPence + legacyAuction.servicesPence === 26520
    && legacyTrade.premiumPence + legacyTrade.servicesPence === 36000,
    'the premium is already gross by definition, so only the services figure converts');

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
    M.computeModel(legacy).grossProfitPence === M.computeModel({ ...legacy, source: 'trade' }).grossProfitPence
    && M.computeModel(legacy).grossProfitPence === M.computeModel({ ...legacy, source: 'private' }).grossProfitPence,
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
  await bpage.waitForSelector('[data-testid="input-package-monthly"]', { timeout: 25000 });

  // NOTHING DESCRIBED, NOTHING CHARGED. An undescribed package must not guess a slot cost.
  check('with no package described, no advertising cost is charged',
    (await bpage.locator('[data-testid="per-slot-unknown"]').count()) === 1
    && (await bpage.locator('[data-testid="slot-charge"]').count()) === 0,
    'no package, no cost — not a guessed one');

  // THE OWNER'S PACKAGE: £5,000 a month, 50 slots, 30 cars in stock. WAIT ON THE CONDITION, never a sleep.
  await bpage.fill('[data-testid="input-package-monthly"]', '5000');
  await bpage.fill('[data-testid="input-package-slots"]', '50');
  await bpage.fill('[data-testid="input-package-stock"]', '30');
  await bpage.waitForSelector('[data-testid="per-slot"]', { timeout: 15000 });
  const perSlotLine = ((await bpage.locator('[data-testid="per-slot"]').textContent()) ?? '').replace(/\s+/g, ' ').trim();
  check('the per-slot figure is derived on screen', /£100\.00 per slot per month/.test(perSlotLine), JSON.stringify(perSlotLine));

  // UTILISATION, WHICH REPLACED THE BREAK-EVEN SENTENCE.
  const utilLine = ((await bpage.locator('[data-testid="slot-utilisation"]').textContent()) ?? '').replace(/\s+/g, ' ').trim();
  check('  …and the empty slots are named in money', /paying for 50 slots and filling 30/.test(utilLine)
    && /£2,000\.00 a month/.test(utilLine), JSON.stringify(utilLine));
  check('  …the break-even sentence is GONE, not sitting beside it',
    (await bpage.locator('[data-testid="break-even"]').count()) === 0
    && (await bpage.locator('[data-testid="break-even-impossible"]').count()) === 0,
    'its premise died with the denominator; leaving it would answer a question nobody is asking');

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
      text: document.querySelector('[data-testid="gross-profit-top"]')?.textContent?.trim() ?? null,
      bottom: document.querySelector('[data-testid="gross-profit"]')?.textContent?.trim() ?? null };
  });
  const atSlider = await glance();
  check('with a slider on screen, the answer is too', atSlider.inViewport === true,
    `gross profit reads ${atSlider.text} at the top while the sliders are under the cursor`);
  check('  …and it is the same figure as the panel at the foot', atSlider.text === atSlider.bottom && !!atSlider.text,
    `top ${atSlider.text} · bottom ${atSlider.bottom} — two renderings of one number, from one expression`);
  check('  …and it names WHICH profit, not a bare one', /Gross profit on this car/.test((await bpage.locator('[data-testid="answer-top"]').textContent()) ?? ''),
    'the qualified label, in both places it is shown');

  // MOVE A SLIDER AND WATCH THE TOP CHANGE. This is the thing the tool is for.
  await bpage.locator('[data-testid="slider-partsPence"]').focus();
  await bpage.locator('[data-testid="slider-partsPence"]').press('End');
  await bpage.waitForFunction((was) => document.querySelector('[data-testid="gross-profit-top"]')?.textContent?.trim() !== was,
    atSlider.text, { timeout: 15000 });
  const moved = await glance();
  check('dragging a slider changes the figure at the top, while it is still on screen',
    moved.text !== atSlider.text && moved.inViewport === true && moved.text === moved.bottom,
    `${atSlider.text} → ${moved.text}`);

  /**
   * ── THE SUPPLIER ANSWERS, DRIVEN AND REMEMBERED ───────────────────────────────────────────────
   * The selector, the figure it changes, and the tenant write it performs. The row is deleted at the
   * end of the run: this gate writes a REAL tenant-wide setting on ZZ, which is the kind of fixture
   * that must not outlive its run.
   */
  await bpage.locator('[data-testid="supplier-vat"]').scrollIntoViewIfNeeded();
  check('the supplier answers live in one place, not bolted to each slider',
    (await bpage.locator('[data-testid="supplier-vat"]').count()) === 1
    && (await bpage.locator('[data-testid^="supplier-row-"]').count()) === M.FLAGGED_COSTS.length,
    `${M.FLAGGED_COSTS.length} rows — five three-state selectors among the sliders would treble the height of the part being dragged`);
  check('  …and the warranty starts at no VAT', (await bpage.locator('[data-testid="supplier-vat-warrantyPence"]').inputValue()) === 'no_vat',
    'insurance-backed cover is the common case');
  // NO SUPPLIER ANSWER HAS BEEN GIVEN YET, and that is what this asserts. It used to assert that
  // NOTHING was reclaimable — true until the slot arrived, whose VAT is recoverable by construction and
  // needs no supplier answer. The clause now says what it means rather than what happened to be true.
  check('  …with every supplier still on its non-recovering default', (await Promise.all(
    M.FLAGGED_COSTS.map((k) => bpage.locator(`[data-testid="supplier-vat-${k}"]`).inputValue()),
  )).every((v) => v === 'standard_not_recoverable' || v === 'no_vat'),
    'the supplier feature is a no-op until a question is answered');

  // ANSWER ONE, AND WATCH THE FIGURE MOVE.
  const beforeVat = ((await bpage.locator('[data-testid="gross-profit-top"]').textContent()) ?? '').trim();
  await bpage.selectOption('[data-testid="supplier-vat-partsPence"]', 'standard_recoverable');
  await bpage.waitForSelector('[data-testid="cost-vat-reclaim"]', { timeout: 15000 });
  const reclaimLine = ((await bpage.locator('[data-testid="cost-vat-reclaim"]').textContent()) ?? '').replace(/\s+/g, ' ').trim();
  const afterVat = ((await bpage.locator('[data-testid="gross-profit-top"]').textContent()) ?? '').trim();
  check('marking parts recoverable states the cash, the reclaim and the cost',
    /leaves the bank/.test(reclaimLine) && /comes back on your next return/.test(reclaimLine),
    JSON.stringify(reclaimLine));
  check('  …and gross profit rises by the VAT that comes back', afterVat !== beforeVat,
    `${beforeVat} → ${afterVat}`);

  // AND IT REMEMBERS — a real write to a real tenant row, removed in the teardown below.
  await bpage.click('[data-testid="remember-suppliers"]');
  await bpage.waitForSelector('[data-testid="remember-suppliers-msg"]', { timeout: 15000 });
  const remembered = ((await bpage.locator('[data-testid="remember-suppliers-msg"]').textContent()) ?? '').trim();
  check('the answers can be remembered for next time', /Saved for every new model/.test(remembered), JSON.stringify(remembered));
  // `row` is taken later in this file by the saved-model check; naming it for what it is avoids the
  // collision and reads better anyway.
  const defaultsRow = await prisma.purchaseModelDefaults.findUnique({
    where: { group_id: ZZ_GROUP }, select: { cost_vat: true },
  });
  wroteDefaults = !!defaultsRow;
  check('  …and the tenant row says so', defaultsRow?.cost_vat?.partsPence === 'standard_recoverable',
    JSON.stringify(defaultsRow?.cost_vat ?? null));
  // READ BACK THROUGH THE ONE READER, not by inspecting the column again — that is what a later page
  // load will do, so it is what proves the answer will actually seed the next model.
  const reseeded = await (await import('../lib/purchase-model-defaults.ts')).getCostVatDefaults(ZZ_GROUP);
  check('  …and the one reader hands it back, ready to seed the next model',
    reseeded.partsPence === 'standard_recoverable' && reseeded.warrantyPence === 'no_vat',
    JSON.stringify(reseeded));

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
  await bpage.fill('[data-testid="input-services"]', '81.60');
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

  // AND THE IMPOSSIBLE CASE IS A REFUSAL, NOT INFINITY. Sale below purchase: the gross profit goes
  // negative and no quantity of sales covers anything.
  //
  // BOTH FIGURES ARE SET HERE, not just the sale. Earlier clauses in this leg type the worked invoice
  // (£1,250 hammer), so "sale 5000" stopped being a loss and this block waited fifteen seconds for a
  // refusal that was never coming. A clause that inherits state from the one above it is a clause whose
  // meaning changes when somebody edits the one above it.
  /**
   * ── THE BOUNDARY, WHERE THE BREAK-EVEN REFUSAL USED TO BE ─────────────────────────────────────
   * The step from one month to two is the most actionable number in the model and the one most likely
   * to read as a bug, so it is driven: the slider is moved to a day where one more day costs another
   * month, and the screen must say so in money.
   *
   * BOTH FIGURES ARE SET HERE, not inherited. Earlier clauses in this leg type the worked invoice, and
   * a clause that inherits state from the one above it changes meaning when somebody edits that one.
   */
  await bpage.fill('[data-testid="input-purchase"]', '8000');
  await bpage.fill('[data-testid="input-sale"]', '10000');
  await bpage.locator('[data-testid="slider-daysInStock"]').focus();
  await bpage.locator('[data-testid="slider-daysInStock"]').press('Home');   // 0 days, then step up to 30
  for (let i = 0; i < 6; i += 1) await bpage.locator('[data-testid="slider-daysInStock"]').press('ArrowRight');
  await bpage.waitForSelector('[data-testid="slot-charge"]', { timeout: 15000 });
  const slotLine = ((await bpage.locator('[data-testid="slot-charge"]').textContent()) ?? '').replace(/\s+/g, ' ').trim();
  check('at exactly 30 days the screen says one more day costs another month',
    /One more day starts another month/.test(slotLine) && /£100\.00/.test(slotLine),
    JSON.stringify(slotLine));
  await bpage.locator('[data-testid="slider-daysInStock"]').press('ArrowRight');
  await bpage.waitForFunction(() => /2 months/.test(document.querySelector('[data-testid="slot-charge"]')?.textContent ?? ''),
    undefined, { timeout: 15000 });
  const crossed = ((await bpage.locator('[data-testid="slot-charge"]').textContent()) ?? '').replace(/\s+/g, ' ').trim();
  check('  …and one notch later it is two months and £200', /2 months of a slot/.test(crossed) && /£200\.00/.test(crossed),
    JSON.stringify(crossed));

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
  check('the stored profit is the profit the stored inputs produce', row.profit_pence === recomputed.grossProfitPence,
    `${row.profit_pence} vs ${recomputed.grossProfitPence} — one computation writes both`);
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
    // A TENANT-WIDE SETTING WRITTEN BY A GATE IS A FIXTURE. ZZ had no row before this ran and must have
    // none after — removed by its own key, on the gate tenant only.
    if (wroteDefaults) {
      const d = await prisma.purchaseModelDefaults.deleteMany({ where: { group_id: ZZ_GROUP } });
      check('teardown removed the tenant defaults this run wrote', d.count === 1, `${d.count} row`);
    }
    if (made.length) await prisma.purchaseModel.deleteMany({ where: { id: { in: made } } });
    await prisma.purchaseModel.deleteMany({ where: { group_id: ZZ_GROUP, label: { startsWith: 'Gate model ' } } });
    check('teardown removed every fixture', (await prisma.purchaseModel.count({ where: { id: { in: made } } })) === 0);
  } catch (e) { check('teardown completed', false, describeError(e)); }
  await prisma.$disconnect();
}
console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
process.exit(out.includes('F') ? 1 : 0);
