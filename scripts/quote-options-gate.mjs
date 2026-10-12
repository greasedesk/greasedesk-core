/**
 * File: scripts/quote-options-gate.mjs
 * @gate-requires: none
 *
 * OPTIONS ON A QUOTE: cumulative versus exclusive, and a printed page that asks no arithmetic of
 * the customer.
 *
 * ── WHAT THIS IS FOR ────────────────────────────────────────────────────────────────────────────
 * The two kinds look identical on a screen and behave oppositely in arithmetic, so the clause this
 * gate exists for is the one a reader cannot check: that an ADDITION adds and a VARIATION replaces,
 * and that declining every variation is a valid answer rather than an error. The owner's ruling is
 * explicit — "forcing a choice turns a quote into an invoice" — and a default would be invisible
 * until a customer who wanted no service was billed for bronze.
 *
 * Every refusal is planted and watched to fail. A quote is the document a job card, the parts and
 * the invoice all follow from, so a selection this module narrows silently is a selection nobody
 * agreed to.
 */
import './_gate-preflight.mjs';
const { describeError } = await import('./_gate-preflight.mjs');
import './_ts.mjs';

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const R = '/Users/hugh/Developer/greasedesk-core';

try {
  const Q = await import(`${R}/lib/quote-options.ts`);

  const opt = (over = {}) => ({
    id: 'o1', kind: 'addition', groupKey: null, title: 'Water pump', position: 1,
    netPennies: 10000, vatPennies: 2000, grossPennies: 12000, incentive: null, ...over,
  });
  const MAIN = { netPennies: 100000, vatPennies: 20000, grossPennies: 120000 };

  console.log('— TWO KINDS, AND NOTHING ELSE —');
  check('both kinds are accepted', Q.OPTION_KINDS.length === 2 && Q.isOptionKind('addition') && Q.isOptionKind('variation'), Q.OPTION_KINDS.join(', '));
  check('  …and anything else is refused rather than defaulted to one of them',
    !Q.isOptionKind('extra') && !Q.isOptionKind('') && !Q.isOptionKind(null) && !Q.isOptionKind('Addition'));

  console.log('\n— WHAT MAY BE SENT —');
  const clean = [
    opt({ id: 'a1', title: 'Water pump', position: 1 }),
    opt({ id: 'a2', title: 'Clutch and flywheel', position: 2 }),
    opt({ id: 'v1', kind: 'variation', groupKey: 'service', title: 'Bronze', position: 3, grossPennies: 18000 }),
    opt({ id: 'v2', kind: 'variation', groupKey: 'service', title: 'Silver', position: 4, grossPennies: 24000 }),
    opt({ id: 'v3', kind: 'variation', groupKey: 'service', title: 'Gold', position: 5, grossPennies: 36000 }),
  ];
  check('a quote with two additions and three variations is accepted', Q.optionsRefusal(clean) === null, Q.optionsRefusal(clean) ?? 'accepted');
  const bad = [
    ['a variation with no group', [opt({ kind: 'variation', groupKey: null })]],
    ['an addition inside a group', [opt({ groupKey: 'service' })]],
    ['a kind nobody defined', [opt({ kind: 'extra' })]],
    ['no title to choose by', [opt({ title: '  ' })]],
    ['a negative price masquerading as an option', [opt({ grossPennies: -100 })]],
    ['an exclusive group of one', [opt({ id: 'x', kind: 'variation', groupKey: 'service', title: 'Only one' })]],
    ['two options with the same title', [opt({ id: 'a' }), opt({ id: 'b' })]],
    ['an incentive that takes nothing off', [opt({ incentive: { kind: 'amount_off', label: '£0 off', exPennies: 0, vatable: true, grossOffPennies: 0 } })]],
    ['an incentive with no wording', [opt({ incentive: { kind: 'amount_off', label: '', exPennies: 5000, vatable: true, grossOffPennies: 6000 } })]],
    ['a saving off the net bigger than off the total', [opt({ incentive: { kind: 'amount_off', label: '£50 off', exPennies: 6000, vatable: true, grossOffPennies: 5000 } })]],
    ['a VAT-free saving whose two figures disagree', [opt({ incentive: { kind: 'amount_off', label: '£50 off', exPennies: 5000, vatable: false, grossOffPennies: 6000 } })]],
  ];
  const missed = bad.filter(([, set]) => Q.optionsRefusal(set) === null).map(([l]) => l);
  check(`every rule refuses its own case (${bad.length} planted)`, missed.length === 0, missed.join(' | ') || `${bad.length} of ${bad.length} refused`);

  console.log('\n— CUMULATIVE VERSUS EXCLUSIVE —');
  const groups = Q.variationGroups(clean);
  check('variations group by their key, in document order',
    groups.size === 1 && groups.get('service').map((o) => o.title).join('→') === 'Bronze→Silver→Gold',
    [...groups.keys()].join(', '));
  check('  …and an addition is in no group', Q.additions(clean).map((o) => o.title).join(', ') === 'Water pump, Clutch and flywheel');

  const r = (sel) => Q.resolveSelection(MAIN, clean, sel);
  const none = r(Q.emptySelection());
  check('choosing NOTHING is a valid acceptance of the main quote alone',
    none.ok && none.resolution.displayGrossPennies === 120000 && none.resolution.chosenAdditions.length === 0,
    none.ok ? `£${(none.resolution.displayGrossPennies / 100).toFixed(2)}` : none.refusal);
  const both = r({ additionIds: ['a1', 'a2'], variationByGroup: {} });
  check('two additions are CUMULATIVE — the main quote plus both',
    both.ok && both.resolution.displayGrossPennies === 120000 + 12000 + 12000,
    both.ok ? `£${(both.resolution.displayGrossPennies / 100).toFixed(2)}` : both.refusal);
  const gold = r({ additionIds: [], variationByGroup: { service: 'v3' } });
  check('one variation REPLACES rather than adds to the others',
    gold.ok && gold.resolution.displayGrossPennies === 120000 + 36000 && gold.resolution.chosenVariations.length === 1,
    gold.ok ? `£${(gold.resolution.displayGrossPennies / 100).toFixed(2)}` : gold.refusal);
  const mixed = r({ additionIds: ['a1'], variationByGroup: { service: 'v1' } });
  check('  …and a quote may carry both kinds at once',
    mixed.ok && mixed.resolution.displayGrossPennies === 120000 + 12000 + 18000,
    mixed.ok ? `£${(mixed.resolution.displayGrossPennies / 100).toFixed(2)}` : mixed.refusal);

  /** THE OWNER'S RULING. A default would be invisible until somebody was billed for bronze. */
  console.log('\n— DECLINING EVERY VARIATION IS AN ANSWER —');
  const declinedAll = r({ additionIds: [], variationByGroup: { service: null } });
  check('an explicit "none of these" is accepted, not refused',
    declinedAll.ok && declinedAll.resolution.chosenVariations.length === 0
    && declinedAll.resolution.displayGrossPennies === 120000,
    declinedAll.ok ? 'main quote only' : declinedAll.refusal);
  const silent = r({ additionIds: [], variationByGroup: {} });
  check('  …and a group the customer never mentioned means the same thing',
    silent.ok && silent.resolution.chosenVariations.length === 0, silent.ok ? 'treated as none' : silent.refusal);

  console.log('\n— A SELECTION THAT MAKES NO SENSE IS REFUSED, NEVER NARROWED —');
  const unknown = r({ additionIds: ['nope'], variationByGroup: {} });
  check('an option that is no longer on the quote refuses', !unknown.ok, unknown.ok ? 'ACCEPTED' : unknown.refusal);
  check('  …and the refusal tells the customer what to do about it', !unknown.ok && /Ask the garage to send it again/.test(unknown.refusal));
  const twice = r({ additionIds: ['a1', 'a1'], variationByGroup: {} });
  check('the same addition chosen twice refuses, because two is as plausible as a double-click', !twice.ok, twice.ok ? 'ACCEPTED' : twice.refusal);
  const wrongKind = r({ additionIds: ['v1'], variationByGroup: {} });
  check('a variation chosen as an addition refuses', !wrongKind.ok, wrongKind.ok ? 'ACCEPTED' : wrongKind.refusal);
  const stale = r({ additionIds: [], variationByGroup: { tyres: 'v1' } });
  check('a group that is not on this quote refuses', !stale.ok, stale.ok ? 'ACCEPTED' : stale.refusal);

  console.log('\n— THE TWO INCENTIVES DO DIFFERENT ARITHMETIC —');
  const withOff = [
    opt({ id: 'a1', title: 'Water pump', position: 1, incentive: { kind: 'amount_off', label: '£50 off with the main work', exPennies: 5000, vatable: true, grossOffPennies: 6000 } }),
    opt({ id: 'v1', kind: 'variation', groupKey: 'service', title: 'Gold', position: 2, grossPennies: 36000, incentive: { kind: 'included', label: 'a free diagnostic' } }),
    opt({ id: 'v2', kind: 'variation', groupKey: 'service', title: 'Silver', position: 3, grossPennies: 24000 }),
  ];
  const offRes = Q.resolveSelection(MAIN, withOff, { additionIds: ['a1'], variationByGroup: {} });
  check('an amount-off becomes a DISCOUNT LINE with a positive magnitude, as lib/promo expects',
    offRes.ok && offRes.resolution.discounts.length === 1 && offRes.resolution.discounts[0].exPennies === 5000
    && offRes.resolution.discounts[0].vatable === true,
    offRes.ok ? JSON.stringify(offRes.resolution.discounts[0]) : offRes.refusal);
  check('  …and the total falls by the GROSS saving, not the ex-VAT one',
    offRes.ok && offRes.resolution.displayGrossPennies === 120000 + 12000 - 6000,
    offRes.ok ? `£${(offRes.resolution.displayGrossPennies / 100).toFixed(2)} (ex-VAT 5000 would have given £1,270.00)` : offRes.refusal);
  const incRes = Q.resolveSelection(MAIN, withOff, { additionIds: [], variationByGroup: { service: 'v1' } });
  /** THE DISTINCTION. A free diagnostic is GIVEN, not discounted: subtracting its price would make
   *  the bill fall for an item that was never charged for. */
  check('an "included" incentive moves NO money and is named instead',
    incRes.ok && incRes.resolution.discounts.length === 0
    && incRes.resolution.includedLabels.join() === 'a free diagnostic'
    && incRes.resolution.displayGrossPennies === 120000 + 36000,
    incRes.ok ? `£${(incRes.resolution.displayGrossPennies / 100).toFixed(2)}, included: ${incRes.resolution.includedLabels.join()}` : incRes.refusal);
  const untriggered = Q.resolveSelection(MAIN, withOff, { additionIds: [], variationByGroup: { service: 'v2' } });
  check('an incentive on something NOT chosen reaches no total at all',
    untriggered.ok && untriggered.resolution.discounts.length === 0 && untriggered.resolution.includedLabels.length === 0
    && untriggered.resolution.displayGrossPennies === 120000 + 24000,
    untriggered.ok ? `£${(untriggered.resolution.displayGrossPennies / 100).toFixed(2)}` : untriggered.refusal);

  console.log('\n— THE PRINTED PAGE ASKS NO ARITHMETIC —');
  const doc = Q.printedQuote(MAIN, clean);
  const rows = doc.variationGroups[0].rows;
  check('a variation prints a COMPLETE price including the main work',
    rows.map((x) => x.completeGrossPennies).join(',') === '138000,144000,156000',
    rows.map((x) => `${x.title} £${(x.completeGrossPennies / 100).toFixed(2)}`).join(' · '));
  check('  …and not a difference from the cheapest, which a reader adds to the wrong base',
    rows[0].completeGrossPennies !== 18000 && rows[2].completeGrossPennies !== 36000);
  check('an addition prints its own price AND the total with the main work',
    doc.additions[0].ownGrossPennies === 12000 && doc.additions[0].withMainGrossPennies === 132000,
    `own £${(doc.additions[0].ownGrossPennies / 100).toFixed(2)}, with main £${(doc.additions[0].withMainGrossPennies / 100).toFixed(2)}`);
  /** NO GRAND TOTAL WHILE A CHOICE IS OPEN — one big number beside three exclusive prices is the
   *  single most misreadable thing we could print. */
  check('there is NO grand total while a choice is open', doc.grandTotalPennies === null, String(doc.grandTotalPennies));
  check('  …and the page says what is still to decide', doc.openChoices.length === 2 && /which service/.test(doc.openChoices.join('|')), doc.openChoices.join(' · '));
  const plain = Q.printedQuote(MAIN, []);
  check('a quote with no options DOES carry its total, as it always did', plain.grandTotalPennies === 120000, String(plain.grandTotalPennies));
  const offDoc = Q.printedQuote(MAIN, withOff);
  check('a discounted addition prints the price with the saving already in it',
    offDoc.additions[0].withMainGrossPennies === 126000, `£${(offDoc.additions[0].withMainGrossPennies / 100).toFixed(2)}`);
  check('  …and says so, so nobody expects the saving twice',
    /already taken off the price shown/.test(offDoc.additions[0].incentiveNote ?? ''), offDoc.additions[0].incentiveNote);
  check('  …while an included extra is named as included, not as a saving',
    /^Includes a free diagnostic$/.test(offDoc.variationGroups[0].rows[0].incentiveNote ?? ''), offDoc.variationGroups[0].rows[0].incentiveNote);

  console.log('\n— ONE STATED RULE FOR gross_pennies —');
  check('the rule is written down where a reader of the column will find it',
    /MAIN quote as sent, excluding all options/.test(Q.GROSS_PENNIES_MEANS));
  check('  …and it is asserted against the arithmetic, not left as a convention',
    Q.grossAgreesWithRule(120000, MAIN) === true && Q.grossAgreesWithRule(120000 + 36000, MAIN) === false,
    'the main gross agrees; main-plus-options does not');

} catch (e) {
  check('run completed', false, describeError(e).slice(0, 300));
} finally {
  const f = out.filter((x) => x === 'F').length;
  console.log(`\n${f} failures of ${out.length}`);
  process.exit(f ? 1 : 0);
}
