/**
 * File: scripts/stock-fillable-gate.mjs
 * @gate-requires: db, server
 *
 * THE STOCK BOOK IS FILLABLE. A panel that names its own gaps and offers no way to close them is
 * the defect this slice exists for: on LC09XFU the book printed VIN, Colour, Seller and Purchase
 * reference as "not recorded" and there was no route to record any of them.
 *
 * ── THE SPLIT, WHICH IS THE WHOLE RULE (owner's ruling, 2026-10-11) ─────────────────────────────
 * On a car that has been SOLD, a FACT ABOUT THE CAR stays editable and a TERM OF THE DEAL freezes.
 * The VIN and the colour are facts: a car does not change colour because it changed hands. The
 * seller, the purchase reference and the mileage fed the margin, and a filed quarter must give what
 * it gave then. Enumerated from the key list, not from a list of keys this gate thought of.
 *
 * ── AND THE TICK COLUMN HAS TWO WRITERS NOW ─────────────────────────────────────────────────────
 * `not_on_paperwork` is one column spanning both groups. Two writers with different disposal rules
 * means a writer that saves the whole list erases the other's ticks, which is why mergeTicks owns
 * only its own keys — asserted here against a planted foreign tick.
 *
 * Fixtures on ZZ Gate Garage only, prefix ZZFILL, swept before and after. Never TMBS.
 */
import './_gate-preflight.mjs';
const { gatePrisma, describeError, ZZ_GROUP, zzSite, gateOrigin, serverReady } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { readFileSync } = await import('node:fs');
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const R = '/Users/hugh/Developer/greasedesk-core';
const PW = await import(`${R}/lib/stock-paperwork.ts`);
const PREFIX = 'ZZFILL';

let prisma = null;
let fix = false;
let browser = null;
try {

// ── THE SPLIT ─────────────────────────────────────────────────────────────────────────────────
console.log('— a fact about the car, or a term of the deal —');

const ALL = [...PW.PURCHASE_PAPERWORK_KEYS, ...PW.SALE_PAPERWORK_KEYS];

// ENUMERATED FROM THE KEY LIST. A clause naming the six keys it remembers would pass while a
// seventh went unclassified — the completeness trap this suite has met before.
check('every paperwork key is classified as a car fact or a deal term',
  ALL.every((k) => typeof PW.IS_CAR_FACT[k] === 'boolean') && Object.keys(PW.IS_CAR_FACT).length === ALL.length,
  `${ALL.length} keys, ${Object.keys(PW.IS_CAR_FACT).length} classified`);

check('the CAR FACTS are exactly make/model, VIN and colour',
  JSON.stringify(ALL.filter((k) => PW.IS_CAR_FACT[k]).sort()) === JSON.stringify(['colour', 'make_model', 'vin']),
  ALL.filter((k) => PW.IS_CAR_FACT[k]).join(', '));

check('the DEAL TERMS include the seller, the reference and both mileages',
  ['seller_name', 'purchase_ref', 'mileage', 'sale_mileage', 'buyer_name', 'buyer_address', 'receipt_ref']
    .every((k) => PW.IS_CAR_FACT[k] === false));

check('editableAfterDisposal agrees with IS_CAR_FACT on every key',
  ALL.every((k) => PW.editableAfterDisposal(k) === PW.IS_CAR_FACT[k]));

// The boot invariant: an unclassified key must stop the module loading, not surface later as a
// field nobody can edit on a sold car.
{
  const src = readFileSync(`${R}/lib/stock-paperwork.ts`, 'utf8');
  check('an unclassified key fails AT BOOT',
    src.includes("throw new Error(`UNCLASSIFIED_PAPERWORK_KEY:"), 'the throw is present in the module');
}

// ── MERGING TICKS ─────────────────────────────────────────────────────────────────────────────
console.log('\n— two writers, one tick column —');

const CAR = ALL.filter((k) => PW.IS_CAR_FACT[k]);
const DEAL = PW.PURCHASE_PAPERWORK_KEYS.filter((k) => !PW.IS_CAR_FACT[k]);

check('a car-facts save leaves the deal-term ticks alone',
  JSON.stringify(PW.mergeTicks(['seller_name', 'purchase_ref'], CAR, ['vin']).sort())
  === JSON.stringify(['purchase_ref', 'seller_name', 'vin']),
  PW.mergeTicks(['seller_name', 'purchase_ref'], CAR, ['vin']).join(', '));

check('a deal-terms save leaves the car-fact ticks alone',
  JSON.stringify(PW.mergeTicks(['vin', 'colour'], DEAL, ['seller_name']).sort())
  === JSON.stringify(['colour', 'seller_name', 'vin']));

check('un-ticking removes only the owned key',
  JSON.stringify(PW.mergeTicks(['vin', 'colour', 'seller_name'], CAR, ['vin']).sort())
  === JSON.stringify(['seller_name', 'vin']),
  'colour un-ticked, seller_name untouched');

check('a tick the writer does not own cannot be added through it',
  !PW.mergeTicks([], CAR, ['seller_name']).includes('seller_name'));

// A STRING NOBODY RECOGNISES IS STILL SOMETHING A PERSON SAID. Dropping it would lose a fact.
check('an unknown entry already in the column is preserved',
  PW.mergeTicks(['some_future_key'], CAR, ['vin']).includes('some_future_key'));

check('merging is idempotent and never duplicates',
  JSON.stringify(PW.mergeTicks(['vin'], CAR, ['vin'])) === JSON.stringify(['vin']));

check('a null column starts from empty rather than throwing',
  JSON.stringify(PW.mergeTicks(null, CAR, ['colour'])) === JSON.stringify(['colour']));

// ── AND THE ENTRY RULE MUST STAY STRICTER THAN THE EDIT RULE ──────────────────────────────────
// Two functions, deliberately. They must DISAGREE on blank-and-unticked, or one has quietly become
// the other and either entry stops asking or editing stops being possible one field at a time.
console.log('\n— entry asks; editing fills one gap at a time —');
{
  const keys = ['vin', 'colour'];
  const blank = { vin: null, colour: null };
  check('ENTRY refuses a blank that nobody ticked', PW.checkPaperwork(keys, blank, []) !== null,
    (PW.checkPaperwork(keys, blank, []) || '').slice(0, 60));
  check('EDITING accepts it — the gap is simply still open', PW.checkPaperworkEdit(keys, blank, []) === null);
  check('both refuse filled AND ticked, which is a contradiction either way',
    PW.checkPaperwork(keys, { vin: 'X', colour: 'Red' }, ['vin']) !== null
    && PW.checkPaperworkEdit(keys, { vin: 'X', colour: 'Red' }, ['vin']) !== null);
  check('both refuse a tick for a key that is not on this form',
    PW.checkPaperwork(keys, blank, ['seller_name']) !== null
    && PW.checkPaperworkEdit(keys, blank, ['seller_name']) !== null);
}

// ── THE WRITERS, ON REAL ROWS ─────────────────────────────────────────────────────────────────
// None of the above would notice a writer that never touches Vehicle, or a refusal that fires on
// the wrong side of the split. Those are rows, not arithmetic.
console.log('\n— fixtures on ZZ: the two writers —');
prisma = await gatePrisma();
const site = await zzSite(prisma);
const ST = await import(`${R}/lib/stock-store.ts`);

const sweep = async () => {
  const items = await prisma.stockItem.findMany({ where: { group_id: ZZ_GROUP, vehicle: { registration: { startsWith: PREFIX } } }, select: { id: true } });
  await prisma.stockDisposal.deleteMany({ where: { stock_item_id: { in: items.map((i) => i.id) } } });
  await prisma.stockCost.deleteMany({ where: { stock_item_id: { in: items.map((i) => i.id) } } });
  await prisma.stockItem.deleteMany({ where: { id: { in: items.map((i) => i.id) } } });
  await prisma.vehicle.deleteMany({ where: { group_id: ZZ_GROUP, registration: { startsWith: PREFIX } } });
};
await sweep();
fix = true;

const owner = await prisma.user.findFirst({ where: { group_id: ZZ_GROUP, is_owner: true }, select: { id: true } });
// THE FIXTURE CARRIES AN MOT AND A CHECK STAMP. Without them every car here renders the ABSENCE
// text ("not recorded" / "never checked against DVSA"), which is non-empty — so a clause asking
// only "is there provenance text?" passed on the fallback and had never seen the real path. The
// first mutation set caught that: blanking mot_checked_at in the payload went 0 RED.
const MOT_EXPIRY = new Date('2027-03-20T00:00:00Z');
const MOT_CHECKED = new Date('2026-09-18T00:00:00Z');
const mk = async (n, withDisposal, withMot = true) => {
  const v = await prisma.vehicle.create({ data: { group_id: ZZ_GROUP, registration: `${PREFIX}${n}`, registration_normalized: `${PREFIX}${n}`, make: 'MINI', model: 'ONE',
    mot_expiry: withMot ? MOT_EXPIRY : null, mot_checked_at: withMot ? MOT_CHECKED : null }, select: { id: true } });
  const s = await prisma.stockItem.create({
    data: { group_id: ZZ_GROUP, vehicle_id: v.id, acquired_at: new Date('2026-04-01'), status: 'in_prep',
      purchase_pence: 100000, vat_status: 'margin', source: 'trade', created_by_user_id: owner.id, not_on_paperwork: [] },
    select: { id: true },
  });
  if (withDisposal) {
    await prisma.stockDisposal.create({ data: { group_id: ZZ_GROUP, stock_item_id: s.id, kind: 'sold', disposed_at: new Date('2026-05-01'), sale_pence: 150000, recorded_not_invoiced: true, not_on_paperwork: [], created_by_user_id: owner.id } });
  }
  return { stockId: s.id, vehicleId: v.id };
};
const live = await mk('LIVE', false);
const gone = await mk('GONE', true);
const args = (id) => ({ groupId: ZZ_GROUP, userId: owner.id, stockItemId: id });

// THE GAP THE SLICE EXISTS FOR: these four were unrecordable after entry.
{
  const r = await ST.updateCarFacts({ ...args(live.stockId), vin: 'ZZFILLVIN0000001', colour: 'Smurf Blue' });
  const v = await prisma.vehicle.findUnique({ where: { id: live.vehicleId }, select: { vin: true, colour: true } });
  check('a VIN and a colour can be recorded AFTER entry', !('refused' in r) && v.vin === 'ZZFILLVIN0000001' && v.colour === 'Smurf Blue',
    'refused' in r ? r.refused : `${v.vin} / ${v.colour}`);
}
{
  const r = await ST.updatePurchaseFacts({ ...args(live.stockId), sellerName: 'KJM Motors', purchaseRef: 'KJM-1042' });
  const s = await prisma.stockItem.findUnique({ where: { id: live.stockId }, select: { seller_name: true, purchase_ref: true } });
  check('a seller and a purchase reference can be recorded after entry',
    !('refused' in r) && s.seller_name === 'KJM Motors' && s.purchase_ref === 'KJM-1042',
    'refused' in r ? r.refused : `${s.seller_name} / ${s.purchase_ref}`);
}

// THE SPLIT, ON A SOLD CAR. This is the owner's ruling and the reason there are two writers.
{
  const car = await ST.updateCarFacts({ ...args(gone.stockId), vin: 'ZZFILLVIN0000002' });
  const v = await prisma.vehicle.findUnique({ where: { id: gone.vehicleId }, select: { vin: true } });
  check('on a SOLD car the VIN is still correctable — it is a fact about the car',
    !('refused' in car) && v.vin === 'ZZFILLVIN0000002', 'refused' in car ? car.refused : v.vin);

  const deal = await ST.updatePurchaseFacts({ ...args(gone.stockId), sellerName: 'Someone Else' });
  const s = await prisma.stockItem.findUnique({ where: { id: gone.stockId }, select: { seller_name: true } });
  check('  …and the SELLER is refused — it is a term of the deal that fed the margin',
    'refused' in deal && s.seller_name === null, 'refused' in deal ? deal.refused.slice(0, 70) : 'ALLOWED');
  check('  …and the refusal says the VIN can still be corrected, so nobody retries the wrong thing',
    'refused' in deal && /VIN and the colour can\s+still be corrected/.test(deal.refused.replace(/\s+/g, ' ')));
}

// ONE COLUMN, TWO WRITERS — on rows, not in memory.
{
  await ST.updatePurchaseFacts({ ...args(live.stockId), sellerName: null, purchaseRef: null, notOnPaperwork: ['seller_name', 'purchase_ref'] });
  await ST.updateCarFacts({ ...args(live.stockId), vin: null, colour: null, notOnPaperwork: ['vin', 'colour'] });
  const s = await prisma.stockItem.findUnique({ where: { id: live.stockId }, select: { not_on_paperwork: true } });
  check('a car-facts save does not erase the deal-term ticks ON THE ROW',
    ['seller_name', 'purchase_ref', 'vin', 'colour'].every((k) => s.not_on_paperwork.includes(k)),
    s.not_on_paperwork.join(', '));
}

// FILLED AND TICKED IS A CONTRADICTION, and it must be refused by the writer, not only the form.
{
  const r = await ST.updateCarFacts({ ...args(live.stockId), vin: 'ZZFILLVIN0000003', notOnPaperwork: ['vin'] });
  check('the writer refuses a value that is also ticked as absent', 'refused' in r,
    'refused' in r ? r.refused.slice(0, 60) : 'ALLOWED');
}

// AUDITED BOTH WAYS, with before and after — a VIN correction is the kind of change somebody disputes.
{
  const rows = await prisma.auditLog.findMany({
    where: { group_id: ZZ_GROUP, entity_id: live.stockId, action: { in: ['stock.car_facts_edited', 'stock.purchase_edited'] } },
    select: { action: true, diff_json: true },
  });
  check('both edits are audited', rows.some((r) => r.action === 'stock.car_facts_edited') && rows.some((r) => r.action === 'stock.purchase_edited'),
    `${rows.length} rows`);
  // PER FIELD, NOT PER ROW. The first version of this clause asked whether the diff mentioned
  // "from" anywhere, and `notOnPaperwork` always supplies one — so dropping `from` off the VIN
  // entry left it green. A changed field must carry its own before, and the clause has to look at
  // the field that changed.
  const carRow = rows.find((r) => r.action === 'stock.car_facts_edited');
  const dealRow = rows.find((r) => r.action === 'stock.purchase_edited');
  const pair = (d, k) => !!d && typeof d[k] === 'object' && d[k] !== null && 'from' in d[k] && 'to' in d[k];
  check('  …and EVERY changed field carries its own before and after',
    pair(carRow?.diff_json, 'vin') && pair(carRow?.diff_json, 'colour')
    && pair(dealRow?.diff_json, 'sellerName') && pair(dealRow?.diff_json, 'purchaseRef')
    && pair(carRow?.diff_json, 'notOnPaperwork'),
    `vin=${pair(carRow?.diff_json, 'vin')} colour=${pair(carRow?.diff_json, 'colour')} seller=${pair(dealRow?.diff_json, 'sellerName')} ref=${pair(dealRow?.diff_json, 'purchaseRef')}`);
}

// A STOCK RECORD ON ANOTHER TENANT IS NOT THIS TENANT'S TO EDIT.
{
  const r = await ST.updateCarFacts({ groupId: ZZ_GROUP, userId: owner.id, stockItemId: '00000000-0000-0000-0000-000000000000', vin: 'X' });
  check('a stock id that is not on this account is refused', 'refused' in r);
}

// ── AND IT IS ON THE PAGE ─────────────────────────────────────────────────────────────────────
// Everything above would pass with a panel that renders no input at all — which is precisely the
// defect this slice exists for: the book NAMED its gaps and offered no route to close them. So the
// page is driven, and the fields are filled through the real controls.
console.log('\n— the panel is fillable on screen —');
await serverReady();
const origin = gateOrigin();
browser = await chromium.launch({ channel: 'chrome' });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
const pg = await ctx.newPage();
await pg.goto(`${origin}/admin/login`, { waitUntil: 'domcontentloaded' });
await pg.fill('input[type="email"]', 'owner@zzgategarage.test');
await pg.fill('input[type="password"]', 'GateGarage!2026');
await Promise.all([pg.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }), pg.click('button[type="submit"]')]);

// A FRESH car with nothing recorded — the LC09XFU shape, which is what a person actually meets.
const bare = await mk('BARE', false);
await pg.goto(`${origin}/admin/stock/${bare.stockId}`, { waitUntil: 'networkidle' });

check('the book still SAYS what it does not know',
  (await pg.$('[data-testid="stock-book-incomplete"]')) !== null);

// THE GAP, ON SCREEN. A button that offers to fill them is the whole slice.
check('and now offers a route to fill it', (await pg.$('[data-testid="sb-edit-car"]')) !== null);
check('  …and a route for the purchase terms while the car is still in stock',
  (await pg.$('[data-testid="sb-edit-purchase"]')) !== null);

// THE MOT, on the page for a car the garage owns.
{
  // LAID OUT, NOT MERELY PRESENT. `top >= 0` is true of a display:none element and so is "the text
  // node exists": the first version of this clause asked only whether the element was in the DOM.
  const mot = await pg.$eval('[data-testid="sb-mot"]', (el) => {
    const r = el.getBoundingClientRect();
    return { text: el.textContent.trim(), w: Math.round(r.width), h: Math.round(r.height), mounted: !!el.offsetParent };
  }).catch(() => null);
  check('the MOT is shown, laid out, on the page for a car the garage owns',
    !!mot && mot.w > 10 && mot.h > 5 && mot.mounted, mot ? `${mot.w}x${mot.h} mounted=${mot.mounted}` : 'absent');
  check('  …and it is THE CAR\'S expiry, not a placeholder',
    !!mot && mot.text.includes('20 March 2027'), mot?.text.split('\n')[0]);

  // DISCRIMINATING. The absence text is non-empty too, so "is there provenance?" passed on the
  // fallback. These two clauses can only both hold if the panel tells the states apart.
  const prov = await pg.$eval('[data-testid="sb-mot-checked"]', (el) => el.textContent.trim()).catch(() => null);
  check('  …with WHEN DVSA last answered beside it', !!prov && /last answered\s+18 Sep\w* 2026/.test(prov.replace(/\s+/g, ' ')), prov);
  check('  …and a way to ask DVSA again', (await pg.$('[data-testid="sb-mot-refresh"]')) !== null);
}

// AND THE OTHER STATE, so the two cannot be rendered by one branch: a car never checked must SAY
// so rather than print a reassuring blank.
{
  const never = await mk('NOMOT', false, false);
  await pg.goto(`${origin}/admin/stock/${never.stockId}`, { waitUntil: 'networkidle' });
  const mot = await pg.$eval('[data-testid="sb-mot"]', (el) => el.textContent.trim()).catch(() => null);
  const prov = await pg.$eval('[data-testid="sb-mot-checked"]', (el) => el.textContent.trim()).catch(() => null);
  check('a car with no MOT on file says "not recorded", not a blank', !!mot && mot.includes('not recorded'), mot?.split('\n')[0]);
  check('  …and says nobody has asked DVSA, which is a different fact from "expired"',
    !!prov && /never checked/.test(prov), prov);
  await pg.goto(`${origin}/admin/stock/${bare.stockId}`, { waitUntil: 'networkidle' });
}

// FILLING IT THROUGH THE REAL CONTROLS, and reading the row back from the database.
await pg.click('[data-testid="sb-edit-car"]');
await pg.waitForSelector('[data-testid="sb-editor"]', { timeout: 15000 });
await pg.fill('[data-testid="sb-in-vin"]', 'ZZFILLSCREEN00001');
await pg.fill('[data-testid="sb-in-colour"]', 'British Racing Green');
await pg.click('[data-testid="sb-save"]');
/**
 * WAIT FOR THE RENDERED PANEL, NOT A DURATION AND NOT THE DATABASE. These were
 * `waitForTimeout(1500)` — a bet on the machine.
 * The save round-trip plus the re-render fits in 1.5s on an idle box and does not under a full
 * tier's load, so on 2026-10-12 this gate reported "the panel shows 'not recorded'": a true
 * statement about a page that had simply not updated yet. Waiting for the DATABASE was the next wrong answer:
 * the row was already written and it was the PANEL that had not re-rendered, so the DB clauses
 * passed while the two screen clauses failed. Wait for the thing the clause is about.
 */
await pg.waitForFunction(
  ([sel, want]) => document.querySelector(`[data-testid="${sel}"]`)?.textContent?.trim() === want,
  ['sb-vin', 'ZZFILLSCREEN00001'], { timeout: 20000 },
).catch(() => {});
{
  const v = await prisma.vehicle.findUnique({ where: { id: bare.vehicleId }, select: { vin: true, colour: true } });
  check('typing a VIN and a colour INTO THE PANEL writes them to the car',
    v.vin === 'ZZFILLSCREEN00001' && v.colour === 'British Racing Green', `${v.vin} / ${v.colour}`);
  const shown = await pg.$eval('[data-testid="sb-vin"]', (el) => el.textContent.trim()).catch(() => null);
  check('  …and the panel then shows it instead of "not recorded"', shown === 'ZZFILLSCREEN00001', shown);
}

// THE TICK, which is the fact a blank cannot carry.
await pg.click('[data-testid="sb-edit-purchase"]');
await pg.waitForSelector('[data-testid="sb-editor"]', { timeout: 15000 });
await pg.check('[data-testid="sb-tick-seller_name"]');
await pg.fill('[data-testid="sb-in-purchaseRef"]', 'KJM-9001');
await pg.click('[data-testid="sb-save"]');
await pg.waitForFunction(
  ([sel, want]) => document.querySelector(`[data-testid="${sel}"]`)?.textContent?.trim() === want,
  ['sb-seller', PW.NOT_SUPPLIED_WORDS], { timeout: 20000 },
).catch(() => {});
{
  const s = await prisma.stockItem.findUnique({ where: { id: bare.stockId }, select: { not_on_paperwork: true, purchase_ref: true } });
  check('ticking "not on the paperwork" records that somebody LOOKED',
    s.not_on_paperwork.includes('seller_name') && s.purchase_ref === 'KJM-9001',
    `${JSON.stringify(s.not_on_paperwork)} / ${s.purchase_ref}`);
  const sellerShown = await pg.$eval('[data-testid="sb-seller"]', (el) => el.textContent.trim()).catch(() => null);
  check('  …and the book says "not supplied", not "not recorded" — two different facts',
    sellerShown === PW.NOT_SUPPLIED_WORDS, sellerShown);
}

// A SOLD CAR OFFERS EXACTLY WHAT THE WRITER WILL ACCEPT. Offering an input whose save is refused is
// a worse failure than offering none: the person types, presses save and is told no.
await pg.goto(`${origin}/admin/stock/${gone.stockId}`, { waitUntil: 'networkidle' });
check('a SOLD car still offers the VIN and colour editor',
  (await pg.$('[data-testid="sb-edit-car"]')) !== null);
check('  …and does NOT offer the purchase editor',
  (await pg.$('[data-testid="sb-edit-purchase"]')) === null);
check('  …and says why, naming what can still be corrected',
  /terms of the\s+deal/.test(((await pg.$eval('[data-testid="sb-purchase-frozen"]', (el) => el.textContent).catch(() => '')) || '').replace(/\s+/g, ' ')));

} catch (e) {
  check('gate ran to completion', false, describeError(e));
} finally {
  if (browser) await browser.close().catch(() => {});
  try {
    if (prisma && fix) {
      const items = await prisma.stockItem.findMany({ where: { group_id: ZZ_GROUP, vehicle: { registration: { startsWith: PREFIX } } }, select: { id: true } });
      await prisma.stockDisposal.deleteMany({ where: { stock_item_id: { in: items.map((i) => i.id) } } });
      await prisma.stockCost.deleteMany({ where: { stock_item_id: { in: items.map((i) => i.id) } } });
      await prisma.stockItem.deleteMany({ where: { id: { in: items.map((i) => i.id) } } });
      await prisma.vehicle.deleteMany({ where: { group_id: ZZ_GROUP, registration: { startsWith: PREFIX } } });
      const left = await prisma.vehicle.count({ where: { group_id: ZZ_GROUP, registration: { startsWith: PREFIX } } })
        + await prisma.stockItem.count({ where: { group_id: ZZ_GROUP, vehicle: { registration: { startsWith: PREFIX } } } });
      console.log(`residue under ${PREFIX}: ${left}`);
    }
  } catch (e) { console.log(`teardown: ${describeError(e)}`); }
  if (prisma) await prisma.$disconnect().catch(() => {});
}

const fails = out.filter((c) => c === 'F').length;
console.log(`\n${out.length - fails} of ${out.length} clauses pass`);
if (fails) process.exit(1);
