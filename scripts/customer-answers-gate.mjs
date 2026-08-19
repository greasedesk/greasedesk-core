/**
 * File: scripts/customer-answers-gate.mjs
 * TWO RECORDS, ONE ESTIMATE — and a disagreement that stays legible.
 *
 * The rule this defends:
 *   the CUSTOMER's record is authoritative about WHAT THE CUSTOMER SAID;
 *   the GARAGE's field is authoritative about WHAT THE GARAGE WILL ACT ON.
 * Merged into one column the product loses the ability to show "they tapped no, then rang and said
 * yes" — and that is exactly the sort of thing someone simplifies away in a year.
 *
 * Fixtures on ZZ Gate Garage only. Never TMBS.
 */
import './_gate-preflight.mjs';
import './_ts.mjs';
const { prisma } = await import('../lib/db.ts');
const { GARAGE_VIEW_OF, answerDivergence, recordCustomerAnswer, latestCustomerAnswers } = await import('../lib/due-items.ts');
const { readFileSync } = await import('node:fs');

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };

// ── 1. YES IS INTEREST, NOT ACCEPTANCE ──────────────────────────────────────────────────────────
console.log('\n— the report carries no prices, so a yes cannot mean agreement to one —');
check('yes → agreed_later', GARAGE_VIEW_OF.yes === 'agreed_later',
  '"quote me for this" — the estimate still goes out and comes back through acceptQuote');
check('no → declined', GARAGE_VIEW_OF.no === 'declined');
check('call_me → wants_call, its own state', GARAGE_VIEW_OF.call_me === 'wants_call',
  'not not_raised (they WERE asked), not declined, not agreed_later');
check('no answer maps to `accepted` or anything acceptance-shaped',
  !Object.values(GARAGE_VIEW_OF).some((v) => /accept/.test(v)),
  'a priced acceptance has one path and it is not this one');

// ── 2. THE DIVERGENCE, WHICH IS NORMAL ──────────────────────────────────────────────────────────
console.log('\n— they tapped no, then rang and changed their mind —');
const at = new Date('2026-08-19T10:00:00Z');
check('agreement is not a divergence',
  answerDivergence({ answer: 'no', answeredAt: at }, 'declined').diverged === false);
const d = answerDivergence({ answer: 'no', answeredAt: at }, 'agreed_later');
check('a staff override IS a divergence, and carries both sides', d.diverged === true && d.customer === 'no' && d.garage === 'agreed_later',
  'shown inline before the override and permanently on the finding afterwards');
check('no customer answer at all → nothing to diverge from', answerDivergence(null, 'declined') === null);
// THE ALERT QUESTION, answered structurally: nothing in this path can notify.
const lib = readFileSync('lib/due-items.ts', 'utf8');
check('the divergence path CANNOT alert — it never touches sendNotification',
  !/sendNotification/.test(lib),
  'the person who creates a divergence is the person doing it deliberately; telling them is noise');
check('and the reasoning is recorded where the next reader will be',
  /notifying them about their own action is the noise/i.test(lib) || /notifying that person about their own action is noise/i.test(readFileSync('prisma/schema.prisma', 'utf8')));

// ── 3. THE MODEL SAYS WHY, IN TERMS ─────────────────────────────────────────────────────────────
console.log('\n— the rule is in the schema, not only in a commit message —');
const schema = readFileSync('prisma/schema.prisma', 'utf8');
const model = schema.slice(schema.indexOf('model DueItemCustomerAnswer'), schema.indexOf('model VehicleOdometerReading'));
check('the schema states which record is authoritative for what',
  /authoritative about WHAT THE CUSTOMER SAID/.test(schema) && /authoritative about WHAT THE GARAGE\n\/\/\/   WILL ACT ON/.test(schema));
check('  …and that the estimate builds from the GARAGE field', /The GARAGE field, always/.test(schema));
check('  …and that a merge would be a loss, not a simplification', /LEGIBLE RATHER THAN IMPOSSIBLE/.test(schema));
check('the customer table is append-only by intent', /APPEND-ONLY/.test(model));

// ── 4. LIVE: APPEND, WRITE THROUGH, OVERRIDE ────────────────────────────────────────────────────
console.log('\n— on ZZ: the full sequence —');
let fix = null;
try {
  const site = await prisma.site.findFirst({ where: { group_id: ZZ }, select: { id: true } });
  const veh = await prisma.vehicle.create({ data: { group_id: ZZ, registration: 'ZZ86 ANS', registration_normalized: 'ZZ86ANS' }, select: { id: true } });
  const card = await prisma.jobCard.create({ data: { group_id: ZZ, site_id: site.id, vehicle_id: veh.id, status: 'draft' }, select: { id: true } });
  const item = await prisma.vehicleDueItem.create({
    data: { group_id: ZZ, vehicle_id: veh.id, found_on_job_card_id: card.id, description: 'gate: discs',
            due_basis: 'next_service', customer_response: 'not_raised' },
    select: { id: true },
  });
  fix = { vehId: veh.id, cardId: card.id, itemId: item.id };

  // The customer taps NO.
  await prisma.$transaction((tx) => recordCustomerAnswer(tx, { groupId: ZZ, dueItemId: item.id, answer: 'no', magicLinkId: null, at: new Date('2026-08-19T10:00:00Z') }));
  let g = await prisma.vehicleDueItem.findUnique({ where: { id: item.id }, select: { customer_response: true, response_at: true } });
  check('the answer WRITES THROUGH to the garage field', g.customer_response === 'declined');
  check('  …and stamps response_at, because an answer is an event', g.response_at !== null);
  let latest = await latestCustomerAnswers(prisma, [item.id]);
  check('the customer record holds their own tap', latest.get(item.id).answer === 'no');
  check('  …and they do NOT diverge yet', answerDivergence(latest.get(item.id), g.customer_response).diverged === false);

  // The garage takes a phone call and records the opposite.
  await prisma.vehicleDueItem.update({ where: { id: item.id }, data: { customer_response: 'agreed_later' } });
  g = await prisma.vehicleDueItem.findUnique({ where: { id: item.id }, select: { customer_response: true } });
  latest = await latestCustomerAnswers(prisma, [item.id]);
  check('a staff override changes ONLY the garage field', g.customer_response === 'agreed_later' && latest.get(item.id).answer === 'no',
    'what the customer tapped is untouched — that is the whole point');
  check('  …and the divergence is now visible', answerDivergence(latest.get(item.id), g.customer_response).diverged === true);

  // The customer changes their mind on the same report — APPEND, not update.
  await prisma.$transaction((tx) => recordCustomerAnswer(tx, { groupId: ZZ, dueItemId: item.id, answer: 'yes', magicLinkId: null, at: new Date('2026-08-19T14:00:00Z') }));
  const rows = await prisma.dueItemCustomerAnswer.count({ where: { due_item_id: item.id } });
  check('a second answer APPENDS — the history survives', rows === 2, `${rows} rows`);
  latest = await latestCustomerAnswers(prisma, [item.id]);
  check('  …and "latest" is the newest, not the first', latest.get(item.id).answer === 'yes');
  g = await prisma.vehicleDueItem.findUnique({ where: { id: item.id }, select: { customer_response: true } });
  check('  …which writes through again, resolving the divergence', g.customer_response === 'agreed_later'
    && answerDivergence(latest.get(item.id), g.customer_response).diverged === false);
} catch (e) {
  check('fixture run completed', false, String(e?.message ?? e).slice(0, 250));
} finally {
  if (fix) {
    await prisma.dueItemCustomerAnswer.deleteMany({ where: { due_item_id: fix.itemId } });
    await prisma.vehicleDueItem.deleteMany({ where: { id: fix.itemId } });
    await prisma.jobCard.deleteMany({ where: { id: fix.cardId } });
    await prisma.vehicle.delete({ where: { id: fix.vehId } }).catch(() => {});
    check('teardown removed every fixture row', (await prisma.vehicle.count({ where: { id: fix.vehId } })) === 0);
  }
}

console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
await prisma.$disconnect();
process.exit(out.includes('F') ? 1 : 0);
