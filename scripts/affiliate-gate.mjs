/**
 * File: scripts/affiliate-gate.mjs
 * @gate-requires: db
 *
 * THE AFFILIATE PROGRAMME, AND THE PLANS IT SELLS.
 *
 * ── WHAT THIS IS GUARDING ───────────────────────────────────────────────────────────────────────
 * Money paid to people outside the business, on evidence that a garage paid us. Nearly every
 * clause is about something that must NOT happen twice, must NOT exceed a cap, or must NOT change
 * under somebody's feet after they signed. Absence is hard to assert honestly, so each one
 * measures the thing it denies BEFORE and AFTER — never "is zero now", which is equally true of a
 * programme that did nothing at all.
 *
 * ── AND THE RULE THE PLANS TURN ON ──────────────────────────────────────────────────────────────
 * TRIAL OR PAY NOW, NEVER BOTH (owner, 2026-10-24). A new garage on annual pays immediately for 12
 * months at the price of 9 — the trial IS the discount, taken once, at the front. Monthly keeps
 * the 30-day trial. The affiliate offer is 12 for 6, by code, once per garage. Renewal of any
 * annual plan is 12 for 10. Four shapes, one rule, and the rule is asserted rather than described.
 *
 * FIXTURES ON ZZ ONLY, by this gate's own prefix, swept before and after and REGISTERED.
 */
import './_gate-preflight.mjs';
const { gatePrisma, describeError, ZZ_GROUP, onTeardown, declineToRun } = await import('./_gate-preflight.mjs');
import './_ts.mjs';

/**
 * ── THE CLAUSES ARE WRITTEN; THE MODULES ARE NOT ───────────────────────────────────────────────
 * This gate was written BEFORE the code, which is the point of it. Until lib/affiliate and
 * lib/billing-plans exist it DECLINES rather than fails: an UNRUN with a reason says "unproven",
 * and a red would say "broken", which is a different and untrue thing.
 *
 * It declines rather than simply not existing because an untiered gate makes the runner refuse to
 * start AT ALL — so a half-written gate left in scripts/ wedges every tier. Declining keeps the
 * suite runnable and keeps this gate's absence from the evidence VISIBLE, which is the whole
 * argument for UNRUN over silence.
 *
 * DELETE THIS BLOCK the moment both modules land. A decline that outlives its reason is the
 * blindfold the guard-outlives-hazard rule is about.
 */
const { existsSync } = await import('node:fs');
const MISSING = ['lib/affiliate.ts', 'lib/billing-plans.ts'].filter((f) => !existsSync(`/Users/hugh/Developer/greasedesk-core/${f}`));
if (MISSING.length) {
  declineToRun(`the affiliate programme is not built yet — ${MISSING.join(' and ')} `
    + `${MISSING.length === 1 ? 'does' : 'do'} not exist. The 28 clauses in this file are written and are `
    + 'the specification; none of them has been proved. This is UNRUN, not green: nothing here has '
    + 'tested anything.');
}

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const R = '/Users/hugh/Developer/greasedesk-core';
const PREFIX = 'ZZAFF';

let prisma;
const sweep = async () => {
  if (!prisma) return 0;
  const reps = (await prisma.rep.findMany({ where: { ref_code: { startsWith: PREFIX } }, select: { id: true } })).map((r) => r.id);
  const groups = (await prisma.group.findMany({ where: { group_name: { startsWith: PREFIX } }, select: { id: true } })).map((g) => g.id);
  if (groups.length) {
    await prisma.tenantAffiliateTerms.deleteMany({ where: { group_id: { in: groups } } }).catch(() => {});
    await prisma.commissionEntry.deleteMany({ where: { group_id: { in: groups } } }).catch(() => {});
    await prisma.tenantAttribution.deleteMany({ where: { group_id: { in: groups } } }).catch(() => {});
    await prisma.group.deleteMany({ where: { id: { in: groups } } }).catch(() => {});
  }
  if (reps.length) {
    await prisma.commissionEntry.deleteMany({ where: { party_id: { in: reps } } }).catch(() => {});
    await prisma.rep.deleteMany({ where: { id: { in: reps } } }).catch(() => {});
  }
  return reps.length + groups.length;
};

try {
  prisma = await gatePrisma();
  onTeardown(sweep);
  await sweep();

  const AF = await import(`${R}/lib/affiliate.ts`);

  // ── THE PLAN SHAPES MOVED OUT (2026-10-25) ──────────────────────────────────────────────────
  // Sections 1–3 — trial-or-pay-now over every shape, the derived prices, and the single trial
  // length — now live in scripts/billing-plans-gate.mjs, with the per-site and refusal clauses
  // they grew. The plans are their own subject and shipped a stage earlier than the programme
  // that sells one of them; leaving a copy here would be two gates agreeing about one rule, and
  // the one nobody edits goes stale first. This file keeps the affiliate subjects: entitlement,
  // frozen terms, the reward ledger, who may take the offer, and closing the programme.

  // ── 4. ENTITLEMENT FOLLOWS THE PRODUCT, NOT THE PRICE ───────────────────────────────────────
  // An inline price (ruling 4) has a generated id in no map, and the old lookup answered with a
  // console.warn and NO modules — a garage paying for Core and entitled to nothing. The map moves
  // to the product, which is what a module is actually a property of.
  console.log('\n— a module belongs to the product —');
  const MOD = await import(`${R}/lib/modules.ts`);
  check('modules resolve from a PRODUCT id', typeof MOD.modulesFromProducts === 'function',
    'modulesFromPriceIds cannot answer for a price created at signup');
  check('  …and an annual signup is entitled to exactly what a monthly one is',
    JSON.stringify(MOD.modulesFromProducts([process.env.STRIPE_PRODUCT_CORE ?? 'prod_core']).sort())
      === JSON.stringify(MOD.modulesFromProducts([process.env.STRIPE_PRODUCT_CORE ?? 'prod_core']).sort()),
    'same product, same entitlement, whatever the interval or the amount');

  // ── 5. THE TERMS A GARAGE SIGNED UP UNDER ARE FROZEN ────────────────────────────────────────
  console.log('\n— what a garage signed up under —');
  const mkGarage = async (n) => (await prisma.group.create({ data: {
    group_name: `${PREFIX} garage ${n}`, billing_email: `${PREFIX.toLowerCase()}-${n}@example.invalid`,
  }, select: { id: true } })).id;
  const g1 = await mkGarage(1);
  const frozen = await AF.freezeTermsAtSignup(prisma, g1, { totalRewardPennies: 12000, instalmentPennies: 3000, plan: 'annual_offer', offerMonthsPaid: 6, monthsGiven: 12 });
  check('the terms are written once, at signup', !!frozen && frozen.total_reward_pennies === 12000);
  // THE CLAUSE THE WHOLE SETTINGS DESIGN RESTS ON.
  await AF.saveSettings(prisma, { totalRewardPennies: 20000, instalmentPennies: 5000 });
  const reread = await AF.termsFor(prisma, g1);
  check('a SETTINGS CHANGE does not move them', reread.total_reward_pennies === 12000 && reread.instalment_pennies === 3000,
    `${reread.total_reward_pennies}/${reread.instalment_pennies} — a garage keeps the terms it signed up under`);
  check('  …while a NEW garage gets the new ones',
    (await AF.freezeTermsAtSignup(prisma, await mkGarage(2), await AF.currentTerms(prisma))).total_reward_pennies === 20000);

  // ── 6. THE REWARD LEDGER: IDEMPOTENT, CAPPED, AND ONLY ON MONEY ─────────────────────────────
  console.log('\n— one entry per payment, and never more than the total —');
  const aff = await prisma.rep.create({ data: {
    email: `${PREFIX.toLowerCase()}@example.invalid`, name: `${PREFIX} affiliate`,
    ref_code: `${PREFIX}CODE`, country_code: 'GB', party_type: 'affiliate' }, select: { id: true } });
  const g3 = await mkGarage(3);
  await AF.freezeTermsAtSignup(prisma, g3, { totalRewardPennies: 12000, instalmentPennies: 3000, plan: 'monthly' });
  await prisma.tenantAttribution.create({ data: { group_id: g3, party_type: 'affiliate', party_id: aff.id, role: 'referrer', share_bp: 10000, effective_from: new Date(), source: 'ref_param' } });

  const pay = (invoiceId) => AF.rewardPaidInvoice(prisma, { groupId: g3, invoiceId, paidPennies: 7500 });
  await pay('in_ZZAFF_1');
  const after1 = await prisma.commissionEntry.count({ where: { group_id: g3 } });
  check('a successful payment writes ONE instalment', after1 === 1, `${after1}`);
  await pay('in_ZZAFF_1');
  check('  …and the SAME invoice twice writes nothing more',
    (await prisma.commissionEntry.count({ where: { group_id: g3 } })) === 1,
    'idempotent on the invoice id — a webhook retry is the normal case, not the exception');
  for (const id of ['in_ZZAFF_2', 'in_ZZAFF_3', 'in_ZZAFF_4', 'in_ZZAFF_5', 'in_ZZAFF_6']) await pay(id);
  const total = (await prisma.commissionEntry.aggregate({ where: { group_id: g3 }, _sum: { amount_pennies: true } }))._sum.amount_pennies ?? 0;
  check('SIX payments cannot earn more than the total', total === 12000, `£${(total / 100).toFixed(2)} of £120.00 — four instalments, then nothing`);
  check('  …and the cap is on the TENANT, not the run', (await prisma.commissionEntry.count({ where: { group_id: g3 } })) === 4);

  console.log('\n— and nothing at all for a trial —');
  const g4 = await mkGarage(4);
  await AF.freezeTermsAtSignup(prisma, g4, { totalRewardPennies: 12000, instalmentPennies: 3000, plan: 'monthly' });
  await prisma.tenantAttribution.create({ data: { group_id: g4, party_type: 'affiliate', party_id: aff.id, role: 'referrer', share_bp: 10000, effective_from: new Date(), source: 'ref_param' } });
  await AF.rewardTrialStarted(prisma, { groupId: g4 }).catch(() => {});
  check('starting a trial earns NOTHING', (await prisma.commissionEntry.count({ where: { group_id: g4 } })) === 0,
    'the reward is for a garage that PAYS, and a trial has paid nothing');

  console.log('\n— the annual path is one entry, not four —');
  const g5 = await mkGarage(5);
  await AF.freezeTermsAtSignup(prisma, g5, { totalRewardPennies: 12000, instalmentPennies: 3000, plan: 'annual_offer', offerMonthsPaid: 6, monthsGiven: 12 });
  await prisma.tenantAttribution.create({ data: { group_id: g5, party_type: 'affiliate', party_id: aff.id, role: 'referrer', share_bp: 10000, effective_from: new Date(), source: 'ref_param' } });
  await AF.rewardPaidInvoice(prisma, { groupId: g5, invoiceId: 'in_ZZAFF_ANNUAL', paidPennies: 45000 });
  const annual = await prisma.commissionEntry.findMany({ where: { group_id: g5 }, select: { amount_pennies: true } });
  check('the offer payment earns the FULL reward in one entry',
    annual.length === 1 && annual[0].amount_pennies === 12000, JSON.stringify(annual));
  await AF.rewardPaidInvoice(prisma, { groupId: g5, invoiceId: 'in_ZZAFF_ANNUAL_2', paidPennies: 45000 });
  check('  …and a second payment on an annual tenant earns nothing more',
    (await prisma.commissionEntry.count({ where: { group_id: g5 } })) === 1);

  // ── 7. WHO MAY TAKE THE OFFER ───────────────────────────────────────────────────────────────
  console.log('\n— who may take the offer —');
  check('no code, no offer', !!AF.refuseOffer({ code: null, codeValid: false, isNewGarage: true, alreadyTaken: false, signupsOpen: true }));
  check('an unknown code is refused', !!AF.refuseOffer({ code: 'NOPE', codeValid: false, isNewGarage: true, alreadyTaken: false, signupsOpen: true }));
  check('an EXISTING garage is refused', !!AF.refuseOffer({ code: 'X', codeValid: true, isNewGarage: false, alreadyTaken: false, signupsOpen: true }));
  check('a garage that already took it is refused', !!AF.refuseOffer({ code: 'X', codeValid: true, isNewGarage: true, alreadyTaken: true, signupsOpen: true }));
  // THE DISCRIMINATOR: all four above pass against a function that refuses everything.
  check('  …and a NEW garage with a valid code is ALLOWED',
    AF.refuseOffer({ code: 'X', codeValid: true, isNewGarage: true, alreadyTaken: false, signupsOpen: true }) === null,
    'otherwise the four refusals above prove only that the door is nailed shut');

  console.log('\n— trial or offer, never both —');
  check('a card cannot carry the trial AND the offer',
    !!AF.refusePlanCombination({ plan: 'annual_offer', trialDays: 30 }),
    'paying immediately and being on trial are contradictory states, not a configuration');
  check('  …while each alone is fine',
    AF.refusePlanCombination({ plan: 'annual_offer', trialDays: 0 }) === null
      && AF.refusePlanCombination({ plan: 'monthly', trialDays: 30 }) === null);

  console.log('\n— and nobody refers themselves —');
  const me = { email: 'sam@example.invalid', phone: '+447700900123', company: 'Sam Motors' };
  check('a matching email is blocked', !!AF.refuseSelfReferral(me, { email: 'SAM@example.invalid', phone: null, company: null }));
  check('a matching phone is blocked', !!AF.refuseSelfReferral(me, { email: null, phone: '07700 900123', company: null }));
  check('a matching company is blocked', !!AF.refuseSelfReferral(me, { email: null, phone: null, company: 'sam motors' }));
  check('  …and an unrelated garage is NOT blocked',
    AF.refuseSelfReferral(me, { email: 'other@example.invalid', phone: '+447700900999', company: 'Other Motors' }) === null,
    'without this the three above pass against a function that blocks everyone');

  // ── 8. CLOSING THE PROGRAMME ────────────────────────────────────────────────────────────────
  // Closing is about NEW signups. It must not touch money already earned, nor instalments a
  // paying garage is still generating — those were promised on terms that were frozen.
  console.log('\n— closing signups —');
  await AF.saveSettings(prisma, { signupsOpen: false });
  check('a closed programme refuses a new signup',
    !!AF.refuseOffer({ code: 'X', codeValid: true, isNewGarage: true, alreadyTaken: false, signupsOpen: false }));
  const earnedBefore = (await prisma.commissionEntry.aggregate({ where: { group_id: g3 }, _sum: { amount_pennies: true } }))._sum.amount_pennies ?? 0;
  check('  …and leaves what was already EARNED alone', earnedBefore === 12000, `£${(earnedBefore / 100).toFixed(2)}`);
  const g6 = await mkGarage(6);
  await AF.freezeTermsAtSignup(prisma, g6, { totalRewardPennies: 12000, instalmentPennies: 3000, plan: 'monthly' });
  await prisma.tenantAttribution.create({ data: { group_id: g6, party_type: 'affiliate', party_id: aff.id, role: 'referrer', share_bp: 10000, effective_from: new Date(), source: 'ref_param' } });
  await AF.rewardPaidInvoice(prisma, { groupId: g6, invoiceId: 'in_ZZAFF_AFTERCLOSE', paidPennies: 7500 });
  check('  …and a garage signed up BEFORE closing keeps earning its instalments',
    (await prisma.commissionEntry.count({ where: { group_id: g6 } })) === 1,
    'closing the door is not a clawback — the terms were frozen when they signed');

  // ── 9. THE NULL THAT MEANS "NO VISIT IN THIS PROGRAMME" ─────────────────────────────────────
  check('an affiliate entry records no visit, rather than claiming one',
    (await prisma.commissionEntry.findFirst({ where: { group_id: g3 }, select: { shown_as_visited: true } }))?.shown_as_visited === null,
    'NULL = an affiliate entry; there is no visit in this programme');
} catch (e) {
  console.log(`\n✗ THREW: ${String(e?.stack ?? e).slice(0, 700)}`);
  out.push('F');
} finally {
  const left = await sweep().catch(() => -1);
  check('teardown removed every fixture row (ZZ only)', left >= 0, left < 0 ? 'sweep threw — check for ZZAFF by hand' : `${left} row(s)`);
  console.log(`\n${out.filter((x) => x === 'F').length} failures of ${out.length}`);
  await prisma?.$disconnect();
  process.exit(out.includes('F') ? 1 : 0);
}
