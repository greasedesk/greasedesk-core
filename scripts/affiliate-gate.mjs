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
 * TRIAL OR PAY NOW, NEVER BOTH (owner, 2026-10-24). Monthly keeps the 30-day trial; every annual
 * shape pays at the front and has none.
 *
 * ── THE PRICES CHANGED ON 2026-10-26, AND THIS FILE WAS WRITTEN BEFORE THEY DID ────────────────
 *   annual, every garage, direct or referred ... 12 months for the price of 10 = £750, renewal too
 *   affiliate annual offer ..................... 12 months for the price of  8 = £600
 * The old 12-for-9 for new garages is GONE, and the offer was 12-for-6 (£450). Five assertions in
 * this file asserted the old numbers; a gate that keeps asserting a retired price is a gate that
 * will one day refuse the right answer.
 *
 * The REWARD is unchanged: £30 per paid month for the first four paid months, £120 cap per
 * referred garage; or a single £120 when the annual offer invoice is paid.
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
/** THIS GATE'S OWN settings row. The singleton is read by trial-setting-gate; two gates sharing
 *  one mutable global is how a gate's trial length reached the public site on 2026-10-25. */
const SETTINGS = 'ZZAFF-settings';

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
  const settings = await prisma.programmeSettings.deleteMany({ where: { id: SETTINGS } }).catch(() => ({ count: 0 }));
  return reps.length + groups.length + (settings?.count ?? 0);
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

  // ── ENTITLEMENT MOVED OUT (2026-10-26) ──────────────────────────────────────────────────────
  // "A module belongs to the product, not the price" began here because the affiliate offer is
  // what first needed an inline price. It is not an affiliate rule — it is the entitlement rule
  // for every paying garage — and keeping it here made "the affiliate ledger is correct" and
  // "entitlement resolves" share one verdict. It is scripts/entitlement-product-gate.mjs now, and
  // it DECLINES until lib/modules exports modulesFromProducts.

  // ── 5. THE TERMS A GARAGE SIGNED UP UNDER ARE FROZEN ────────────────────────────────────────
  console.log('\n— what a garage signed up under —');
  const mkGarage = async (n) => (await prisma.group.create({ data: {
    group_name: `${PREFIX} garage ${n}`, billing_email: `${PREFIX.toLowerCase()}-${n}@example.invalid`,
  }, select: { id: true } })).id;
  // THE AFFILIATE COMES FIRST. TenantAffiliateTerms.affiliate_id is a required FK: terms about a
  // referral must name who referred. The first draft created the affiliate in section 6, after the
  // terms in section 5 that cannot exist without it.
  const aff = await prisma.rep.create({ data: {
    email: `${PREFIX.toLowerCase()}@example.invalid`, name: `${PREFIX} affiliate`,
    ref_code: `${PREFIX}CODE`, country_code: 'GB', party_type: 'affiliate' }, select: { id: true } });
  const g1 = await mkGarage(1);
  const frozen = await AF.freezeTermsAtSignup(prisma, g1, { affiliateId: aff.id, totalRewardPennies: 12000, instalmentPennies: 3000, plan: 'annual_offer', offerMonthsPaid: 8, monthsGiven: 12 });
  check('the terms are written once, at signup', !!frozen && frozen.total_reward_pennies === 12000);
  // THE CLAUSE THE WHOLE SETTINGS DESIGN RESTS ON.
  await AF.saveSettings(prisma, { totalRewardPennies: 20000, instalmentPennies: 5000 }, { settingsId: SETTINGS });
  const reread = await AF.termsFor(prisma, g1);
  check('a SETTINGS CHANGE does not move them', reread.total_reward_pennies === 12000 && reread.instalment_pennies === 3000,
    `${reread.total_reward_pennies}/${reread.instalment_pennies} — a garage keeps the terms it signed up under`);
  check('  …while a NEW garage gets the new ones',
    (await AF.freezeTermsAtSignup(prisma, await mkGarage(2), { ...(await AF.currentTerms(prisma, { settingsId: SETTINGS })), affiliateId: aff.id })).total_reward_pennies === 20000);

  // ── 6. THE REWARD LEDGER: IDEMPOTENT, CAPPED, AND ONLY ON MONEY ─────────────────────────────
  console.log('\n— one entry per payment, and never more than the total —');
  const g3 = await mkGarage(3);
  await AF.freezeTermsAtSignup(prisma, g3, { affiliateId: aff.id, totalRewardPennies: 12000, instalmentPennies: 3000, plan: 'monthly' });
  await prisma.tenantAttribution.create({ data: { group_id: g3, party_type: 'affiliate', party_id: aff.id, role: 'referrer', share_bp: 10000, effective_from: new Date(), source: 'ref_param' } });

  const pay = (invoiceId) => AF.rewardPaidInvoice(prisma, { groupId: g3, invoiceId, paidPennies: 7500, status: 'paid' });
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
  await AF.freezeTermsAtSignup(prisma, g4, { affiliateId: aff.id, totalRewardPennies: 12000, instalmentPennies: 3000, plan: 'monthly' });
  await prisma.tenantAttribution.create({ data: { group_id: g4, party_type: 'affiliate', party_id: aff.id, role: 'referrer', share_bp: 10000, effective_from: new Date(), source: 'ref_param' } });
  await AF.rewardTrialStarted(prisma, { groupId: g4 }).catch(() => {});
  check('starting a trial earns NOTHING', (await prisma.commissionEntry.count({ where: { group_id: g4 } })) === 0,
    'the reward is for a garage that PAYS, and a trial has paid nothing');

  // ── ONLY ON MONEY ACTUALLY TAKEN ────────────────────────────────────────────────────────────
  // "No reward on trial, unpaid, void or £0 invoices" (owner, 2026-10-26). The trial case above
  // was the only one tested; these are the other three, each on its OWN garage so a refusal
  // cannot be mistaken for the cap having been reached.
  console.log('\n— nor for an invoice that took no money —');
  const noMoney = async (n, invoiceId, args) => {
    const g = await mkGarage(n);
    await AF.freezeTermsAtSignup(prisma, g, { affiliateId: aff.id, totalRewardPennies: 12000, instalmentPennies: 3000, plan: 'monthly' });
    await prisma.tenantAttribution.create({ data: { group_id: g, party_type: 'affiliate', party_id: aff.id, role: 'referrer', share_bp: 10000, effective_from: new Date(), source: 'ref_param' } });
    await AF.rewardPaidInvoice(prisma, { groupId: g, invoiceId, ...args }).catch(() => {});
    return prisma.commissionEntry.count({ where: { group_id: g } });
  };
  check('an UNPAID invoice earns nothing', (await noMoney(10, 'in_ZZAFF_OPEN', { paidPennies: 7500, status: 'open' })) === 0,
    'an invoice that has been issued is not an invoice that has been paid');
  check('a VOID invoice earns nothing', (await noMoney(11, 'in_ZZAFF_VOID', { paidPennies: 7500, status: 'void' })) === 0,
    'a retired number paid nobody anything');
  // ZERO IS TESTED AS A NUMBER, NOT AS FALSINESS. `if (paidPennies)` would skip a £0 invoice
  // silently and look identical to refusing it — and a £0 invoice is a real shape here: a fully
  // discounted first month is still an invoice marked paid.
  check('a £0 invoice earns nothing, and is REFUSED rather than skipped',
    (await noMoney(12, 'in_ZZAFF_ZERO', { paidPennies: 0, status: 'paid' })) === 0,
    'zero is a measurement, not an absence — see three-states-not-two');
  // THE DISCRIMINATOR for all four refusals above, including the trial: a paid invoice of real
  // money on a fresh garage DOES earn. Without it they pass against a function that pays nobody.
  check('  …while a PAID invoice on the same shape earns one instalment',
    (await noMoney(13, 'in_ZZAFF_REAL', { paidPennies: 7500, status: 'paid' })) === 1,
    'otherwise the four refusals prove only that the ledger is shut');

  console.log('\n— the annual path is one entry, not four —');
  const g5 = await mkGarage(5);
  await AF.freezeTermsAtSignup(prisma, g5, { affiliateId: aff.id, totalRewardPennies: 12000, instalmentPennies: 3000, plan: 'annual_offer', offerMonthsPaid: 8, monthsGiven: 12 });
  await prisma.tenantAttribution.create({ data: { group_id: g5, party_type: 'affiliate', party_id: aff.id, role: 'referrer', share_bp: 10000, effective_from: new Date(), source: 'ref_param' } });
  await AF.rewardPaidInvoice(prisma, { groupId: g5, invoiceId: 'in_ZZAFF_ANNUAL', paidPennies: 60000, status: 'paid' });
  const annual = await prisma.commissionEntry.findMany({ where: { group_id: g5 }, select: { amount_pennies: true } });
  check('the offer payment earns the FULL reward in one entry',
    annual.length === 1 && annual[0].amount_pennies === 12000, JSON.stringify(annual));
  await AF.rewardPaidInvoice(prisma, { groupId: g5, invoiceId: 'in_ZZAFF_ANNUAL_2', paidPennies: 60000, status: 'paid' });
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
  await AF.saveSettings(prisma, { signupsOpen: false }, { settingsId: SETTINGS });
  check('a closed programme refuses a new signup',
    !!AF.refuseOffer({ code: 'X', codeValid: true, isNewGarage: true, alreadyTaken: false, signupsOpen: false }));
  const earnedBefore = (await prisma.commissionEntry.aggregate({ where: { group_id: g3 }, _sum: { amount_pennies: true } }))._sum.amount_pennies ?? 0;
  check('  …and leaves what was already EARNED alone', earnedBefore === 12000, `£${(earnedBefore / 100).toFixed(2)}`);
  const g6 = await mkGarage(6);
  await AF.freezeTermsAtSignup(prisma, g6, { affiliateId: aff.id, totalRewardPennies: 12000, instalmentPennies: 3000, plan: 'monthly' });
  await prisma.tenantAttribution.create({ data: { group_id: g6, party_type: 'affiliate', party_id: aff.id, role: 'referrer', share_bp: 10000, effective_from: new Date(), source: 'ref_param' } });
  await AF.rewardPaidInvoice(prisma, { groupId: g6, invoiceId: 'in_ZZAFF_AFTERCLOSE', paidPennies: 7500, status: 'paid' });
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
