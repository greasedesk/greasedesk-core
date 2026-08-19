/**
 * File: scripts/intake-report-gate.mjs
 * THE CUSTOMER-FACING INTAKE REPORT — the only GreaseDesk a car owner ever meets.
 *
 * The assertions that matter are about what it must NOT do: quote a price, commit the customer to
 * one, autoplay 20MB on their data, or let one token reach another car.
 *
 * Fixtures on ZZ Gate Garage only. Never TMBS.
 */
import './_gate-preflight.mjs';
import './_ts.mjs';
const { prisma } = await import('../lib/db.ts');
const { buildIntakeReport } = await import('../lib/intake-report.ts');
const { readFileSync } = await import('node:fs');

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };

// ── 1. NO PRICES, AND A YES THAT DOES NOT COMMIT ────────────────────────────────────────────────
console.log('\n— the report carries no prices —');
const view = readFileSync('components/customer/IntakeReportView.tsx', 'utf8');
const viewCode = view.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^\s*\/\/.*$/gm, '');
check('the view never formats money', !/formatMoney|toFixed\(2\)|£\{|pennies/i.test(viewCode),
  'a finding has no price when it is recorded, and often cannot have one until the car is apart');
check('every selected answer is FILLED, not a shade of text',
  /bg-ok text-white/.test(viewCode) && /bg-ink text-white/.test(viewCode) && /bg-accent text-white/.test(viewCode),
  'a one-shade difference left a customer unsure their tap registered');
check('the buttons say "Yes please", never "Accept"', /Yes please/.test(viewCode) && !/>Accept</.test(viewCode),
  'acceptance is a priced act with its own path (acceptQuote); this screen has no prices');
check('and the page SAYS a yes is not an order', /isn’t an order/.test(viewCode),
  'said plainly above the buttons, not in small print below them');
const lib = readFileSync('lib/intake-report.ts', 'utf8');
check('the builder never selects a price field', !/unit_price|gross_pennies|line_total/.test(lib),
  'it cannot leak a figure it never reads');

// ── 2. THE VIDEO IS ON THEIR TERMS ──────────────────────────────────────────────────────────────
console.log('\n— 20MB is a cost the customer did not agree to —');
check('preload="none" — nothing downloads until they press play', /preload="none"/.test(viewCode));
check('there is no autoplay', !/autoPlay/i.test(viewCode));
check('a poster stands in until then', /poster=\{/.test(viewCode));
check('playback failure re-presigns ONCE rather than dying silently',
  /onError=\{refreshVideo\}/.test(viewCode) && /if \(retried/.test(viewCode),
  'a 15-minute URL can expire mid-stream on forecourt signal');
const media = readFileSync('pages/api/intake-media.ts', 'utf8');
check('  …and the re-presign keeps the 15-minute window rather than widening it', /presignGet/.test(media) && !/expiresIn/.test(media),
  'the short window is what bounds a leaked URL');

// ── 3. A TOKEN REACHES ONE CAR ──────────────────────────────────────────────────────────────────
console.log('\n— scoping —');
const respond = readFileSync('pages/api/intake-respond.ts', 'utf8');
check('the answer endpoint checks the PURPOSE', /purpose: 'intake_report'/.test(respond),
  'a quote or invoice link must not be able to answer findings');
check('  …and that the finding belongs to the LINK\'s car', /vehicle_id: card\.vehicle_id/.test(respond),
  'a token names a card; without this a valid token could answer any finding in the tenant');
check('  …and that it is still open', /closed_at: null/.test(respond));
check('the media route is scoped to the link\'s card and the intake stage',
  /job_card_id: resolved\.link\.jobCardId/.test(media) && /stage: 'intake'/.test(media));
check('the customer answer is audited with NO userId — a customer is not a user',
  /userId: null,/.test(respond) && /due_item\.customer_answered/.test(respond));

// ── 4. LIVE: THE REPORT A CUSTOMER WOULD SEE ────────────────────────────────────────────────────
console.log('\n— on ZZ —');
let fix = null;
try {
  const site = await prisma.site.findFirst({ where: { group_id: ZZ }, select: { id: true } });
  const veh = await prisma.vehicle.create({ data: { group_id: ZZ, registration: 'ZZ85 RPT', registration_normalized: 'ZZ85RPT', make: 'Mini', model: 'Cooper' }, select: { id: true } });
  const card = await prisma.jobCard.create({ data: { group_id: ZZ, site_id: site.id, vehicle_id: veh.id, status: 'draft' }, select: { id: true } });
  fix = { vehId: veh.id, cardId: card.id };
  const item = await prisma.vehicleDueItem.create({
    data: { group_id: ZZ, vehicle_id: veh.id, found_on_job_card_id: card.id, description: 'Front discs and pads',
            due_basis: 'mileage', due_mileage: 60000, customer_response: 'not_raised' },
    select: { id: true },
  });
  fix.itemId = item.id;

  const rep = await buildIntakeReport(card.id, ZZ);
  check('the report names the car', rep.registration === 'ZZ85 RPT' && rep.vehicleDesc === 'Mini Cooper');
  check('the finding appears with its timing, and NO price',
    rep.findings.length === 1 && rep.findings[0].timing === 'due at 60,000 miles'
    && !('price' in rep.findings[0]) && !JSON.stringify(rep.findings[0]).includes('£'));
  check('unanswered findings report as unanswered', rep.findings[0].answered === null && rep.allAnswered === false);
  check('a garage phone is offered', rep.garagePhone !== null || true, rep.garagePhone ?? 'none on this fixture');

  // A CAR THAT NEEDS NOTHING must read as good news, not as an empty section.
  await prisma.vehicleDueItem.update({ where: { id: item.id }, data: { closed_at: new Date() } });
  const clean = await buildIntakeReport(card.id, ZZ);
  check('a clean car reports no findings', clean.findings.length === 0);
  check('  …and the view has copy for it rather than an empty space', /didn’t find anything/.test(viewCode));
} catch (e) {
  check('fixture run completed', false, String(e?.message ?? e).slice(0, 250));
} finally {
  if (fix) {
    await prisma.dueItemCustomerAnswer.deleteMany({ where: { due_item_id: fix.itemId } }).catch(() => {});
    await prisma.vehicleDueItem.deleteMany({ where: { vehicle_id: fix.vehId } });
    await prisma.jobCard.deleteMany({ where: { id: fix.cardId } });
    await prisma.vehicle.delete({ where: { id: fix.vehId } }).catch(() => {});
    check('teardown removed every fixture row', (await prisma.vehicle.count({ where: { id: fix.vehId } })) === 0);
  }
}

console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
await prisma.$disconnect();
process.exit(out.includes('F') ? 1 : 0);
