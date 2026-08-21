/**
 * File: scripts/due-items-gate.mjs
 * A FINDING SURVIVES THE JOB IT WAS FOUND ON, and the three-state answer cannot be defaulted away.
 *
 * Fixtures on ZZ Gate Garage only. Never TMBS. Throwaway rows, removed here.
 */
import './_gate-preflight.mjs';
import './_ts.mjs';
const { prisma } = await import('../lib/db.ts');
const { refuseDueItem, responseAtFor, openDueItemsForVehicle, dueLabel, effectiveDueDate, printedDueItemsBlock, closureOffer, closureOffersForCard } = await import('../lib/due-items.ts');
const { readFileSync } = await import('node:fs');

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const OK = { description: 'Front discs and pads', dueBasis: 'mileage', dueMileage: 60000, customerResponse: 'declined' };

// ── 1. THE REFUSALS — a MISSING DECISION, not a missing value ───────────────────────────────────
console.log('\n— the rule can fail —');
check('accepts a complete finding', refuseDueItem(OK) === null);
for (const [label, patch, code] of [
  ['no description', { description: '  ' }, 'no_description'],
  ['NO BASIS CHOSEN — the decision, not the data', { dueBasis: undefined }, 'no_basis'],
  ['basis=date with no date', { dueBasis: 'date', dueDate: null }, 'no_date'],
  ['basis=mileage with no mileage', { dueBasis: 'mileage', dueMileage: null }, 'no_mileage'],
  ['NO RESPONSE CHOSEN — the one that protects the lead list', { customerResponse: undefined }, 'no_response'],
  ['a response outside the three', { customerResponse: 'maybe' }, 'no_response'],
]) {
  const r = refuseDueItem({ ...OK, ...patch });
  check(`refuses ${label}`, r?.code === code, r ? r.code : 'ACCEPTED IT');
}
// THE DISCRIMINATOR: a date AND a mileage both present is legal — the basis decides, so the
// presence of data must not be able to stand in for the decision.
check('a date AND a mileage together is fine — the basis binds, not the data',
  refuseDueItem({ ...OK, dueBasis: 'date', dueDate: new Date('2027-03-01'), dueMileage: 60000 }) === null,
  '"by March, or 60k, whichever first" is a real thing a mechanic says');

// ── 2. not_raised IS AN ABSENCE, NOT AN ANSWER AT TIME-UNKNOWN ─────────────────────────────────
console.log('\n— response_at follows the response —');
const now = new Date('2026-08-19T10:00:00Z');
check('not_raised leaves response_at NULL', responseAtFor('not_raised', now) === null,
  'nobody answered — an absence of an event, not an event we failed to time');
check('declined stamps it', responseAtFor('declined', now) === now);
check('agreed_later stamps it', responseAtFor('agreed_later', now) === now);

// ── 3. NO DEFAULT ANYWHERE IN THE STACK ────────────────────────────────────────────────────────
console.log('\n— the three-state answer cannot be defaulted away —');
const schema = readFileSync('prisma/schema.prisma', 'utf8');
const model = schema.slice(schema.indexOf('model VehicleDueItem'), schema.indexOf('model Vehicle {'));
// PIN THE RULE, NOT THE WHITESPACE. These matched a fixed run of spaces, so `prisma format`
// re-aligning the block — which it does whenever a longer field name joins it — read as "somebody
// added a default". The rule is that the line ends after the type.
const noDefault = (field, type) => new RegExp(`^\\s*${field}\\s+${type}\\s*$`, 'm').test(model);
check('the COLUMN has no default', noDefault('customer_response', 'DueItemResponse'),
  'a @default(not_raised) would make the refusal above unreachable from the database side');
check('and neither does due_basis', noDefault('due_basis', 'DueBasis'));
const ui = readFileSync('components/jobcard/DueItems.tsx', 'utf8');
check('the capture UI starts with NOTHING selected', /useState<typeof RESPONSES\[number\] \| null>\(null\)/.test(ui),
  'a pre-selected radio is how declined would quietly stop happening');
check('  …and Save is disabled until someone chooses', /response !== null/.test(ui));
const api = readFileSync('pages/api/due-items.ts', 'utf8');
check('the API refuses through the SAME predicate, so a forgetful client cannot write a defaulted row',
  /refuseDueItem\(\{/.test(api) && /if \(refusal\) return res\.status\(400\)/.test(api));

// ── 3b. whichever_first — BOTH LEGS, AND THE EARLIER ONE BINDS ─────────────────────────────────
console.log('\n— "due in 10k miles or 11/2025" is one basis, not two —');
const WF = { description: 'Oil service', dueBasis: 'whichever_first', customerResponse: 'not_raised' };
check('accepts when BOTH legs are given',
  refuseDueItem({ ...WF, dueDate: new Date('2025-11-01'), dueMileage: 10000 }) === null);
check('refuses a missing DATE leg', refuseDueItem({ ...WF, dueMileage: 10000 })?.code === 'no_date',
  'one leg alone is a different basis and loses the trigger that would have fired first');
check('refuses a missing MILEAGE leg', refuseDueItem({ ...WF, dueDate: new Date('2025-11-01') })?.code === 'no_mileage');
check('the label states both legs and needs NO rate',
  dueLabel({ dueBasis: 'whichever_first', dueDate: '2025-11-01', dueMileage: 10000 })
    === 'due at 10,000 miles or by 1 November 2025, whichever comes first');
// BOTH date-bearing bases, because the fix had to reach both. This gate previously pinned the raw
// ISO string — and the block assertion below pinned "MOT Expiry 22 September 2024" beside
// "by 2025-11-01", so it was asserting the inconsistency rather than catching it.
check('  …in the same date format the MOT line has always used',
  dueLabel({ dueBasis: 'date', dueDate: '2025-11-01', dueMileage: null }) === 'due by 1 November 2025');

// ── "DUE AT 68,120" IS TRUE OF A CAR ON 68,360 AND UNDERSTATES IT BADLY ────────────────────────
// The customer's own dash says "Service overdue"; the paperwork should be neither more alarming
// than the car nor softer than it. One chokepoint, so the invoice, the customer report and the
// marketing board cannot disagree about the same car.
const OIL = { dueBasis: 'whichever_first', dueDate: '2027-10-01', dueMileage: 68120, dueDatePrecision: 'month' };
const PADS = { dueBasis: 'mileage', dueDate: null, dueMileage: 68120, dueDatePrecision: 'day' };
console.log('\n— overdue is a fact about the mileage leg —');
check('with NO reading supplied the wording is exactly what it always was',
  dueLabel(PADS) === 'due at 68,120 miles'
  && dueLabel(OIL) === 'due at 68,120 miles or by October 2027, whichever comes first',
  'every caller without a reading to compare keeps its old output — this is additive or it is a rewrite');
check('a car short of the target still reads as ahead of it', dueLabel(PADS, 67000) === 'due at 68,120 miles');
check('a car PAST it says by how much', dueLabel(PADS, 68360) === 'overdue by 240 miles — was due at 68,120 miles',
  'the same 240 the dash shows as -240, so the paperwork and the car agree');
check('  …and whichever_first goes past tense with it',
  dueLabel(OIL, 68360) === 'overdue by 240 miles — was due at 68,120 miles or by October 2027, whichever came first',
  '"whichever comes first" beside "was due" would be a sentence arguing with itself');
check('EXACTLY on the target is due, not overdue', dueLabel(PADS, 68120) === 'due now, at 68,120 miles',
  '"overdue by 0 miles" is not a sentence; effectiveDueDate still ranks it as passed, which is the ordering, not the words');
check('the DATE leg is deliberately left alone',
  dueLabel({ dueBasis: 'date', dueDate: '2020-01-01', dueMileage: null }, 99999) === 'due by 1 January 2020',
  'at mint the departure reading is a VISIT fact and can be frozen; whether a date has passed depends on when you read the paper, and an invoice is frozen');

// ── AN ALREADY-PASSED MILEAGE TARGET IS AN ANSWER, NOT A FAILURE ───────────────────────────────
// projectMileageDate returns null once the car is past the target, and reading every null as
// `no_rate` said "we cannot work out when this is due" about a trigger that had ALREADY FIRED.
// Opposite meanings from one code. Now it answers with today.
console.log('\n— past the target is today, not "no rate" —');
const AT = new Date('2026-08-19T00:00:00Z');
const passed = dueLabelCtxPassed();
function dueLabelCtxPassed() {
  return effectiveDueDate(
    { dueBasis: 'mileage', dueDate: null, dueMileage: 45000 },
    { currentMiles: 50000, project: () => null, now: AT },
  );
}
check('a car past its mileage target is due TODAY', passed.ok && passed.date.getTime() === AT.getTime(), JSON.stringify(passed));
check('  …and says so, so a caller can word it as overdue', passed.ok && passed.alreadyPassed === true);
check('  …while a target still ahead with no rate is still a refusal',
  effectiveDueDate({ dueBasis: 'mileage', dueDate: null, dueMileage: 90000 },
    { currentMiles: 50000, project: () => null, now: AT }).reason === 'no_rate',
  'the two were indistinguishable before, which is the defect');
check('whichever_first takes the passed mileage leg over a future date',
  (() => {
    const r = effectiveDueDate({ dueBasis: 'whichever_first', dueDate: new Date('2027-01-01'), dueMileage: 45000 },
      { currentMiles: 50000, project: () => null, now: AT });
    return r.ok && r.alreadyPassed === true && r.binding === 'mileage';
  })(), 'a leg that has already fired is the earlier one whatever the date says');
check('  …and no currentMiles means no claim either way',
  effectiveDueDate({ dueBasis: 'mileage', dueDate: null, dueMileage: 45000 },
    { currentMiles: null, project: () => null, now: AT }).reason === 'no_rate',
  'honest-null: not knowing the mileage is not the same as being past it');

console.log('\n— the projection picks the earlier leg, in both directions —');
const at = (iso) => new Date(`${iso}T00:00:00.000Z`);
const item = { dueBasis: 'whichever_first', dueDate: at('2027-06-01'), dueMileage: 130000 };
// A HIGH-MILEAGE car reaches the mileage first → the mileage binds, and the date would have been LATE.
const hi = effectiveDueDate(item, { currentMiles: 120000, project: () => at('2026-12-01') });
check('a high-mileage car is bound by the MILEAGE', hi.ok && hi.binding === 'mileage' && hi.date.toISOString().slice(0, 10) === '2026-12-01',
  'choosing `date` for this item would have reminded six months late');
// A LOW-MILEAGE car reaches the date first → the date binds, and mileage alone would NEVER have fired.
const lo = effectiveDueDate(item, { currentMiles: 120000, project: () => at('2031-01-01') });
check('a low-mileage car is bound by the DATE', lo.ok && lo.binding === 'date',
  'choosing `mileage` for this item would never have reminded at all');
// NO RATE: the date still BOUNDS it. Not "no answer" — a ceiling, flagged as one.
const nr = effectiveDueDate(item, { currentMiles: null, project: () => null });
check('with no rate the DATE still bounds it, flagged as unevaluated',
  nr.ok && nr.binding === 'date' && nr.mileageLegUnevaluated === true,
  'surfacing a ceiling beats surfacing nothing; the caller is told the mileage leg went unchecked');
check('  …and a mileage-ONLY item with no rate has no date at all',
  effectiveDueDate({ dueBasis: 'mileage', dueDate: null, dueMileage: 130000 }, { currentMiles: 1, project: () => null }).reason === 'no_rate');
check('next_service is not a clock, and says so',
  effectiveDueDate({ dueBasis: 'next_service', dueDate: null, dueMileage: null }, { currentMiles: null, project: () => null }).reason === 'next_service');

// ── 3c. MOT IS NOT A FINDING ───────────────────────────────────────────────────────────────────
console.log('\n— the MOT motive is removed, not policed —');
const ui2 = readFileSync('components/jobcard/DueItems.tsx', 'utf8');
check('the panel shows the DVSA MOT expiry read-only', /data-testid="due-items-mot"/.test(ui2));
check('  …labelled as DVSA-sourced, so there is no reason to retype it',
  /dueItems\.motSource/.test(ui2) && /from DVSA, no need to record it/.test(readFileSync('public/locales/en-GB/jobcard.json', 'utf8')));
check('the description field is still freeform — blocking the string would be theatre',
  // @scan-ok: searching PROSE on purpose — the claim is that the placeholder does not mention an MOT
  /maxLength=\{500\}/.test(ui2) && !/MOT/i.test(ui2.split('data-testid="due-item-desc"')[0].split('placeholder')[1] ?? ''),
  'the fix is removing the motive, not policing the input');

// ── 3d. CAPTURE WHERE THE CAR IS, INFORMATION WHERE THE PRICING IS ─────────────────────────────
// SUPERSEDES the first arrangement, which put the capture panel on Quote. That did not work in
// practice: a mechanic recording findings had to scroll past quote actions, booking and send, and
// an estimator had a form in the way. Two activities, two people, two moments — so the FORM went
// to Intake (where the car is) and a READ-ONLY STRIP stays beside the estimate builder.
console.log('\n— the form at the car, the information at the desk —');
const ws = readFileSync('components/jobcard/JobCardWorkspace.tsx', 'utf8');
const quoteAt = ws.indexOf("active === 'quote' ?");
const intakeAt = ws.indexOf("{active === 'intake' &&");
// SLICED TO THE NEXT PANE, not to a byte count. These were fixed windows — 900 and 1800 characters
// — which is a guess at how long a pane is, and the guess expired: adding two panels pushed
// <SendIntakeReport past the 1800th character, indexOf returned -1, and -1 sorts EARLIEST, so the
// order check failed for a reason that had nothing to do with the order. The same window could as
// easily have produced a false PASS by truncating a component that was genuinely out of place.
const paneEnd = (from) => {
  const next = ws.indexOf("{active === '", from + 1);
  return next === -1 ? ws.length : next;
};
const quotePane = ws.slice(quoteAt, paneEnd(quoteAt));
const intakePane = ws.slice(intakeAt, paneEnd(intakeAt));
check('the CAPTURE panel renders on INTAKE', /<DueItems/.test(intakePane));
check('  …and not on Quote — one form, one home', !/<DueItems\s/.test(quotePane),
  'the form in the estimator\'s way is what made the first arrangement fail');
check('the READ-ONLY strip renders on Quote', /<DueItemsStrip/.test(quotePane),
  'the estimator needs the information, not the form');
check('  …and the strip is genuinely read-only', !/onChange|button/.test(readFileSync('components/jobcard/DueItemsStrip.tsx', 'utf8')),
  'a finding is captured where the car is');
// ORDER on the intake tab: findings, then tyres, then the photos that evidence them, then send.
// REFUSES -1. A missing component is a different failure from a mis-ordered one, and silently
// treating "absent" as "position -1, therefore first" is how the two get confused.
const pos = (needle) => {
  const i = intakePane.indexOf(needle);
  if (i === -1) throw new Error(`${needle} is not on the intake pane at all`);
  return i;
};
check('intake order is findings → spotted-it → tyres → battery → photos → send', (() => {
  const order = ['<DueItems', '<ObservationTaps', '<TyreCapture', '<BatteryCapture', '<PhotoStage', '<SendIntakeReport'].map(pos);
  return order.every((v, i) => i === 0 || v > order[i - 1]);
})(), 'the report carries the photos, so it goes out after them');
const i18nJc = JSON.parse(readFileSync('public/locales/en-GB/jobcard.json', 'utf8'));
check('the tab is called "Intake", not "Intake Photos"', i18nJc.tab.intake === 'Intake',
  'photos are one part of it — findings, tyres and mileage/VIN live there too');

// ── 3e. THE PRINTED BLOCK, AND ITS FREEZE ──────────────────────────────────────────────────────
console.log('\n— the block a customer keeps —');
const block = printedDueItemsBlock({
  motExpiry: new Date('2024-09-22T00:00:00Z'),
  items: [
    { description: 'Oil service', dueBasis: 'whichever_first', dueDate: '2025-11-01', dueMileage: 10000 },
    { description: 'Front brake pads', dueBasis: 'mileage', dueDate: null, dueMileage: 25000 },
  ],
});
check('the MOT leads, numbered, as the garage writes it by hand',
  block.split('\n')[0] === '(1) MOT Expiry 22 September 2024', JSON.stringify(block.split('\n')[0]));
check('findings follow, each with its own timing', /\(2\) Oil service due at 10,000 miles or by 1 November 2025, whichever comes first/.test(block));
// ── ABOUT ISO SPECIFICALLY, NOT ABOUT PRECISION ────────────────────────────────────────────────
// This forbids a raw `2026-11-01` leaking into a block that also says "22 September 2024". It does
// NOT forbid two PRECISIONS: a block may legitimately carry "MOT Expiry 21 August 2026" beside
// "due by November 2026", because the MOT genuinely is a day from DVSA and a manufacturer's service
// interval genuinely is not. Restated because the old wording read as forbidding both.
check('  …and no raw ISO date leaks into a block',
  !/\d{4}-\d{2}-\d{2}/.test(block), block.replace(/\n/g, ' | '));
check('  …while two PRECISIONS in one block are fine', (() => {
  const mixed = printedDueItemsBlock({
    motExpiry: new Date('2026-08-21T00:00:00Z'),
    items: [{ description: 'Next oil service', dueBasis: 'date', dueDate: '2026-11-01', dueMileage: null, timingInDescription: false, dueDatePrecision: 'month' }],
  });
  return /MOT Expiry 21 August 2026/.test(mixed) && /due by November 2026/.test(mixed) && !/1 November/.test(mixed);
})(), 'one is a day DVSA recorded; the other is a month a manufacturer specified');
check('nothing to say → NULL, not an empty block',
  printedDueItemsBlock({ motExpiry: null, items: [] }) === null,
  'an empty string and "nothing captured" must be distinguishable in the column');

console.log('\n— frozen at mint: BOTH halves move afterwards —');
const mintSrc = readFileSync('lib/invoice-issue.ts', 'utf8');
check('the mint writes the block into the row', /due_items_snapshot: dueItemsBlock,/.test(mintSrc));
check('  …built in the SAME tx, from openDueItemsForVehicle(tx, …)', /openDueItemsForVehicle\(tx, groupId/.test(mintSrc));
check('  …and the MOT expiry is selected for it', /mot_expiry: true/.test(mintSrc),
  'DVSA-sourced and it MOVES on retest — a live read prints next year\'s date on last year\'s invoice');
const docSrc = readFileSync('lib/invoice-doc.ts', 'utf8');
check('the document reads the SNAPSHOT unconditionally — no live branch',
  /dueItemsBlock: inv\.due_items_snapshot \?\? null,/.test(docSrc));
// DISCRIMINATING: reg/VIN/mileage DO have a live branch while issued, so "no live branch" is a real
// property of this field and not something every field here happens to have.
check('  …the check is discriminating — reg/VIN DO stay live while issued',
  /inv\.status === 'issued'/.test(docSrc) && /job_card\?\.vehicle\?\.registration/.test(docSrc));
check('both renderers print it', /doc\.dueItemsBlock/.test(readFileSync('lib/invoice-pdf.tsx', 'utf8'))
  && /props\.dueItemsBlock/.test(readFileSync('pages/admin/invoices/[id].tsx', 'utf8')));
// THE GOLDENS MUST NOT MOVE. The banked rule: the hash moves only when a column joins the explicit
// allow-list. June's invoices predate this feature and have nothing to snapshot.
const goldens = readFileSync('scripts/goldens-june.mjs', 'utf8');
check('due_items_snapshot is NOT in INVOICE_FIELDS — June cannot move',
  !/due_items_snapshot/.test(goldens),
  'the hash moves only on an explicit allow-list addition, and June has nothing to snapshot');

// ── 3f. CLOSURE: OFFERED, NEVER AUTOMATIC ───────────────────────────────────────────────────────
console.log('\n— discs today, pads next month —');
check('a finding with no lines is not offered for closing', closureOffer([]).reason === 'no_lines');
// THE CASE THAT DECIDES THE WHOLE DESIGN. Two lines, one invoiced. Auto-closing on invoice would
// clear this finding and lose work the customer has already agreed to buy.
const partial = closureOffer([{ invoiceIssued: true }, { invoiceIssued: false }]);
check('ONE line invoiced of two → NO offer', partial.offer === false && partial.reason === 'work_outstanding',
  'the discs are on an invoice; the pads are next month, and the finding is not finished');
const done = closureOffer([{ invoiceIssued: true }, { invoiceIssued: true }]);
check('every line invoiced → the offer appears', done.offer === true && done.invoicedLines === 2);
check('  …and it is an OFFER, not a closure — nothing here writes', typeof closureOffer === 'function'
  && !/prisma|update|closed_at/.test(closureOffer.toString()),
  'a pure function cannot close anything; a person confirms');

const ui3 = readFileSync('components/jobcard/DueItems.tsx', 'utf8');
check('the card PROMPTS when the offer is on', /due-closure-offer-/.test(ui3) && /closurePrompt/.test(ui3));
// The prompt now names the KIND as well, because closing says why since 2026-08-20 — and this one
// is `fixed` by construction: it only appears when every linked line is on an issued invoice.
check('  …and the prompt is a button a human presses',
  /due-closure-confirm/.test(ui3) && /onClick=\{\(\) => close\(it\.id, 'fixed'\)\}/.test(ui3));
// NOTHING in the invoice path may close a finding.
const issue = readFileSync('lib/invoice-issue.ts', 'utf8');
// RE-AIMED 2026-08-20. This banned the STRING `closed_at` anywhere in the file, and went red when
// the mint began READING closures to print what the visit sorted — it orders them by closed_at.
// Reading is not closing. The rule was always about the WRITE, so that is what is asserted:
// the mint may look at a finding's closure, and may not create one.
check('the MINT never closes a finding',
  !/vehicleDueItem\.(update|updateMany|create|createMany|upsert)/.test(issue),
  'invoicing is not a statement that the car is fine');
check('  …though it may READ them, which is how the work-done block exists',
  /vehicleDueItem\.findMany/.test(issue) && /closed_kind: 'fixed'/.test(issue),
  'the block prints what this visit sorted; printing is not closing');
const statusApi = readFileSync('pages/api/jobcard-status.ts', 'utf8');
check('  …and neither does the invoiced transition', !/closed_at|DueItem/.test(statusApi));

// The link itself: one finding may become several lines.
console.log('\n— one finding, several lines —');
const schema2 = readFileSync('prisma/schema.prisma', 'utf8');
const lineModel = schema2.slice(schema2.indexOf('model DueItemLine'), schema2.indexOf('model VehicleOdometerReading'));
check('the link is a JOIN, not a column on either side', /@@unique\(\[due_item_id, job_card_item_id\]\)/.test(lineModel),
  'one finding can become discs, pads AND the labour to fit them');
check('a deleted estimate line takes only the LINK', /job_card_item\s+JobCardItem\s+@relation[\s\S]*?onDelete: Cascade/.test(lineModel)
  && /The FINDING survives/.test(lineModel),
  'deleting a line is a pricing decision, not a statement that the car is fine');

// ── 3g. THE ADVISORY SITS BELOW THE TOTAL ───────────────────────────────────────────────────────
console.log('\n— nothing above the total but what is being charged for —');
const pdf = readFileSync('lib/invoice-pdf.tsx', 'utf8');
const screen = readFileSync('pages/admin/invoices/[id].tsx', 'utf8');
// POSITION, asserted as an ORDER rather than a line number: the block must come AFTER the grand
// total in the source, which is the order it renders in.
const pdfTotal = pdf.indexOf("t('grandTotal')");
const pdfBlock = pdf.indexOf('doc.dueItemsBlock ?');
check('the PDF renders the advisory AFTER the grand total', pdfTotal > 0 && pdfBlock > pdfTotal,
  'an advisory adjacent to priced rows can read as one of them');
const scTotal = screen.indexOf("t('grandTotal')");
const scBlock = screen.indexOf('props.dueItemsBlock &&');
check('the screen does too', scTotal > 0 && scBlock > scTotal);
check('both carry the "not charged for" heading', /advisory\.heading/.test(pdf) && /advisory\.heading/.test(screen));
const i18nInv = JSON.parse(readFileSync('public/locales/en-GB/invoice.json', 'utf8'));
check('  …and the heading says so in words', /not charged for/i.test(i18nInv.advisory?.heading ?? ''),
  JSON.stringify(i18nInv.advisory?.heading));
// The block is no longer anywhere above the line-item table.
const pdfTableHead = pdf.indexOf('S.tableHead');
check('the PDF has no advisory above the line items', pdfBlock > pdfTableHead);

console.log('\n— and the CONTENT is still frozen —');
check('the snapshot column is untouched by the move', /due_items_snapshot: dueItemsBlock,/.test(readFileSync('lib/invoice-issue.ts', 'utf8')));
check('the document still reads the SNAPSHOT, not a live list',
  /dueItemsBlock: inv\.due_items_snapshot \?\? null,/.test(readFileSync('lib/invoice-doc.ts', 'utf8')));
check('the principle is stated where the next reader will be',
  /FREEZE-AT-ISSUE GOVERNS CONTENT, NOT LAYOUT/.test(pdf),
  'so nobody reads the move as a breach, and nobody freezes a layout version to "fix" it');
check('no layout version was added to the row', !/layout_version|due_items_position/.test(readFileSync('prisma/schema.prisma', 'utf8')),
  'a column that accumulates variants forever to protect something nobody is harmed by');

// ── 3h. IDEMPOTENCY, BECAUSE THE PHONE REPLAYS ──────────────────────────────────────────────────
console.log('\n— a replayed envelope must not become a second finding —');
const api2 = readFileSync('pages/api/due-items.ts', 'utf8');
check('the POST accepts a capture-time id', /id must be a UUID/.test(api2));
check('  …validated as a UUID, never trusted into a key', /\[0-9a-f\]\{8\}-/.test(api2));
check('an existing id is treated as a REPLAY, not an error', /replayed: true/.test(api2)
  && !/status\(409\)[\s\S]{0,120}already exists/i.test(api2),
  'a 409 would make the outbox retry forever');
check('  …and tenant-checked before it is treated as ours', /existing\.group_id !== groupId/.test(api2));
check('the desktop path is unchanged when no id is sent', /clientId \? \{ id: clientId \} : \{\}/.test(api2));

// WHY THE TYRE ENDPOINT NEEDED NO FIX — stated, because the constraint that makes it safe looks
// like tidiness and someone will otherwise drop it.
const schema3 = readFileSync('prisma/schema.prisma', 'utf8');
const tyreModel = schema3.slice(schema3.indexOf('model TyreReading'), schema3.indexOf('model VehicleOdometerReading'));
check('TyreReading has a NATURAL key on (card, corner)', /@@unique\(\[job_card_id, corner\]\)/.test(tyreModel),
  'one car has one front-left tyre per visit, so a replay upserts the same row by construction');
check('  …and the reason it is load-bearing is written down', /natural key/i.test(api2) && /no natural key/i.test(api2),
  'a due item has none: two genuine findings on one card can legitimately read the same');

// ── 4. THE CUSTOMER IS NOT ON THE RECORD ───────────────────────────────────────────────────────
console.log('\n— who to remind is resolved later, never stored —');
check('the model has no customer column', !/customer_id/.test(model),
  'the car may change hands between the finding and the reminder');
// TIGHTENED: the first version tested for the STRING "Customer" and broke the day a
// `customer_answers DueItemCustomerAnswer[]` relation arrived — which is not a link to the Customer
// MODEL at all. The rule is that this table never joins the person; assert the field TYPE.
const customerTypedField = /^\s+\w+\s+Customer(\?|\[\])?\s/m.test(model);
check('  …and no field is typed Customer — it never joins the person', customerTypedField === false);
check('  …the check is discriminating — Vehicle IS joined that way',
  /^\s+vehicle\s+Vehicle\s/m.test(model), 'so the pattern finds a real relation when there is one');
check('the reasoning is recorded where the next reader will be', /never stored, never joined|NEVER STORED HERE|not part of the record/i.test(readFileSync('lib/due-items.ts', 'utf8') + model));

// ── 5. LIVE ON ZZ: it outlives the card ────────────────────────────────────────────────────────
console.log('\n— throwaway fixtures on ZZ Gate Garage —');
let fix = null;
try {
  const site = await prisma.site.findFirst({ where: { group_id: ZZ }, select: { id: true } });
  const veh = await prisma.vehicle.create({ data: { group_id: ZZ, registration: 'ZZ94 DUE', registration_normalized: 'ZZ94DUE' }, select: { id: true } });
  const card = await prisma.jobCard.create({ data: { group_id: ZZ, site_id: site.id, vehicle_id: veh.id, status: 'draft' }, select: { id: true } });
  fix = { vehId: veh.id, cardId: card.id, itemIds: [] };
  const item = await prisma.vehicleDueItem.create({
    data: {
      group_id: ZZ, vehicle_id: veh.id, found_on_job_card_id: card.id,
      description: 'gate: front discs', due_basis: 'mileage', due_mileage: 60000,
      customer_response: 'declined', response_at: new Date(),
    },
    select: { id: true },
  });
  fix.itemIds.push(item.id);

  let open = await openDueItemsForVehicle(prisma, ZZ, veh.id);
  check('the surfacing read returns it', open.length === 1 && open[0].description === 'gate: front discs');
  check('  …with the timing in words', dueLabel(open[0]) === 'due at 60,000 miles', dueLabel(open[0]));
  check('  …and the response, so the lead is visible', open[0].customerResponse === 'declined');

  // THE POINT OF THE WHOLE MODEL: delete the job it was found on; the finding survives.
  await prisma.jobCard.delete({ where: { id: card.id } });
  fix.cardId = null;
  const after = await prisma.vehicleDueItem.findUnique({ where: { id: item.id }, select: { found_on_job_card_id: true } });
  check('DELETING THE CARD does not delete the finding', after !== null,
    'the finding is about the CAR — that is why it is keyed to the vehicle');
  check('  …and the provenance goes NULL rather than dangling', after?.found_on_job_card_id === null,
    'SetNull, not Cascade');
  open = await openDueItemsForVehicle(prisma, ZZ, veh.id);
  check('  …and it still surfaces on the car', open.length === 1);

  // Closing it removes it from the surface, with no status column to disagree with the timestamp.
  await prisma.vehicleDueItem.update({ where: { id: item.id }, data: { closed_at: new Date() } });
  check('a closed item stops surfacing', (await openDueItemsForVehicle(prisma, ZZ, veh.id)).length === 0);
  check('the check is discriminating — the row is still THERE, just closed',
    (await prisma.vehicleDueItem.count({ where: { id: item.id } })) === 1, 'history is kept; only the surface changes');
  // ── 6. THE FREEZE, PROVEN BY MOVING BOTH FACTS ────────────────────────────────────────────────
  // Static checks show the code reads a snapshot; only a mint proves the document does not change
  // when the world does. This burns one number from ZZ's own warranty sequence — deliberate, and
  // the reason the warranty series is used rather than the chargeable one.
  console.log('\n— mint, then move both facts —');
  const site2 = await prisma.site.findFirst({ where: { group_id: ZZ }, select: { id: true } });
  const veh2 = await prisma.vehicle.create({ data: { group_id: ZZ, registration: 'ZZ88 FRZ', registration_normalized: 'ZZ88FRZ', mot_expiry: new Date('2027-09-22T00:00:00Z') }, select: { id: true } });
  const cust2 = await prisma.customer.create({ data: { group_id: ZZ, site_id: site2.id, name: 'Freeze Fixture' }, select: { id: true } });
  const card2 = await prisma.jobCard.create({ data: { group_id: ZZ, site_id: site2.id, customer_id: cust2.id, vehicle_id: veh2.id, status: 'in_progress', is_comeback: true }, select: { id: true } });
  fix.cardId2 = card2.id; fix.vehId2 = veh2.id; fix.custId2 = cust2.id;
  await prisma.jobCardItem.create({ data: { job_card_id: card2.id, item_type: 'labour', description: 'gate: freeze', qty: 1, unit_price: 0, vat_rate: 0 } });
  const keeper = await prisma.vehicleDueItem.create({
    data: { group_id: ZZ, vehicle_id: veh2.id, found_on_job_card_id: card2.id, description: 'gate: rear pads',
            due_basis: 'mileage', due_mileage: 25000, customer_response: 'declined', response_at: new Date() },
    select: { id: true },
  });
  fix.itemIds.push(keeper.id);

  const { issueWarrantyInvoiceForCard } = await import('../lib/invoice-issue.ts');
  const invId = await prisma.$transaction((tx) => issueWarrantyInvoiceForCard(tx, card2.id, ZZ, { goodwill: 'Goodwill', noCharge: 'No charge' }));
  fix.invoiceId = invId;
  const minted = await prisma.invoice.findUnique({ where: { id: invId }, select: { due_items_snapshot: true } });
  check('the mint froze a block naming both facts',
    /MOT Expiry 22 September 2027/.test(minted.due_items_snapshot ?? '') && /rear pads due at 25,000 miles/.test(minted.due_items_snapshot ?? ''),
    JSON.stringify(minted.due_items_snapshot));

  // NOW MOVE THE WORLD. Close the finding, and retest the car.
  await prisma.vehicleDueItem.update({ where: { id: keeper.id }, data: { closed_at: new Date() } });
  await prisma.vehicle.update({ where: { id: veh2.id }, data: { mot_expiry: new Date('2028-09-22T00:00:00Z') } });
  check('the car now has NO open findings', (await openDueItemsForVehicle(prisma, ZZ, veh2.id)).length === 0);
  check('  …and a new MOT expiry', (await prisma.vehicle.findUnique({ where: { id: veh2.id }, select: { mot_expiry: true } })).mot_expiry.getUTCFullYear() === 2028);

  const { buildInvoiceDoc } = await import('../lib/invoice-doc.ts');
  const doc = await buildInvoiceDoc(invId, ZZ);
  check('THE DOCUMENT IS UNCHANGED — still 2027, still the closed finding',
    doc.dueItemsBlock === minted.due_items_snapshot,
    'a reprint must show what the customer received, not what the list says today');
  check('  …specifically, it does NOT show the new MOT date', !/2028/.test(doc.dueItemsBlock ?? ''),
    'the subtler half: MOT expiry moves on retest and a live read would print next year\'s on last year\'s invoice');

} catch (e) {
  check('fixture run completed', false, String(e?.message ?? e).slice(0, 300));
} finally {
  if (fix) {
    if (fix.invoiceId) {
      await prisma.invoiceLine.deleteMany({ where: { invoice_id: fix.invoiceId } }).catch(() => {});
      await prisma.invoice.delete({ where: { id: fix.invoiceId } }).catch(() => {});
    }
    await prisma.vehicleDueItem.deleteMany({ where: { id: { in: fix.itemIds } } });
    if (fix.cardId) await prisma.jobCard.delete({ where: { id: fix.cardId } }).catch(() => {});
    if (fix.cardId2) await prisma.jobCard.delete({ where: { id: fix.cardId2 } }).catch(() => {});
    await prisma.vehicle.delete({ where: { id: fix.vehId } }).catch(() => {});
    const left = await prisma.vehicleDueItem.count({ where: { id: { in: fix.itemIds } } })
      + await prisma.vehicle.count({ where: { id: fix.vehId } });
    check('teardown removed every fixture row (audit rows stay — append-only)', left === 0, `${left} left`);
  }
}

console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
await prisma.$disconnect();
process.exit(out.includes('F') ? 1 : 0);
