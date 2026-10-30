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
  // USERS FIRST, and keyed on the EMAIL rather than the group (2026-10-29). Section 10 adds the
  // affiliate as a user of a garage to prove the own-or-work-for refusal, and the first run of it
  // left two User rows behind: the sweep took the groups and the Users went with them only where
  // the cascade reached, so the next run collided on User.email @unique and the gate THREW before
  // any clause ran. A sweep must take everything its gate makes, not everything it remembers.
  const userEmails = { startsWith: `${PREFIX.toLowerCase()}` };
  await prisma.user.deleteMany({ where: { email: userEmails } }).catch(() => {});
  if (groups.length) {
    await prisma.user.deleteMany({ where: { group_id: { in: groups } } }).catch(() => {});
    await prisma.groupBilling.deleteMany({ where: { group_id: { in: groups } } }).catch(() => {});
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
  // ACTIVATED, AND THE DATE MATTERS (2026-10-29). A code now earns nothing until its owner has
  // accepted the terms, and a reward runs from activation ONWARDS — so this fixture is activated
  // well in the past, and every `pay()` below uses a paid date after it. Without that, every
  // reward clause in this gate would be silently measuring the new refusal instead of the cap, the
  // idempotency and the instalments it was written for.
  const ACTIVATED = new Date('2026-01-01T00:00:00Z');
  const aff = await prisma.rep.create({ data: {
    email: `${PREFIX.toLowerCase()}@example.invalid`, name: `${PREFIX} affiliate`,
    ref_code: `${PREFIX}CODE`, country_code: 'GB', party_type: 'affiliate',
    terms_accepted_at: ACTIVATED }, select: { id: true } });
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

  // A FIXED PAID DATE, after activation: the reward rules are date comparisons now, and a clock
  // here would make these clauses pass or fail by when the suite happened to run.
  const PAID_AT = new Date('2026-06-01T00:00:00Z');
  const pay = (invoiceId) => AF.rewardPaidInvoice(prisma, { groupId: g3, invoiceId, paidPennies: 7500, status: 'paid', paidAt: PAID_AT });
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
    await AF.rewardPaidInvoice(prisma, { groupId: g, invoiceId, paidAt: new Date('2026-06-01T00:00:00Z'), ...args }).catch(() => {});
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
  await AF.rewardPaidInvoice(prisma, { groupId: g5, invoiceId: 'in_ZZAFF_ANNUAL', paidPennies: 60000, status: 'paid', paidAt: new Date('2026-06-01T00:00:00Z') });
  const annual = await prisma.commissionEntry.findMany({ where: { group_id: g5 }, select: { amount_pennies: true } });
  check('the offer payment earns the FULL reward in one entry',
    annual.length === 1 && annual[0].amount_pennies === 12000, JSON.stringify(annual));
  await AF.rewardPaidInvoice(prisma, { groupId: g5, invoiceId: 'in_ZZAFF_ANNUAL_2', paidPennies: 60000, status: 'paid', paidAt: new Date('2026-06-01T00:00:00Z') });
  check('  …and a second payment on an annual tenant earns nothing more',
    (await prisma.commissionEntry.count({ where: { group_id: g5 } })) === 1);

  // ── 7. WHO MAY TAKE THE OFFER ───────────────────────────────────────────────────────────────
  console.log('\n— who may take the offer —');
  check('no code, no offer', !!AF.refuseOffer({ code: null, codeValid: false, hasNeverPaid: true, alreadyTaken: false, signupsOpen: true }));
  check('an unknown code is refused', !!AF.refuseOffer({ code: 'NOPE', codeValid: false, hasNeverPaid: true, alreadyTaken: false, signupsOpen: true }));
  check('an EXISTING garage is refused', !!AF.refuseOffer({ code: 'X', codeValid: true, hasNeverPaid: false, alreadyTaken: false, signupsOpen: true }));
  check('a garage that already took it is refused', !!AF.refuseOffer({ code: 'X', codeValid: true, hasNeverPaid: true, alreadyTaken: true, signupsOpen: true }));
  // THE DISCRIMINATOR: all four above pass against a function that refuses everything.
  check('  …and a NEW garage with a valid code is ALLOWED',
    AF.refuseOffer({ code: 'X', codeValid: true, hasNeverPaid: true, alreadyTaken: false, signupsOpen: true }) === null,
    'otherwise the four refusals above prove only that the door is nailed shut');

  // ── REVERSED 2026-10-28 ─────────────────────────────────────────────────────────────────────
  // This asserted the OPPOSITE until today: "a card cannot carry the trial AND the offer", under
  // the 2026-10-24 rule that paying at the front and being on trial were contradictory. Every
  // garage now gets the trial whatever plan it picks and is charged when the trial ends, so the
  // offer and the trial coexist by design. What is still refused is a plan with NO trial.
  // The full reversal is proved in annual-billing-gate; these two keep this file honest about it.
  console.log('\n— the offer, with the trial —');
  check('the offer and the trial coexist',
    AF.refusePlanCombination({ plan: 'annual_offer', trialDays: 30 }) === null,
    'reversed 2026-10-28 — this same call had to RETURN a refusal before today');
  check('  …while a plan with no trial at all is refused, on either shape',
    !!AF.refusePlanCombination({ plan: 'annual_offer', trialDays: 0 })
      && !!AF.refusePlanCombination({ plan: 'monthly', trialDays: 0 }));

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
    !!AF.refuseOffer({ code: 'X', codeValid: true, hasNeverPaid: true, alreadyTaken: false, signupsOpen: false }));
  const earnedBefore = (await prisma.commissionEntry.aggregate({ where: { group_id: g3 }, _sum: { amount_pennies: true } }))._sum.amount_pennies ?? 0;
  check('  …and leaves what was already EARNED alone', earnedBefore === 12000, `£${(earnedBefore / 100).toFixed(2)}`);
  const g6 = await mkGarage(6);
  await AF.freezeTermsAtSignup(prisma, g6, { affiliateId: aff.id, totalRewardPennies: 12000, instalmentPennies: 3000, plan: 'monthly' });
  await prisma.tenantAttribution.create({ data: { group_id: g6, party_type: 'affiliate', party_id: aff.id, role: 'referrer', share_bp: 10000, effective_from: new Date(), source: 'ref_param' } });
  await AF.rewardPaidInvoice(prisma, { groupId: g6, invoiceId: 'in_ZZAFF_AFTERCLOSE', paidPennies: 7500, status: 'paid', paidAt: new Date('2026-06-01T00:00:00Z') });
  check('  …and a garage signed up BEFORE closing keeps earning its instalments',
    (await prisma.commissionEntry.count({ where: { group_id: g6 } })) === 1,
    'closing the door is not a clawback — the terms were frozen when they signed');

  // ── 9. THE NULL THAT MEANS "NO VISIT IN THIS PROGRAMME" ─────────────────────────────────────
  check('an affiliate entry records no visit, rather than claiming one',
    (await prisma.commissionEntry.findFirst({ where: { group_id: g3 }, select: { shown_as_visited: true } }))?.shown_as_visited === null,
    'NULL = an affiliate entry; there is no visit in this programme');
  // ── 9. THE ACTIVATION RULE (owner ruling, 2026-10-29) ───────────────────────────────────────
  // Every garage signup mints a personal code INACTIVE; one click on the dashboard records real
  // acceptance in Rep.terms_accepted_at. A referral made before activation is still ATTRIBUTED and
  // is credited FROM ACTIVATION ONWARDS — so this is a date comparison, not a boolean, and an
  // invoice paid before the click earns nothing while the next one earns normally.
  console.log('\n— an unactivated code earns nothing —');
  const dormant = await prisma.rep.create({ data: {
    email: `${PREFIX.toLowerCase()}-dormant@example.invalid`, name: `${PREFIX} dormant`,
    ref_code: `${PREFIX}DORMANT`, country_code: 'GB', party_type: 'affiliate',
    terms_accepted_at: null }, select: { id: true } });
  const g20 = await mkGarage(20);
  await AF.freezeTermsAtSignup(prisma, g20, { affiliateId: dormant.id, totalRewardPennies: 12000, instalmentPennies: 3000, plan: 'monthly' });
  await prisma.tenantAttribution.create({ data: { group_id: g20, party_type: 'affiliate', party_id: dormant.id, role: 'referrer', share_bp: 10000, effective_from: new Date(), source: 'ref_param' } });

  const dormantPay = await AF.rewardPaidInvoice(prisma, { groupId: g20, invoiceId: 'in_ZZAFF_DORMANT', paidPennies: 7500, status: 'paid', paidAt: new Date('2026-06-01T00:00:00Z') });
  check('an UNACTIVATED code earns nothing from a paid invoice',
    dormantPay.paid === false && /not been activated/.test(dormantPay.why ?? ''), dormantPay.why);
  check('  …and writes no ledger row at all',
    (await prisma.commissionEntry.count({ where: { group_id: g20 } })) === 0,
    'a refusal that still wrote a £0 entry would show in the portal as a reward of nothing');
  // AND THE REFERRAL IS STILL THERE. "Attributed but not yet earning" is the whole point of the
  // ruling: the garage is recorded against them, so activation turns earnings on rather than
  // sending them back to find the garage again.
  check('  …while the ATTRIBUTION survives, so activation turns earning on',
    (await prisma.tenantAttribution.count({ where: { group_id: g20, party_id: dormant.id, ended_at: null } })) === 1,
    'attributed before activation, credited from activation onwards');

  // ACTIVATE, and the cut-off is the activation instant.
  const ACTIVATED_LATE = new Date('2026-07-01T00:00:00Z');
  await prisma.rep.update({ where: { id: dormant.id }, data: { terms_accepted_at: ACTIVATED_LATE } });
  const beforeClick = await AF.rewardPaidInvoice(prisma, { groupId: g20, invoiceId: 'in_ZZAFF_BEFORE', paidPennies: 7500, status: 'paid', paidAt: new Date('2026-06-30T23:59:59Z') });
  check('an invoice paid the day BEFORE activation still earns nothing',
    beforeClick.paid === false && /before the code was activated/.test(beforeClick.why ?? ''), beforeClick.why);
  const afterClick = await AF.rewardPaidInvoice(prisma, { groupId: g20, invoiceId: 'in_ZZAFF_AFTER', paidPennies: 7500, status: 'paid', paidAt: new Date('2026-07-01T00:00:01Z') });
  check('  …and one paid a second AFTER it earns normally',
    afterClick.paid === true && afterClick.amountPennies === 3000,
    `${afterClick.paid} / ${afterClick.amountPennies}p — the rule is a date, not a switch`);

  // ── 10. NOBODY EARNS ON A GARAGE THEY WORK FOR, CHECKED AT ACCRUAL ──────────────────────────
  // refuseSelfReferral runs at SIGNUP against typed form values. It cannot see a relationship that
  // begins afterwards: refer a garage, join it six months later as staff, and every further
  // invoice would pay you for working where you work.
  console.log('\n— and not on a garage you work for —');
  const g21 = await mkGarage(21);
  await AF.freezeTermsAtSignup(prisma, g21, { affiliateId: aff.id, totalRewardPennies: 12000, instalmentPennies: 3000, plan: 'monthly' });
  await prisma.tenantAttribution.create({ data: { group_id: g21, party_type: 'affiliate', party_id: aff.id, role: 'referrer', share_bp: 10000, effective_from: new Date(), source: 'ref_param' } });
  const cleanPay = await AF.rewardPaidInvoice(prisma, { groupId: g21, invoiceId: 'in_ZZAFF_CLEAN', paidPennies: 7500, status: 'paid', paidAt: new Date('2026-06-01T00:00:00Z') });
  check('a garage with no connection to the affiliate earns normally',
    cleanPay.paid === true, cleanPay.paid ? '' : cleanPay.why);

  // NOW THEY JOIN IT. The affiliate's login address becomes a user of the garage.
  await prisma.user.create({ data: {
    email: `${PREFIX.toLowerCase()}+staff@example.invalid`,
    name: `${PREFIX} staff`, group_id: g21 } });
  const stillFine = await AF.rewardPaidInvoice(prisma, { groupId: g21, invoiceId: 'in_ZZAFF_OTHERSTAFF', paidPennies: 7500, status: 'paid', paidAt: new Date('2026-06-02T00:00:00Z') });
  check('  …and a DIFFERENT person joining the garage changes nothing',
    stillFine.paid === true, `${stillFine.paid} — the test is the affiliate, not any staff member`);

  const joined = await prisma.user.create({ data: {
    email: `${PREFIX.toLowerCase()}@example.invalid`, name: `${PREFIX} now staff`, group_id: g21 } }).catch(() => null);
  if (!joined) {
    check('the affiliate could be added as a user of the garage', false,
      'User.email is @unique and this address is already taken — the clause below cannot run');
  } else {
    const afterJoin = await AF.rewardPaidInvoice(prisma, { groupId: g21, invoiceId: 'in_ZZAFF_AFTERJOIN', paidPennies: 7500, status: 'paid', paidAt: new Date('2026-06-03T00:00:00Z') });
    check('once the AFFILIATE is a user of the garage, it earns nothing more',
      afterJoin.paid === false && /own or work for/.test(afterJoin.why ?? ''), afterJoin.why);
    check('  …and the earlier rewards are LEFT ALONE',
      (await prisma.commissionEntry.count({ where: { group_id: g21, kind: 'accrual' } })) === 2,
      'money already earned on a garage they did not then work for is still theirs');
  }

  // ── 11. THE FOURTEEN-DAY HOLD, DERIVED ──────────────────────────────────────────────────────
  // No column: CommissionEntry.status's `held` is an area manager's hold paired to held_reason by a
  // CHECK, and a time hold is a different fact. Derived from the invoice's PAID date.
  console.log('\n— the hold —');
  check('the hold is fourteen days', AF.AFFILIATE_HOLD_DAYS === 14, String(AF.AFFILIATE_HOLD_DAYS));
  const paidOn = new Date('2026-06-01T00:00:00Z');
  const matures = AF.rewardPayableFrom(paidOn);
  check('  …so a reward matures exactly AFFILIATE_HOLD_DAYS after the money arrived',
    matures.toISOString() === new Date(paidOn.getTime() + AF.AFFILIATE_HOLD_DAYS * 86400000).toISOString(),
    matures.toISOString());
  check('  …it is NOT payable one second before that',
    AF.rewardIsPayable({ paidAt: paidOn, now: new Date(matures.getTime() - 1000) }) === false);
  check('  …and IS payable at the instant itself',
    AF.rewardIsPayable({ paidAt: paidOn, now: matures }) === true,
    'half-open at the bottom, like every other window in this codebase');

  // ── 12. THE REWARD FOLLOWS THE MONEY BACK ───────────────────────────────────────────────────
  // Replaces REFUND_POLICY_UNDECIDED, which was a true flag with no reader.
  console.log('\n— a refund reverses the reward —');
  const g22 = await mkGarage(22);
  await AF.freezeTermsAtSignup(prisma, g22, { affiliateId: aff.id, totalRewardPennies: 12000, instalmentPennies: 3000, plan: 'monthly' });
  await prisma.tenantAttribution.create({ data: { group_id: g22, party_type: 'affiliate', party_id: aff.id, role: 'referrer', share_bp: 10000, effective_from: new Date(), source: 'ref_param' } });
  const earned = await AF.rewardPaidInvoice(prisma, { groupId: g22, invoiceId: 'in_ZZAFF_REFUNDME', paidPennies: 7500, status: 'paid', paidAt: new Date('2026-06-01T00:00:00Z') });
  check('a paid month earns its instalment', earned.paid === true && earned.amountPennies === 3000, String(earned.amountPennies));

  // ── A PARTIAL REFUND LEAVES IT STANDING (owner, 2026-10-30) ───────────────────────────────
  // This REVERSES yesterday's rule, which took the whole reward back on any refund at all. A few
  // pounds off a month as goodwill is our decision, not the affiliate's, and must not cost them.
  // ASSERTED ON THE LEDGER as well as the refusal: "the reward stands" means the accrual is still
  // there and still positive, which a message alone would not show.
  const REFUND = { groupId: g22, invoiceId: 'in_ZZAFF_REFUNDME', chargePennies: 7500 };
  const partial = await AF.reverseAffiliateReward(prisma, { ...REFUND, refundId: 're_ZZAFF_PART', refundedPennies: 2000, refundedAt: new Date('2026-06-20T00:00:00Z') });
  check('  …a PARTIAL refund of that invoice does NOT reverse it',
    partial.reversed === false && /only a full refund reverses it/.test(partial.why ?? ''), partial.why);
  const standsAt = (await prisma.commissionEntry.aggregate({ where: { group_id: g22 }, _sum: { amount_pennies: true } }))._sum.amount_pennies ?? 0;
  check('  …and the reward is still there, in full',
    standsAt === 3000 && (await prisma.commissionEntry.count({ where: { group_id: g22, kind: 'clawback' } })) === 0,
    `${standsAt}p and no clawback row — goodwill on our side must not cost the affiliate`);
  const nearly = await AF.reverseAffiliateReward(prisma, { ...REFUND, refundId: 're_ZZAFF_NEARLY', refundedPennies: 7499, refundedAt: new Date('2026-06-20T00:00:00Z') });
  check('  …one penny short of the whole charge is still a partial refund',
    nearly.reversed === false, `${nearly.why} — the boundary is the charge, not "most of it"`);
  // AND THE NUMBERS ARE REQUIRED. A caller who cannot say how much went back, and of what, gets an
  // exception: defaulting refundedPennies to 0 would silently stop reversing anything, and
  // defaulting chargePennies to 0 would make the comparison true of every refund and reverse
  // everything. Two guards, failing in opposite directions, so both are named.
  const noCharge = await AF.reverseAffiliateReward(prisma, { groupId: g22, invoiceId: 'in_ZZAFF_REFUNDME', refundId: 're_ZZAFF_NOCHARGE', refundedPennies: 7500, refundedAt: new Date('2026-06-20T00:00:00Z') })
    .then(() => null, (e) => e);
  check('  …the reversal REFUSES to run without the charge amount',
    noCharge instanceof Error && /chargePennies is required/.test(noCharge.message),
    noCharge ? 'threw' : 'it answered without being able to tell a partial refund from a full one');
  const noRefunded = await AF.reverseAffiliateReward(prisma, { ...REFUND, refundId: 're_ZZAFF_NOTOTAL', refundedAt: new Date('2026-06-20T00:00:00Z') })
    .then(() => null, (e) => e);
  check('  …and without the refunded total, for the same reason',
    noRefunded instanceof Error && /refundedPennies is required/.test(noRefunded.message),
    noRefunded ? 'threw' : 'a missing total would read as nothing refunded, for ever, in silence');

  const rev = await AF.reverseAffiliateReward(prisma, { ...REFUND, refundId: 're_ZZAFF_1', refundedPennies: 7500, refundedAt: new Date('2026-06-20T00:00:00Z') });
  check('  …but a FULL refund of that invoice reverses it',
    rev.reversed === true && rev.amountPennies === -3000,
    `${rev.reversed} / ${rev.amountPennies} — the NEGATIVE of what was accrued, not the refunded amount`);
  const net = (await prisma.commissionEntry.aggregate({ where: { group_id: g22 }, _sum: { amount_pennies: true } }))._sum.amount_pennies ?? 0;
  check('  …so the ledger nets to zero', net === 0, `${net}p`);
  check('  …filed in the month the money went BACK, not the month it was earned',
    (await prisma.commissionEntry.findFirst({ where: { group_id: g22, kind: 'clawback' }, select: { period: true } }))?.period === '2026-06',
    'dated from refundedAt — a reversal in the wrong month reads as new work in a pay run');

  const rowsAfterOne = await prisma.commissionEntry.count({ where: { group_id: g22 } });
  const again = await AF.reverseAffiliateReward(prisma, { ...REFUND, refundId: 're_ZZAFF_1', refundedPennies: 7500, refundedAt: new Date('2026-06-20T00:00:00Z') });
  // ASSERTED ON THE LEDGER, not on the message. The first draft matched /already/ against `why`,
  // which the "reversed in full" guard satisfies — so it passed without ever reaching the P2002
  // catch it was written for. What a re-delivered webhook must not do is add a row, so that is
  // what this says. (P2002 on [source_ref, party_id, kind] is still the belt-and-braces for two
  // deliveries racing past the guard at once, and this clause does NOT reach it.)
  check('  …and the SAME refund twice adds no further row',
    again.reversed === false && (await prisma.commissionEntry.count({ where: { group_id: g22 } })) === rowsAfterOne,
    `${again.why} — ${rowsAfterOne} row(s) before and after`);
  const second = await AF.reverseAffiliateReward(prisma, { ...REFUND, refundId: 're_ZZAFF_2', refundedPennies: 7500, refundedAt: new Date('2026-06-21T00:00:00Z') });
  check('  …nor does a SECOND refund of the same invoice take back more than went out',
    second.reversed === false && /already been reversed in full/.test(second.why ?? ''), second.why);
  const nothing = await AF.reverseAffiliateReward(prisma, { groupId: g22, refundId: 're_ZZAFF_3', invoiceId: 'in_ZZAFF_NEVERPAID', chargePennies: 7500, refundedPennies: 7500, refundedAt: new Date('2026-06-21T00:00:00Z') });
  check('  …and a refund of an invoice that earned nothing writes nothing',
    nothing.reversed === false && /earned no affiliate reward/.test(nothing.why ?? ''), nothing.why);

  // ── 12b. FULL OR PARTIAL IS DECIDED OVER THE WHOLE CHARGE ───────────────────────────────────
  // The reversal path cannot be driven end to end here: it asks Stripe for the refunds, and
  // listChargeRefunds refuses to answer without a client (correctly — an empty list because we
  // could not ask is indistinguishable from "no refunds"). So the DECISION is the thing held, and
  // it is a pure exported function for that reason: synthetic refund lists in, a decision out.
  console.log('\n— and the full/partial decision itself —');
  const CB = await import(`${R}/lib/commission-billing.ts`);
  const rf = (id, amount, created, status = 'succeeded') => ({ id, amount, currency: 'GBP', reason: null, created, status });
  const JUN20 = new Date('2026-06-20T10:00:00Z');
  const JUN21 = new Date('2026-06-21T10:00:00Z');

  const onePart = CB.affiliateReversalFromRefunds({ chargePennies: 7500, chargeCreated: JUN20, refunds: [rf('re_A', 2000, JUN20)] });
  check('£20 off a £75 month is a partial refund',
    onePart.reverse === false && /2000p of 7500p/.test(onePart.why ?? ''),
    `${onePart.why} — both numbers in the message, because the webhook logs this line verbatim`);

  // CUMULATIVE. Three partials that between them take the whole charge back ARE a full refund —
  // which is why the caller passes the TOTAL and not this refund's own amount, and why the refunds
  // are asked of Stripe rather than read off an event body that can only know about one of them.
  const twoParts = CB.affiliateReversalFromRefunds({ chargePennies: 7500, chargeCreated: JUN20, refunds: [rf('re_A', 2000, JUN20), rf('re_B', 5500, JUN21)] });
  check('  …but two partials that together take the whole charge back DO reverse it',
    twoParts.reverse === true && twoParts.refundedPennies === 7500, JSON.stringify(twoParts));
  check('  …keyed on the refund that COMPLETED it, not the first one',
    twoParts.reverse === true && twoParts.refundId === 're_B',
    'stable across re-deliveries: Stripe permits no further refund once the charge is fully refunded');
  check('  …and dated from that same completing refund',
    twoParts.reverse === true && twoParts.refundedAt.toISOString() === JUN21.toISOString(),
    'the month the money finally went back is the month the reversal belongs in');

  const failed = CB.affiliateReversalFromRefunds({ chargePennies: 7500, chargeCreated: JUN20, refunds: [rf('re_A', 2000, JUN20), rf('re_X', 5500, JUN21, 'failed')] });
  check('  …a FAILED refund moved no money, so it does not make the total',
    failed.reverse === false && /2000p of 7500p/.test(failed.why ?? ''), failed.why);

  // WHAT WE TOOK, NOT WHAT WE ASKED FOR. A refund can only ever be up to the captured amount, so
  // the comparison is against that; this holds the arithmetic at the boundary.
  const exact = CB.affiliateReversalFromRefunds({ chargePennies: 7500, chargeCreated: JUN20, refunds: [rf('re_A', 7500, JUN20)] });
  check('  …and one refund of the whole charge is full on the nose',
    exact.reverse === true && exact.refundId === 're_A', JSON.stringify(exact));

  // NEVER THE CLOCK. listChargeRefunds turns an absent `created` into new Date(0), so the test is
  // on the instant, not on whether the object is there.
  const undatedRefund = CB.affiliateReversalFromRefunds({ chargePennies: 7500, chargeCreated: JUN20, refunds: [rf('re_A', 7500, new Date(0))] });
  check('  …an undated refund falls back to the CHARGE date',
    undatedRefund.reverse === true && undatedRefund.refundedAt.toISOString() === JUN20.toISOString(), JSON.stringify(undatedRefund));
  const undatedBoth = CB.affiliateReversalFromRefunds({ chargePennies: 7500, chargeCreated: null, refunds: [rf('re_A', 7500, new Date(0))] });
  check('  …and with no date anywhere it REFUSES rather than filing it in whatever month this ran',
    undatedBoth.reverse === false && /carries no date/.test(undatedBoth.why ?? ''), undatedBoth.why);

  // ── 13. AND THE WIRE ITSELF ─────────────────────────────────────────────────────────────────
  // THE WHOLE POINT OF THIS SLICE. rewardPaidInvoice was complete, gated and correct, and had no
  // production caller — every clause above would have passed on the day no affiliate could earn
  // anything. So these drive the ADAPTER the webhook calls, with a synthetic Stripe payload: the
  // accrual path reads the event and the database and makes no Stripe API call, which is exactly
  // why it can be asserted here.
  console.log('\n— the webhook actually reaches it —');
  const g23 = await mkGarage(23);
  const CUST = `cus_${PREFIX}WIRE`;
  // CREATED, not updated. This gate's mkGarage makes a Group and nothing else — unlike the annual
  // gate's, which also makes the billing row — so an update here found no record (P2025). The
  // adapter resolves the tenant through GroupBilling.stripe_customer_id, so the row IS the wire.
  await prisma.groupBilling.create({ data: {
    group_id: g23, plan_name: `${PREFIX} plan`, status: 'ok', retention_months: 12, included_sites: 1,
    stripe_customer_id: CUST } });
  await AF.freezeTermsAtSignup(prisma, g23, { affiliateId: aff.id, totalRewardPennies: 12000, instalmentPennies: 3000, plan: 'monthly' });
  await prisma.tenantAttribution.create({ data: { group_id: g23, party_type: 'affiliate', party_id: aff.id, role: 'referrer', share_bp: 10000, effective_from: new Date(), source: 'ref_param' } });

  const PAID_UNIX = Math.floor(new Date('2026-06-01T00:00:00Z').getTime() / 1000);
  const invoiceOf = (id, over = {}) => ({
    id, object: 'invoice', customer: CUST, amount_paid: 7500, status: 'paid',
    status_transitions: { paid_at: PAID_UNIX }, created: PAID_UNIX, ...over,
  });

  const wired = await CB.rewardFromInvoicePaid(prisma, invoiceOf(`in_${PREFIX}WIRE_1`));
  check('invoice.paid reaches the affiliate reward through the adapter',
    wired.status === 'accrued' && wired.written === 1, JSON.stringify(wired));
  check('  …and the entry is dated from the invoice\u2019s PAID date, not the clock',
    (await prisma.commissionEntry.findFirst({ where: { group_id: g23, kind: 'accrual' }, select: { period: true } }))?.period === '2026-06',
    'status_transitions.paid_at — a webhook re-delivered next month must file it the same way');
  const wiredAgain = await CB.rewardFromInvoicePaid(prisma, invoiceOf(`in_${PREFIX}WIRE_1`));
  check('  …and a re-delivered event writes nothing more',
    wiredAgain.status === 'skipped' && (await prisma.commissionEntry.count({ where: { group_id: g23, kind: 'accrual' } })) === 1,
    JSON.stringify(wiredAgain));

  const unknownCust = await CB.rewardFromInvoicePaid(prisma, invoiceOf(`in_${PREFIX}WIRE_2`, { customer: 'cus_NOBODY' }));
  check('  …an invoice for a customer we do not know is SKIPPED, not thrown',
    unknownCust.status === 'skipped' && /unknown Stripe customer/.test(unknownCust.reason ?? ''), JSON.stringify(unknownCust));
  const noDate = await CB.rewardFromInvoicePaid(prisma, invoiceOf(`in_${PREFIX}WIRE_3`, { status_transitions: {}, created: null }));
  check('  …and one with no paid date is SKIPPED rather than dated from now',
    noDate.status === 'skipped' && /no paid date/.test(noDate.reason ?? ''), JSON.stringify(noDate));
  const unpaid = await CB.rewardFromInvoicePaid(prisma, invoiceOf(`in_${PREFIX}WIRE_4`, { status: 'open', amount_paid: 0 }));
  check('  …and an UNPAID invoice earns nothing, with the refusal named',
    unpaid.status === 'skipped' && /not paid|pennies/.test(unpaid.reason ?? ''), JSON.stringify(unpaid));

  // A REFUSAL IS DATA, NEVER A THROW. The webhook calls this after the first-payment write has
  // already committed; a throw would 500 it, Stripe would retry, and the retry would be about a
  // reward while everything else about the payment was already correct.
  const threwNot = await CB.rewardFromInvoicePaid(prisma, invoiceOf(`in_${PREFIX}WIRE_5`, { customer: null }));
  check('  …and a payload with no customer at all comes back as data, not an exception',
    threwNot.status === 'skipped', JSON.stringify(threwNot));

  // AND THE REQUIRED-DATE GUARD ITSELF. A red-proof that removed it left every clause green,
  // because every caller passes a valid date — the guard is for the caller that does not yet
  // exist, and a guard with no clause is a comment. So this is the clause: a missing or
  // unparseable paidAt must THROW, loudly, rather than be defaulted to the clock, because the
  // clock answers both the activation rule and the ledger period wrongly for a re-delivery.
  const noDateThrew = await AF.rewardPaidInvoice(prisma, { groupId: g23, invoiceId: 'in_ZZAFF_NODATE', paidPennies: 7500, status: 'paid' })
    .then(() => null, (e) => e);
  check('rewardPaidInvoice REFUSES to run without a paid date',
    noDateThrew instanceof Error && /paidAt is required/.test(noDateThrew.message),
    noDateThrew ? noDateThrew.message.slice(0, 90) : 'it accepted the call and dated the reward from the clock');
  const badDateThrew = await AF.rewardPaidInvoice(prisma, { groupId: g23, invoiceId: 'in_ZZAFF_BADDATE', paidPennies: 7500, status: 'paid', paidAt: new Date('not a date') })
    .then(() => null, (e) => e);
  check('  …and an UNPARSEABLE one too, rather than treating NaN as a moment',
    badDateThrew instanceof Error && /paidAt is required/.test(badDateThrew.message),
    badDateThrew ? 'threw' : 'an Invalid Date would have produced period "NaN-aN"');
  const reversalNoDate = await AF.reverseAffiliateReward(prisma, { groupId: g22, refundId: 're_ZZAFF_NODATE', invoiceId: 'in_ZZAFF_REFUNDME', chargePennies: 7500, refundedPennies: 7500 })
    .then(() => null, (e) => e);
  check('  …and the reversal refuses without a refund date for the same reason',
    reversalNoDate instanceof Error && /refundedAt is required/.test(reversalNoDate.message),
    reversalNoDate ? 'threw' : 'it would have filed the reversal in whatever month this ran');

  check('REFUND_POLICY_UNDECIDED is gone, because it is decided',
    AF.REFUND_POLICY_UNDECIDED === undefined,
    'a flag that was true, had no reader, and existed to make an unanswered question visible');

} catch (e) {
  // describeError, not String(e?.stack ?? e): a PrismaClientKnownRequestError thrown inside the
  // suite printed as a bare class name with nothing after the colon, which said a fault occurred
  // and not which. describeError leads with the class AND carries the code and message.
  console.log(`\n✗ THREW: ${describeError(e).slice(0, 700)}`);
  out.push('F');
} finally {
  const left = await sweep().catch(() => -1);
  check('teardown removed every fixture row (ZZ only)', left >= 0, left < 0 ? 'sweep threw — check for ZZAFF by hand' : `${left} row(s)`);
  console.log(`\n${out.filter((x) => x === 'F').length} failures of ${out.length}`);
  await prisma?.$disconnect();
  process.exit(out.includes('F') ? 1 : 0);
}
