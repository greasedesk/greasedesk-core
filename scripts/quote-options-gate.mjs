/**
 * File: scripts/quote-options-gate.mjs
 * @gate-requires: none
 *
 * WHAT A QUOTE OFFERS: two group shapes, three incentive shapes, and a page that asks no
 * arithmetic of the customer.
 *
 * ── WHAT THIS IS FOR ────────────────────────────────────────────────────────────────────────────
 * The shapes look identical on a screen and behave oppositely. `pick_one` replaces; the extras in a
 * `base_plus_extras` group ADD, and only while the base is being done — fitting pads on a car that
 * is not in for brakes is an order nothing is holding up. None of that is checkable by reading the
 * page, and a wrong default would be invisible until a customer who wanted no service was billed
 * for bronze. The owner's ruling stands: "forcing a choice turns a quote into an invoice", so a
 * decline is a valid answer to EVERY group and nothing here invents one.
 *
 * `percent_off` adds a trap the other two do not have: a percentage ROUNDS. 1% of £2 is nothing, so
 * the page would promise a saving the bill does not show. The percentage is resolved once, per
 * line, and never recomputed — this gate holds that the pennies are the promise.
 *
 * Every refusal is PLANTED and watched to fail, which is the red-proof: a refusal nobody has seen
 * fire is a refusal that may not fire. A quote is the document the job card, the parts and the
 * invoice all follow from, so a selection this module narrows silently is one nobody agreed to.
 */
import './_gate-preflight.mjs';
const { describeError } = await import('./_gate-preflight.mjs');
import './_ts.mjs';

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const R = '/Users/hugh/Developer/greasedesk-core';

try {
  const Q = await import(`${R}/lib/quote-options.ts`);
  const MAIN = { netPennies: 100000, vatPennies: 20000, grossPennies: 120000 };
  const grp = (over = {}) => ({ id: 'g1', shape: 'pick_one', title: 'Service level', position: 1, ...over });
  const opt = (over = {}) => ({
    id: 'o1', groupId: 'g1', isBase: false, title: 'Bronze', position: 1,
    netPennies: 10000, vatPennies: 2000, grossPennies: 12000, incentive: null, ...over,
  });
  const amountOff = (over = {}) => ({ kind: 'amount_off', label: '£50 off', exPennies: 5000, vatable: true, grossOffPennies: 6000, ...over });
  const percentOff = (over = {}) => ({ kind: 'percent_off', label: '10% off', percentBp: 1000, exPennies: 1000, vatable: true, grossOffPennies: 1200, ...over });
  /** A faithful two-alternative pick_one, and a base-with-extras group, as the happy paths. */
  const PICK = { groups: [grp()], options: [opt({ id: 'a', title: 'Bronze' }), opt({ id: 'b', title: 'Silver', position: 2 })] };
  const BASE = {
    groups: [grp({ id: 'g2', shape: 'base_plus_extras', title: 'Brakes' })],
    options: [
      opt({ id: 'base', groupId: 'g2', isBase: true, title: 'Front discs and pads' }),
      opt({ id: 'x1', groupId: 'g2', title: 'Brake fluid change', position: 2, grossPennies: 6000 }),
    ],
  };

  // ── 1 · THE SHAPES, AND WHAT EACH REFUSES ────────────────────────────────────────────────────
  console.log('\n— two group shapes, and the faults each one has —');
  check('a two-alternative pick_one is sendable', Q.optionsRefusal(PICK.groups, PICK.options) === null,
    Q.optionsRefusal(PICK.groups, PICK.options) ?? 'the positive case, in the same run as the refusals');
  check('a base with extras is sendable', Q.optionsRefusal(BASE.groups, BASE.options) === null,
    Q.optionsRefusal(BASE.groups, BASE.options) ?? 'base + one extra');
  check('  …and a base_plus_extras group with NO base is sendable too', (() => {
    const g = [grp({ id: 'g3', shape: 'base_plus_extras', title: 'You can also add' })];
    return Q.optionsRefusal(g, [opt({ id: 'e1', groupId: 'g3', title: 'Wiper blades' })]) === null;
  })(), 'the base is then the MAIN QUOTE, which is always happening — the unification of the old standalone addition');

  const refuses = (name, groups, options, want) => {
    const r = Q.optionsRefusal(groups, options);
    check(name, typeof r === 'string' && (!want || want.test(r)), r ?? 'ALLOWED — the refusal did not fire');
  };
  refuses('a pick_one with ONE alternative refuses', [grp()], [opt()], /at least two alternatives/);
  refuses('  …and an empty one refuses', [grp()], [], /at least two alternatives/);
  refuses('a base marked inside a pick_one refuses', [grp()],
    [opt({ id: 'a', isBase: true }), opt({ id: 'b', title: 'Silver', position: 2 })], /nothing sits underneath/);
  refuses('two bases in one group refuse', [grp({ shape: 'base_plus_extras' })],
    [opt({ id: 'a', isBase: true }), opt({ id: 'b', title: 'Silver', isBase: true, position: 2 })], /cannot hang off more than one/);
  refuses('a base with no extras refuses', [grp({ shape: 'base_plus_extras' })],
    [opt({ id: 'a', isBase: true })], /option rather than a group/);
  refuses('an option whose group is not on the quote refuses', [grp()],
    [opt({ id: 'a' }), opt({ id: 'b', title: 'Silver', position: 2 }), opt({ id: 'c', title: 'Stray', groupId: 'nope', position: 3 })],
    /group that is not on this quote/);
  refuses('a group with no shape refuses', [grp({ shape: 'sideways' })], PICK.options, /no shape/);
  refuses('a group with no title refuses', [grp({ title: '  ' })], PICK.options, /no title/);
  refuses('an option with no title refuses', [grp()], [opt({ title: ' ' }), opt({ id: 'b', title: 'Silver', position: 2 })], /no title/);
  refuses('a negative price refuses', [grp()],
    [opt({ grossPennies: -1 }), opt({ id: 'b', title: 'Silver', position: 2 })], /a reduction is a discount/);
  refuses('two options with the same title refuse', [grp()],
    [opt({ id: 'a', title: 'Silver' }), opt({ id: 'b', title: 'silver ', position: 2 })], /cannot say which they meant/);

  // ── 2 · THE THIRD INCENTIVE SHAPE ────────────────────────────────────────────────────────────
  console.log('\n— percent_off, which is the one that can round away —');
  const withInc = (inc) => [opt({ id: 'a', incentive: inc }), opt({ id: 'b', title: 'Silver', position: 2 })];
  check('a sound percent_off is sendable', Q.optionsRefusal([grp()], withInc(percentOff())) === null,
    Q.optionsRefusal([grp()], withInc(percentOff())) ?? '10% off, resolved to 1000/1200');
  refuses('a percentage of nothing refuses', [grp()], withInc(percentOff({ percentBp: 0 })), /percentage of nothing/);
  refuses('100% or more refuses as “included”, not a discount', [grp()], withInc(percentOff({ percentBp: 10000 })), /which is “included”/);
  refuses('A PERCENTAGE THAT ROUNDS AWAY refuses, and says so', [grp()],
    withInc(percentOff({ exPennies: 0, grossOffPennies: 0 })), /rounds away to nothing/);
  refuses('amount_off taking nothing refuses', [grp()], withInc(amountOff({ exPennies: 0 })), /takes nothing off/);
  refuses('gross off below net off refuses', [grp()], withInc(amountOff({ grossOffPennies: 4000 })), /more off the net than off the total/);
  refuses('non-vatable with a different gross refuses', [grp()], withInc(amountOff({ vatable: false, grossOffPennies: 6000 })), /must equal the saving off the net/);
  refuses('taking more off than the option costs refuses', [grp()],
    withInc(amountOff({ exPennies: 20000, grossOffPennies: 24000 })), /more off than the option costs/);
  refuses('an incentive with no wording refuses', [grp()], withInc(percentOff({ label: ' ' })), /no wording/);

  console.log('\n— and the percentage is resolved ONCE, per line —');
  check('per-line rounding, then summed', Q.resolvePercentOff(1000, [333, 333, 333]) === 99,
    `${Q.resolvePercentOff(1000, [333, 333, 333])}p — 10% of 333p is 33.3p, which rounds to 33p, three times`);
  check('  …AND IT DIFFERS from rounding the option total', (() => {
    const perLine = Q.resolvePercentOff(1000, [333, 333, 333]);   // 99
    const wholeTotal = Math.round((999 * 1000) / 10000);          // 100
    return perLine === 99 && wholeTotal === 100 && perLine !== wholeTotal;
  })(), 'per line 99p, the total 100p — a penny apart, and the lines are what the customer is reading');
  check('  …and a percentage can round away entirely', Q.resolvePercentOff(100, [200]) === 2 && Q.resolvePercentOff(1, [200]) === 0,
    'which is why optionsRefusal has a clause for it rather than printing it');

  // ── 3 · WHAT A CUSTOMER CAN SAY ──────────────────────────────────────────────────────────────
  console.log('\n— a decline is a valid answer to every group —');
  const res = (fix, sel) => Q.resolveSelection(MAIN, fix.groups, fix.options, { byGroup: sel });
  const empty = res(PICK, {});
  check('choosing nothing resolves, and the total is the main quote',
    empty.ok && empty.resolution.chosen.length === 0 && empty.resolution.displayGrossPennies === MAIN.grossPennies,
    empty.ok ? String(empty.resolution.displayGrossPennies) : empty.refusal);
  const none = res(PICK, { g1: [] });
  check('  …and an explicit empty list is the same answer', none.ok && none.resolution.chosen.length === 0);
  const one = res(PICK, { g1: ['b'] });
  check('one alternative adds its own price', one.ok && one.resolution.displayGrossPennies === 132000,
    one.ok ? String(one.resolution.displayGrossPennies) : one.refusal);

  const refusesSel = (name, fix, sel, want) => {
    const r = res(fix, sel);
    check(name, !r.ok && (!want || want.test(r.refusal)), r.ok ? 'RESOLVED — the refusal did not fire' : r.refusal);
  };
  refusesSel('two from a pick_one refuses', PICK, { g1: ['a', 'b'] }, /choice of one/);
  refusesSel('the same option twice refuses', PICK, { g1: ['a', 'a'] }, /chosen twice/);
  refusesSel('an option from another group refuses', PICK, { g1: ['base'] }, /no longer on this quote/);
  refusesSel('an unknown option refuses', PICK, { g1: ['ghost'] }, /no longer on this quote/);
  refusesSel('a group the quote does not have refuses', PICK, { gone: ['a'] }, /no longer on this quote/);

  console.log('\n— and an extra needs the base it hangs off —');
  refusesSel('AN EXTRA WITHOUT ITS BASE REFUSES', BASE, { g2: ['x1'] }, /need “Front discs and pads” as well/);
  const both = res(BASE, { g2: ['base', 'x1'] });
  check('  …and with the base it resolves', both.ok && both.resolution.chosen.length === 2,
    both.ok ? `${both.resolution.displayGrossPennies}` : both.refusal);
  const baseOnly = res(BASE, { g2: ['base'] });
  check('  …the base alone is fine', baseOnly.ok && baseOnly.resolution.chosen.length === 1);
  check('  …and in a group with NO base, an extra stands alone', (() => {
    const fix = { groups: [grp({ id: 'g3', shape: 'base_plus_extras', title: 'Also' })],
      options: [opt({ id: 'e1', groupId: 'g3', title: 'Wipers' })] };
    const r = res(fix, { g3: ['e1'] });
    return r.ok && r.resolution.chosen.length === 1;
  })(), 'the main quote is the base, and it is always happening');

  // ── 4 · THE SAVINGS FIGURE ───────────────────────────────────────────────────────────────────
  console.log('\n— what they saved, and what is only stated —');
  const savings = (inc) => {
    const fix = { groups: [grp({ id: 'g4', shape: 'base_plus_extras', title: 'Also' })],
      options: [opt({ id: 'e1', groupId: 'g4', title: 'Service', incentive: inc })] };
    return res(fix, { g4: ['e1'] });
  };
  const sAmount = savings(amountOff());
  check('amount_off counts toward the savings', sAmount.ok && sAmount.resolution.savingsGrossPennies === 6000,
    sAmount.ok ? String(sAmount.resolution.savingsGrossPennies) : sAmount.refusal);
  const sPercent = savings(percentOff());
  check('percent_off counts toward it too', sPercent.ok && sPercent.resolution.savingsGrossPennies === 1200);
  const sIncluded = savings({ kind: 'included', label: 'a free diagnostic' });
  check('INCLUDED COUNTS NOTHING toward the figure', sIncluded.ok && sIncluded.resolution.savingsGrossPennies === 0,
    'a saving the invoice does not show is a figure that will not match it');
  check('  …but it IS stated, as its own line', sIncluded.ok && sIncluded.resolution.includedLabels.length === 1
    && /free diagnostic/.test(sIncluded.resolution.includedLabels[0]),
    sIncluded.ok ? sIncluded.resolution.includedLabels.join(', ') : '');
  check('  …and it does not move the total', sIncluded.ok && sIncluded.resolution.displayGrossPennies === MAIN.grossPennies + 12000);
  check('the discount reaches the caller as a POSITIVE magnitude', sAmount.ok
    && sAmount.resolution.discounts.length === 1 && sAmount.resolution.discounts[0].exPennies === 5000,
    'lib/promo stores it as the negative line; a negative here would be double-negated');
  check('the savings figure is the sum, not the last one', (() => {
    const fix = { groups: [grp({ id: 'g5', shape: 'base_plus_extras', title: 'Also' })],
      options: [opt({ id: 'e1', groupId: 'g5', title: 'A', incentive: amountOff() }),
        opt({ id: 'e2', groupId: 'g5', title: 'B', position: 2, incentive: percentOff() })] };
    const r = res(fix, { g5: ['e1', 'e2'] });
    return r.ok && r.resolution.savingsGrossPennies === 7200;
  })(), '6000 + 1200');

  // ── 5 · THE PRINTED PAGE ─────────────────────────────────────────────────────────────────────
  console.log('\n— and the printed page asks no arithmetic —');
  const pPick = Q.printedQuote(MAIN, PICK.groups, PICK.options);
  check('a pick_one row carries the COMPLETE price', pPick.groups[0].rows.every((r) => r.completeGrossPennies === 132000),
    'never a difference from the cheapest, which a reader adds to the wrong base');
  const pBase = Q.printedQuote(MAIN, BASE.groups, BASE.options);
  check('inside a group WITH a base there is no complete price', pBase.groups[0].rows.every((r) => r.completeGrossPennies === null),
    '"complete" would depend on the base and on which other extras are ticked — a different total for every reader');
  check('  …and every row still carries its OWN price', pBase.groups[0].rows.every((r) => r.ownGrossPennies > 0));
  check('no grand total while a choice is open', pPick.grandTotalPennies === null && pPick.openChoices.length === 1,
    pPick.openChoices.join(' and '));
  check('with no groups at all the total is the main quote', (() => {
    const p = Q.printedQuote(MAIN, [], []);
    return p.grandTotalPennies === MAIN.grossPennies && p.openChoices.length === 0;
  })());
  check('an incentive prints as an offer, never as a number in a total', (() => {
    const note = Q.incentiveNote({ incentive: percentOff() });
    const inc = Q.incentiveNote({ incentive: { kind: 'included', label: 'a free diagnostic' } });
    return /already taken off/.test(note) && /^Includes /.test(inc) && Q.incentiveNote({ incentive: null }) === null;
  })());

  // ── 6 · ONE TRANSLATION FROM A STORED ROW ────────────────────────────────────────────────────
  console.log('\n— and a stored row becomes an incentive in exactly one place —');
  const row = (over = {}) => ({
    incentive_kind: null, incentive_label: null, incentive_ex_pennies: null,
    incentive_vatable: null, incentive_gross_off_pennies: null, incentive_percent_bp: null, ...over,
  });
  check('no incentive reads as none', Q.incentiveFromRow(row()) === null);
  check('a percent_off row keeps its basis points', (() => {
    const i = Q.incentiveFromRow(row({ incentive_kind: 'percent_off', incentive_label: '10% off',
      incentive_percent_bp: 1000, incentive_ex_pennies: 1000, incentive_vatable: true, incentive_gross_off_pennies: 1200 }));
    return i.kind === 'percent_off' && i.percentBp === 1000 && i.grossOffPennies === 1200;
  })(), 'the percentage is the wording and the re-editable input; the pennies are the promise');
  check('AN UNKNOWN KIND THROWS rather than reading as “no incentive”', (() => {
    try { Q.incentiveFromRow(row({ incentive_kind: 'buy_one_get_one' })); return false; }
    catch (e) { return /UNKNOWN_INCENTIVE_KIND/.test(String(e.message)); }
  })(), 'a null would print a quote with a discount it promised silently missing');
  check('an option row with no group gets a group of its own, and is then NAMED', (() => {
    const o = Q.optionFromRow({ ...row(), id: 'o9', group_id: null, is_base: false, title: 'Orphan',
      position: 1, net_pennies: 100, vat_pennies: 20, gross_pennies: 120 });
    return o.groupId === 'ungrouped:o9' && /group that is not on this quote/.test(Q.optionsRefusal([], [o]) ?? '');
  })(), 'dropping it would be a silent omission; this makes it a visible fault');

  console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
} catch (e) {
  check('run completed', false, describeError(e));
  console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
}
process.exit(out.includes('F') ? 1 : 0);
