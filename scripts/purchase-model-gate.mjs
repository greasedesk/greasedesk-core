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
const { gatePrisma, describeError, gateOrigin, ZZ_GROUP } = await import('./_gate-preflight.mjs');
const { readFileSync } = await import('node:fs');
const { randomUUID } = await import('node:crypto');
const M = await import('../lib/purchase-model.ts');
const S = await import('../lib/purchase-model-store.ts');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const code = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const prisma = await gatePrisma();
const made = [];
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
    near(mgn.vat.vatToHmrcPence, 33333) && near(mgn.profitPence, 166667) && mgn.vat.cashOutPence === 800000,
    `${mgn.vat.vatToHmrcPence}p · ${mgn.profitPence}p · ${mgn.vat.cashOutPence}p`);
  check('QUALIFYING, price INCLUDES VAT: £333.33 to HMRC, £1,666.67 profit, £8,000 out',
    near(inc.vat.vatToHmrcPence, 33333) && near(inc.profitPence, 166667) && inc.vat.cashOutPence === 800000,
    `${inc.vat.vatToHmrcPence}p · ${inc.profitPence}p · ${inc.vat.cashOutPence}p`);
  check('QUALIFYING, price PLUS VAT: £66.67 to HMRC, £333.33 profit, £9,600 out',
    near(plus.vat.vatToHmrcPence, 6667) && near(plus.profitPence, 33333) && plus.vat.cashOutPence === 960000,
    `${plus.vat.vatToHmrcPence}p · ${plus.profitPence}p · ${plus.vat.cashOutPence}p`);
  check('  …so margin and inclusive-VAT are THE SAME PROFIT — the reclaim cancels the output VAT',
    near(mgn.profitPence, inc.profitPence),
    `${mgn.profitPence}p vs ${inc.profitPence}p — the shipped version claimed the toggle was worth £1,333 here`);
  check('  …and plus-VAT is the one that differs, by £1,333', near(inc.profitPence - plus.profitPence, 133333),
    `${(inc.profitPence - plus.profitPence) / 100} pounds`);

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
  check('dragging days in stock 30 → 90 takes money OUT', d90.profitPence < d30.profitPence,
    `${(d30.profitPence - d90.profitPence) / 100} pounds of stocking cost appears`);
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
  check('  …and the profit moves by exactly that', h2.profitPence - h4.profitPence === h4.workshopCostPence - h2.workshopCostPence);
  check('the two costs a garage rarely counts are separable', at({}).profitBeforeWorkshopAndMoneyPence - at({}).profitPence
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
    const lo = M.computeModel({ ...base, daysInStock: s.min }).profitPence;
    const hi = M.computeModel({ ...base, daysInStock: s.max }).profitPence;
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
  check('  …and the limit is beside the ranking, not in a footer', page.indexOf('sensitivity-limit') < page.indexOf('sensitivity-list'));
  check('no figure from the garage\'s own accounts reaches this page', !/monthlyWageBill|costsInWindow|charged-labour|getAvailableHours/.test(page),
    'every number on it was typed or dragged by the person looking at it');

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
  check('the stored profit is the profit the stored inputs produce', row.profit_pence === recomputed.profitPence,
    `${row.profit_pence} vs ${recomputed.profitPence} — one computation writes both`);
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
  try {
    if (made.length) await prisma.purchaseModel.deleteMany({ where: { id: { in: made } } });
    await prisma.purchaseModel.deleteMany({ where: { group_id: ZZ_GROUP, label: { startsWith: 'Gate model ' } } });
    check('teardown removed every fixture', (await prisma.purchaseModel.count({ where: { id: { in: made } } })) === 0);
  } catch (e) { check('teardown completed', false, describeError(e)); }
  await prisma.$disconnect();
}
console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
process.exit(out.includes('F') ? 1 : 0);
