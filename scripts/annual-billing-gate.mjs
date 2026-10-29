/**
 * File: scripts/annual-billing-gate.mjs
 * @gate-requires: db
 *
 * ANNUAL BILLING: THE TRIAL, THE PRICE, THE OFFER AND THE SWITCH.
 *
 * ── THE REVERSAL THIS GATE IS BUILT AROUND (owner, 2026-10-28) ──────────────────────────────────
 * Until now a plan carried a trial OR took a payment, never both — "the trial IS the discount".
 * Every garage now gets the 30-day trial whatever it picks, and is charged its plan when the trial
 * ends. An annual garage therefore gets THIRTEEN months of service for its first payment, and that
 * is intended. billing-plans-gate's four XOR clauses asserted the old rule and are replaced there;
 * this file proves the new one.
 *
 * ── NO GATE CALLS STRIPE ────────────────────────────────────────────────────────────────────────
 * Everything Stripe would be handed is built by PURE functions in lib/billing-plans, and that is
 * exactly what is asserted: the line's interval, the amount, the tax behaviour, the coupon's
 * duration. A clause that needed a Stripe key would be a clause that never runs.
 *
 * THE ONE THING NO GATE CAN PROVE is that the live monthly Price points at the Core product. That
 * is a fact about the Stripe account, and it is checkout step B in the manual plan.
 *
 * FIXTURES on this gate's own ZZANN prefix and its own settings row, swept before and after.
 */
import './_gate-preflight.mjs';
const { gatePrisma, describeError, onTeardown } = await import('./_gate-preflight.mjs');
import './_ts.mjs';

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const R = '/Users/hugh/Developer/greasedesk-core';
const PREFIX = 'ZZANN';
const SETTINGS = 'ZZANN-settings';
const CORE = 'prod_ZZANN_CORE';

let prisma;
const sweep = async () => {
  if (!prisma) return 0;
  const reps = (await prisma.rep.findMany({ where: { ref_code: { startsWith: PREFIX } }, select: { id: true } })).map((r) => r.id);
  const groups = (await prisma.group.findMany({ where: { group_name: { startsWith: PREFIX } }, select: { id: true } })).map((g) => g.id);
  if (groups.length) {
    for (const t of ['tenantAffiliateTerms', 'tenantAttribution', 'commissionEntry', 'tenantPlanTerms', 'notificationLog', 'auditLog', 'groupBilling']) {
      await prisma[t].deleteMany({ where: { group_id: { in: groups } } }).catch(() => {});
    }
    await prisma.group.deleteMany({ where: { id: { in: groups } } }).catch(() => {});
  }
  if (reps.length) await prisma.rep.deleteMany({ where: { id: { in: reps } } }).catch(() => {});
  const s = await prisma.programmeSettings.deleteMany({ where: { id: SETTINGS } }).catch(() => ({ count: 0 }));
  return groups.length + reps.length + (s?.count ?? 0);
};

try {
  prisma = await gatePrisma();
  onTeardown(sweep);
  await sweep();

  const AM = await import(`${R}/lib/anchored-match.ts`);
  const BP = await import(`${R}/lib/billing-plans.ts`);
  const AF = await import(`${R}/lib/affiliate.ts`);

  // The six numbers, written down so the arithmetic below is checkable by eye: £75/month, a
  // 30-day trial, annual 12-for-10 = £750, the affiliate offer 12-for-8 = £600.
  const S = {
    monthlyPricePennies: 7500, trialDays: 30, newAnnualMonthsPaid: 10,
    renewalAnnualMonthsPaid: 10, offerMonthsPaid: 8, monthsGiven: 12,
  };

  // ── 1. EVERY PLAN CARRIES THE TRIAL ─────────────────────────────────────────────────────────
  console.log('— the trial, on every plan —');
  for (const kind of BP.PLAN_KINDS) {
    const p = BP.planFor(kind, S);
    check(`  ${kind}: carries the trial`, p.trialDays === 30, `trialDays=${p.trialDays}`);
  }
  check('monthly still takes NOTHING at signup', BP.planFor('monthly', S).payNowPennies === 0);
  check('  …while every annual shape takes one payment for a stated term',
    BP.PLAN_KINDS.filter((k) => k !== 'monthly').every((k) => {
      const p = BP.planFor(k, S);
      return p.payNowPennies > 0 && p.monthsPaid > 0 && p.monthsGiven === 12;
    }),
    'the invariant that SURVIVED the reversal — monthly is rolling, annual is a term');
  check('a plan with NO trial is refused, on either shape',
    !!AF.refusePlanCombination({ plan: 'annual_new', trialDays: 0 })
      && !!AF.refusePlanCombination({ plan: 'monthly', trialDays: 0 }));
  check('  …and annual WITH a trial is no longer refused',
    AF.refusePlanCombination({ plan: 'annual_offer', trialDays: 30 }) === null,
    'this is the reversal: the same call returned a refusal before 2026-10-28');

  // ── 2. THE PRICES COME FROM THE SETTINGS ────────────────────────────────────────────────────
  console.log('\n— derived, never typed —');
  check('annual is renewal months × the monthly price', BP.planFor('annual_renewal', S).payNowPennies === 75000, '£750.00');
  check('the offer is offer months × the monthly price', BP.planFor('annual_offer', S).payNowPennies === 60000, '£600.00');
  check('  …and changing the SETTING moves the price',
    BP.planFor('annual_renewal', { ...S, renewalAnnualMonthsPaid: 9 }).payNowPennies === 67500,
    '£675.00 at 12-for-9 — a Stripe Price created by hand could not do this (ruling 4)');
  check('sites multiply the annual amount', BP.planFor('annual_renewal', S, 3).payNowPennies === 225000, '3 sites, £2,250.00');
  // BEHAVIOURAL, not just a scan. The literal check below is evadable (compute 75000 some other
  // way and it passes), and renewalAnnualPennies is the number handed to Stripe as the thing the
  // subscription RENEWS at — the one figure a garage lives with for years. It has to move.
  check('the renewal amount handed to Stripe is derived, and MOVES with the setting',
    BP.renewalAnnualPennies(S) === 75000
      && BP.renewalAnnualPennies({ ...S, renewalAnnualMonthsPaid: 9 }) === 67500
      && BP.renewalAnnualPennies({ ...S, monthlyPricePennies: 9000 }) === 90000,
    '£750 at 12-for-10, £675 at 12-for-9, £900 if the monthly price moves');
  check('no hard-coded annual amount survives in lib/billing-plans',
    !/\b75000\b|\b60000\b/.test((await import('node:fs')).readFileSync(`${R}/lib/billing-plans.ts`, 'utf8')),
    'the figures in this gate are the ONLY place they are written down');

  // ── 3. WHAT STRIPE IS HANDED ────────────────────────────────────────────────────────────────
  console.log('\n— the subscription line —');
  const annualLine = BP.subscriptionLineFor(BP.planFor('annual_offer', S), {
    monthlyPriceId: 'price_monthly', coreProductId: CORE, renewalPennies: BP.renewalAnnualPennies(S),
    currency: 'gbp', quantity: 1,
  });
  check('annual is an inline price ON THE CORE PRODUCT', annualLine.price_data?.product === CORE,
    'which is why monthly and annual give identical access — see entitlement-product-gate');
  check('  …charged yearly', annualLine.price_data?.recurring?.interval === 'year');
  check('  …tax-inclusive, matching monthly and Terms v2', annualLine.price_data?.tax_behavior === 'inclusive');
  // THE CLAUSE THE WHOLE OFFER TURNS ON.
  check('THE SUBSCRIPTION IS CREATED AT THE RENEWAL PRICE, NOT THE OFFER PRICE',
    annualLine.price_data?.unit_amount === 75000,
    'a subscription created at £600 would renew at £600 for ever; the discount is a separate coupon');
  check('monthly still names the configured Price id',
    BP.subscriptionLineFor(BP.planFor('monthly', S), {
      monthlyPriceId: 'price_monthly', coreProductId: CORE, renewalPennies: 75000, currency: 'gbp', quantity: 2,
    }).price === 'price_monthly');

  // ── 4. THE OFFER IS FOR THE FIRST YEAR ONLY ─────────────────────────────────────────────────
  console.log('\n— the first invoice, and only the first —');
  const disc = BP.firstYearDiscountPennies(S);
  check('the discount is the GAP between the offer and the renewal', disc === 15000, '£150.00 = (10 − 8) × £75');
  const coupon = BP.firstYearCouponSpec(disc, 'gbp');
  check('the coupon is duration ONCE', coupon.duration === 'once',
    'forever would make the offer permanent — the defect this shape exists to avoid');
  check('  …for exactly the discount', coupon.amount_off === 15000 && coupon.currency === 'gbp');
  check('  …under a DETERMINISTIC id, so one coupon is reused and a changed setting makes a NEW one',
    BP.firstYearCouponId(disc, 'gbp') === 'gd-first-year-15000-gbp'
      && BP.firstYearCouponId(BP.firstYearDiscountPennies({ ...S, offerMonthsPaid: 6 }), 'gbp') === 'gd-first-year-30000-gbp',
    'never mutating a coupon that live subscriptions point at');
  check('no gap means NO coupon, rather than one worth nothing',
    BP.firstYearDiscountPennies({ ...S, offerMonthsPaid: 10 }) === 0,
    'offer and renewal were both 10 months until 2026-10-26 — a real state, not a hypothetical');
  check('and the offer price is what the garage pays once: renewal − discount',
    BP.renewalAnnualPennies(S) - disc === BP.planFor('annual_offer', S).payNowPennies,
    '£750 − £150 = £600 — the two routes to the number agree');

  // ── 5. WHO GETS THE OFFER — RESOLVED SERVER-SIDE ────────────────────────────────────────────
  console.log('\n— offerFor, from the group and never the request —');
  await prisma.programmeSettings.create({ data: { id: SETTINGS, ...Object.fromEntries(Object.entries({
    trial_days: S.trialDays, new_annual_months_paid: S.newAnnualMonthsPaid,
    renewal_annual_months_paid: S.renewalAnnualMonthsPaid, offer_months_paid: S.offerMonthsPaid,
    months_given: S.monthsGiven,
  })) } });
  const aff = await prisma.rep.create({ data: {
    email: `${PREFIX.toLowerCase()}@example.invalid`, name: `${PREFIX} affiliate`,
    ref_code: `${PREFIX}CODE`, country_code: 'GB', party_type: 'affiliate' }, select: { id: true } });
  const mkGarage = async (n) => {
    const g = await prisma.group.create({ data: {
      group_name: `${PREFIX} garage ${n}`, billing_email: `${PREFIX.toLowerCase()}-${n}@example.invalid`,
    }, select: { id: true } });
    // NOT .catch(() => {}). The first draft swallowed this, GroupBilling has four required
    // columns, and the row was never created — so the "has had a subscription" clause threw on an
    // update with nothing to update, four clauses after the one that was actually wrong.
    await prisma.groupBilling.create({ data: {
      group_id: g.id, plan_name: `${PREFIX} plan`, status: 'ok', retention_months: 12, included_sites: 1,
    } });
    return g.id;
  };
  const refer = (gid) => prisma.tenantAttribution.create({ data: {
    group_id: gid, party_type: 'affiliate', party_id: aff.id, role: 'referrer',
    share_bp: 10000, effective_from: new Date(), source: 'ref_param' } });

  const plain = await mkGarage('plain');
  const o1 = await AF.offerFor(prisma, plain, { settingsId: SETTINGS });
  check('an UNREFERRED garage is quoted the renewal price, with no discount',
    o1.plan === 'annual_renewal' && o1.annualPennies === 75000 && o1.discountPennies === 0 && !!o1.refusal,
    `${o1.refusal}`);

  const referred = await mkGarage('referred');
  await refer(referred);
  const o2 = await AF.offerFor(prisma, referred, { settingsId: SETTINGS });
  check('a REFERRED garage gets the offer', o2.plan === 'annual_offer' && o2.discountPennies === 15000 && o2.refusal === null);
  check('  …and the SUBSCRIPTION amount it is quoted is still the renewal figure',
    o2.annualPennies === 75000, 'what it pays once is £600; what it renews at is £750');

  // THE SWITCH GATES THE PRICE, NEVER THE ATTRIBUTION (owner, 2026-10-28).
  await AF.saveSettings(prisma, { signupsOpen: false }, { settingsId: SETTINGS });
  const o3 = await AF.offerFor(prisma, referred, { settingsId: SETTINGS });
  check('with the offer CLOSED a referred garage is quoted £750 and stays attributed',
    o3.plan === 'annual_renewal' && o3.discountPennies === 0 && o3.attributed === true && /offer/i.test(o3.refusal),
    `${o3.refusal}`);
  check('  …and the attribution row is untouched',
    (await prisma.tenantAttribution.count({ where: { group_id: referred, ended_at: null } })) === 1);
  await AF.saveSettings(prisma, { signupsOpen: true }, { settingsId: SETTINGS });

  // ── REVERSED 2026-10-29 ─────────────────────────────────────────────────────────────────────
  // This asserted that merely HOLDING an annual_offer terms row spent the offer. Under that rule
  // a referred garage that switched Yearly → Monthly → Yearly inside its trial lost £300 for
  // pressing a button twice, with nothing collected. The offer is spent when money moves under
  // it. (The refusal that now fires names PAYMENT rather than "already": hasNeverPaid and
  // alreadyTaken both read first_paid_at, so the first one reached answers. That subsumption is
  // deliberate and written down in offerFor.)
  const taken = await mkGarage('taken');
  await refer(taken);
  await BP.writePlanTerms(prisma, taken, BP.planFor('annual_offer', S));
  const o4held = await AF.offerFor(prisma, taken, { settingsId: SETTINGS });
  check('HOLDING the offer with nothing paid does not spend it',
    o4held.plan === 'annual_offer' && o4held.refusal === null,
    `${o4held.plan} / ${o4held.refusal ?? 'no refusal'} — this clause asserted the OPPOSITE until today`);
  await prisma.groupBilling.update({ where: { group_id: taken }, data: { first_paid_at: new Date() } });
  const o4 = await AF.offerFor(prisma, taken, { settingsId: SETTINGS });
  check('  …and a garage that has PAID under it cannot take it twice',
    o4.plan === 'annual_renewal' && !!o4.refusal && o4.discountPennies === 0, o4.refusal);

  // ── WHAT ENDS THE OFFER IS MONEY, NOT A TRIAL (owner ruling, 2026-10-29) ────────────────────
  // This block asserted the 2026-10-28 definition until today: a subscription that had ever
  // reached `trialing` made the garage "not new" and cost it the offer. That made the £300 turn
  // on which button was pressed at signup — a referred garage that chose monthly and switched to
  // yearly an hour later lost it, while the one that left the toggle alone kept it. The three
  // clauses below are the reversal, and the first of them is the one that was red before it.
  const trialing = await mkGarage('trialing');
  await refer(trialing);
  await prisma.groupBilling.update({ where: { group_id: trialing }, data: { stripe_subscription_id: 'sub_ZZANNT', subscription_status: 'trialing' } });
  const o5 = await AF.offerFor(prisma, trialing, { settingsId: SETTINGS });
  check('a TRIALING garage has not paid, so it keeps the offer',
    o5.plan === 'annual_offer' && o5.refusal === null && o5.discountPennies > 0,
    `${o5.plan} / ${o5.refusal ?? 'no refusal'} / ${o5.discountPennies}p — a trial is not a purchase`);

  const paid = await mkGarage('paid');
  await refer(paid);
  await prisma.groupBilling.update({ where: { group_id: paid }, data: { stripe_subscription_id: 'sub_ZZANNP', subscription_status: 'trialing', first_paid_at: new Date('2026-06-01T00:00:00Z') } });
  const o6 = await AF.offerFor(prisma, paid, { settingsId: SETTINGS });
  check('  …and a garage that HAS paid loses it, whatever its status says',
    o6.plan === 'annual_renewal' && /paid/i.test(o6.refusal ?? ''), o6.refusal);

  // THE UNRECORDED PAST. first_paid_at only starts on 2026-10-29, so a garage that paid before it
  // existed has none; an 'active' subscription is the evidence that stands in for it. Without this
  // limb the offer would be handed to an established paying tenant the day an affiliate link
  // finally resolved against its signup_ref.
  const legacy = await mkGarage('legacy');
  await refer(legacy);
  await prisma.groupBilling.update({ where: { group_id: legacy }, data: { stripe_subscription_id: 'sub_ZZANNL', subscription_status: 'active' } });
  const o7 = await AF.offerFor(prisma, legacy, { settingsId: SETTINGS });
  check('  …and an ACTIVE garage with no recorded payment is still treated as having paid',
    o7.plan === 'annual_renewal' && /paid/i.test(o7.refusal ?? ''),
    `${o7.refusal} — active is only reachable THROUGH a chargeable invoice`);

  // ── 5a. THE OFFER A GARAGE WAS REFERRED UNDER DOES NOT MOVE ─────────────────────────────────
  // Owner ruling, 2026-10-29, after the defect was caught live: GB-GD2907 was referred while
  // offer_months_paid read 6, the setting was changed to 8 eleven minutes later, and the garage's
  // first year moved from £450 to £600. The Engine Room promises the opposite. Done against this
  // gate's OWN settings row, so the change is literal rather than simulated.
  console.log('\n— the offer a garage was referred under does not move —');
  const frozenGarage = await mkGarage('frozen');
  await refer(frozenGarage);
  await AF.freezeTermsAtSignup(prisma, frozenGarage, {
    affiliateId: aff.id, totalRewardPennies: 12000, instalmentPennies: 3000,
  }, { settingsId: SETTINGS });
  const frozenRow = await prisma.tenantAffiliateTerms.findUnique({ where: { group_id: frozenGarage },
    select: { offer_months_paid: true, months_given: true } });
  check('signing up FREEZES the garage\'s own offer, not just the affiliate reward',
    frozenRow?.offer_months_paid === S.offerMonthsPaid && frozenRow?.months_given === S.monthsGiven,
    `${JSON.stringify(frozenRow)} vs offer ${S.offerMonthsPaid} / given ${S.monthsGiven}`);
  const beforeChange = await AF.offerFor(prisma, frozenGarage, { settingsId: SETTINGS });

  // NOW MOVE THE SETTING, exactly as the Engine Room would.
  const NEW_OFFER = S.offerMonthsPaid - 2;      // 8 → 6: a BIGGER discount, so a mistake shows up as money lost
  await AF.saveSettings(prisma, { offerMonthsPaid: NEW_OFFER }, { settingsId: SETTINGS });
  const afterChange = await AF.offerFor(prisma, frozenGarage, { settingsId: SETTINGS });
  check('  …so changing the setting afterwards moves NEITHER its price NOR its months',
    afterChange.discountPennies === beforeChange.discountPennies && afterChange.monthsPaid === S.offerMonthsPaid
      && afterChange.offerFrozen === true,
    `discount ${beforeChange.discountPennies}p → ${afterChange.discountPennies}p | months ${afterChange.monthsPaid} | frozen ${afterChange.offerFrozen}`);

  // AND A GARAGE REFERRED AFTERWARDS GETS THE NEW VALUE — without this the clause above would pass
  // against a freeze that had simply stopped reading the settings at all.
  const laterGarage = await mkGarage('later');
  await refer(laterGarage);
  await AF.freezeTermsAtSignup(prisma, laterGarage, {
    affiliateId: aff.id, totalRewardPennies: 12000, instalmentPennies: 3000,
  }, { settingsId: SETTINGS });
  const later = await AF.offerFor(prisma, laterGarage, { settingsId: SETTINGS });
  check('  …while a garage referred AFTERWARDS gets the new value',
    later.monthsPaid === NEW_OFFER && later.discountPennies === (S.renewalAnnualMonthsPaid - NEW_OFFER) * S.monthlyPricePennies,
    `months ${later.monthsPaid} (expected ${NEW_OFFER}) | discount ${later.discountPennies}p`);

  // A GARAGE WITH NO FROZEN ROW STILL READS THE LIVE SETTING. Rows written before the column
  // existed have no honest value; they must keep the behaviour they have always had.
  const unfrozen = await mkGarage('unfrozen');
  await refer(unfrozen);
  const unf = await AF.offerFor(prisma, unfrozen, { settingsId: SETTINGS });
  check('  …and a referral with NO frozen terms falls back to the live setting',
    unf.monthsPaid === NEW_OFFER && unf.offerFrozen === false, `months ${unf.monthsPaid} | frozen ${unf.offerFrozen}`);
  await AF.saveSettings(prisma, { offerMonthsPaid: S.offerMonthsPaid }, { settingsId: SETTINGS });

  // ── AND THE RENEWAL IS DELIBERATELY NOT FROZEN (owner ruling, 2026-10-29) ───────────────────
  // £750 is the list price, read at checkout; once a garage subscribes Stripe holds the amount.
  // Freezing it before anyone subscribes would promise "£750 a year for ever" to everyone who
  // ever followed a referral link. So this asserts the two halves DISAGREE on purpose: the
  // renewal moves with the setting while the frozen first year does not.
  const beforeRenewal = await AF.offerFor(prisma, frozenGarage, { settingsId: SETTINGS });
  await prisma.programmeSettings.update({ where: { id: SETTINGS },
    data: { renewal_annual_months_paid: S.renewalAnnualMonthsPaid + 1 } });
  const afterRenewal = await AF.offerFor(prisma, frozenGarage, { settingsId: SETTINGS });
  check('the RENEWAL is NOT frozen — it moves with the list price',
    afterRenewal.annualPennies === (S.renewalAnnualMonthsPaid + 1) * S.monthlyPricePennies
      && afterRenewal.annualPennies !== beforeRenewal.annualPennies,
    `${beforeRenewal.annualPennies}p → ${afterRenewal.annualPennies}p`);
  check('  …while the FROZEN first year does not move with it',
    afterRenewal.annualPennies - afterRenewal.discountPennies === S.offerMonthsPaid * S.monthlyPricePennies,
    `first year ${afterRenewal.annualPennies - afterRenewal.discountPennies}p, expected ${S.offerMonthsPaid * S.monthlyPricePennies}p — the COUPON absorbs the renewal change`);
  await prisma.programmeSettings.update({ where: { id: SETTINGS },
    data: { renewal_annual_months_paid: S.renewalAnnualMonthsPaid } });

  // ── 5a-ii. THE RECORD AGREES WITH THE MONEY ─────────────────────────────────────────────────
  // Checkout C: Stripe charged £450 under a six-month freeze while the webhook wrote
  // `paid_now_pennies 60000 / months_paid 8` into TenantPlanTerms from TODAY's settings. The
  // document of what a garage agreed to contradicted what it was being charged. The webhook now
  // builds its plan through planForGarage, so the frozen months reach the timeline too.
  console.log('\n— the terms row records the FROZEN months, not today\'s —');
  const recGarage2 = await mkGarage('terms-frozen');
  await refer(recGarage2);
  await AF.freezeTermsAtSignup(prisma, recGarage2, {
    affiliateId: aff.id, totalRewardPennies: 12000, instalmentPennies: 3000,
  }, { settingsId: SETTINGS });
  const FROZEN_AT = S.offerMonthsPaid;                 // 8 at signup
  await AF.saveSettings(prisma, { offerMonthsPaid: FROZEN_AT - 2 }, { settingsId: SETTINGS });

  const pfg = await AF.planForGarage(prisma, recGarage2, 'annual_offer', { settingsId: SETTINGS });
  check('planForGarage charges the FROZEN months after the setting moved',
    pfg.plan.monthsPaid === FROZEN_AT && pfg.plan.payNowPennies === FROZEN_AT * S.monthlyPricePennies,
    `months ${pfg.plan.monthsPaid} (frozen ${FROZEN_AT}) | payNow ${pfg.plan.payNowPennies}p`);
  // THE DISCRIMINATOR: planFor on today's settings gives the OTHER answer, so the clause above is
  // not passing because both happen to agree.
  const naive = BP.planFor('annual_offer', { ...S, offerMonthsPaid: FROZEN_AT - 2 });
  check('  …and the naive answer really is different', naive.monthsPaid !== pfg.plan.monthsPaid,
    `naive ${naive.monthsPaid} vs frozen ${pfg.plan.monthsPaid}`);
  await AF.saveSettings(prisma, { offerMonthsPaid: S.offerMonthsPaid }, { settingsId: SETTINGS });

  // ── 5a-iii. THE COUPON MOVES WITH THE PLAN, BOTH WAYS ───────────────────────────────────────
  // Read off the PARAMETERS a switch sends to Stripe (lib/plan-switch), not off the source. A
  // gate never calls Stripe; this is the object that would be sent.
  console.log('\n— the coupon attaches going to yearly and comes OFF going to monthly —');
  const PS = await import(`${R}/lib/plan-switch.ts`);
  const line = { price_data: { product: CORE, currency: 'gbp', unit_amount: 75000, recurring: { interval: 'year' } } };
  const toYearly = PS.planSwitchParams({ itemId: 'si_ZZ', line, quantity: 1, trialEnd: 1800000000,
    metadata: { gd_plan: 'annual_offer' }, couponId: 'gd-first-year-15000-gbp' });
  const toMonthly = PS.planSwitchParams({ itemId: 'si_ZZ', line: { price: 'price_ZZ' }, quantity: 1, trialEnd: 1800000000,
    metadata: { gd_plan: 'monthly' }, couponId: null });
  check('switching to YEARLY sends the coupon',
    JSON.stringify(toYearly.discounts) === JSON.stringify([{ coupon: 'gd-first-year-15000-gbp' }]),
    JSON.stringify(toYearly.discounts));
  check('  …and switching to MONTHLY sends the EMPTY STRING, which is what Stripe documents as the clear',
    toMonthly.discounts === '',
    `${JSON.stringify(toMonthly.discounts)} — [] means "leave the discounts unchanged", the exact opposite`);
  check('  …and neither switch moves the trial end',
    toYearly.trial_end === 1800000000 && toMonthly.trial_end === 1800000000,
    'a switch changes what a garage is charged, never the date it was told it would be charged');
  check('  …and both state proration explicitly', toYearly.proration_behavior === 'none' && toMonthly.proration_behavior === 'none');

  // ── 5a-iii-b. WHAT ACTUALLY GOES ON THE WIRE ────────────────────────────────────────────────
  // THE CLAUSES ABOVE PASSED ON THE DAY THE REMOVAL DID NOT WORK, and they were right to: the
  // object was `{ discounts: [] }`, which is what they asserted. Rehearsal D1 found a garage
  // switched to monthly still carrying its £300 once-only coupon, with the first £75 invoice
  // reading £0.00. Two separate faults sat under that, and an assertion on OUR object could not
  // see either:
  //   1. Stripe treats an empty ARRAY as "leave the discounts unchanged" (its own words, in
  //      node_modules/stripe/cjs/resources/Subscriptions.d.ts). Only the empty STRING clears.
  //   2. stripe-node form-encodes its parameters, and an empty array encodes to NOTHING. The
  //      field never left the process: `{ discounts: [] }` serialises to "".
  //
  // So this asks stripe-node itself what it would send, through its PUBLIC transport hook, with a
  // fetch that records the body and answers from memory. No network, no key, no account — the
  // gate header's "no gate calls Stripe" still holds — but the subject is now the request rather
  // than our object. Fault 2 alone would have turned this red.
  const StripeLib = (await import('stripe')).default;
  let wire = null;
  const recorder = new StripeLib('sk_test_gate_does_not_call_stripe', {
    httpClient: StripeLib.createFetchHttpClient(async (_url, init) => {
      wire = String(init?.body ?? '');
      return new Response('{"id":"sub_ZZ","object":"subscription"}', { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  });
  const bodyFor = async (params) => { wire = null; await recorder.subscriptions.update('sub_ZZ', params); return wire; };
  const wireMonthly = await bodyFor(toMonthly);
  const wireYearly = await bodyFor(toYearly);
  check('the REMOVAL reaches the wire — stripe-node sends `discounts=`',
    /(^|&)discounts=(&|$)/.test(wireMonthly ?? ''), wireMonthly);
  check('  …and the ATTACH reaches it as a coupon',
    (wireYearly ?? '').includes('discounts[0][coupon]=gd-first-year-15000-gbp'), wireYearly);
  // THE DISCRIMINATOR. The shape this gate asserted until today, run through the same transport:
  // it vanishes entirely, which is why D1 failed while every clause was green.
  const wireOldWay = await bodyFor({ ...toMonthly, discounts: [] });
  check('  …and the EMPTY ARRAY this replaced sends no discounts field at all',
    !/discounts/.test(wireOldWay ?? ''),
    `${wireOldWay} — an assertion on the object could not tell these two apart`);

  // ── 5a-iii-c. A PAID YEAR CANNOT DROP TO MONTHLY ────────────────────────────────────────────
  // Not the same question as `trialing`, which is what the code leaned on. A subscription can
  // read trialing with money already taken (a trial extended in the dashboard after a charge, a
  // pause and resume), and in that gap the switch was offered and change-plan took it.
  console.log('\n— a garage that has paid for the year cannot switch to monthly —');
  const PAID = new Date('2026-06-01T00:00:00Z');
  check('annual + money taken locks the switch',
    BP.annualPaidIn({ plan: 'annual_offer', firstPaidAt: PAID }) === true);
  check('  …on every annual shape, not just the offer',
    BP.PLAN_KINDS.filter((k) => k !== 'monthly').every((k) => BP.annualPaidIn({ plan: k, firstPaidAt: PAID })),
    BP.PLAN_KINDS.join(','));
  check('  …but an annual garage still in its trial keeps the door open',
    BP.annualPaidIn({ plan: 'annual_renewal', firstPaidAt: null }) === false,
    'nothing is collected during a trial, which is the whole window the switch lives in');
  check('  …and a MONTHLY garage that has paid is not locked by this rule',
    BP.annualPaidIn({ plan: 'monthly', firstPaidAt: PAID }) === false,
    'this is "a paid year is not given back a month at a time", not "paying closes the door"');

  // ── 5a-iv. A TRIAL SWITCH IS NOT TAKING THE OFFER ───────────────────────────────────────────
  // Holding the offer for an hour during a trial used to spend it: Yearly → Monthly → Yearly cost
  // £300 for pressing a button twice, with nothing collected. The offer is spent when money moves.
  console.log('\n— a switch during the trial does not spend the offer —');
  const switcher = await mkGarage('switcher');
  await refer(switcher);
  await AF.freezeTermsAtSignup(prisma, switcher, {
    affiliateId: aff.id, totalRewardPennies: 12000, instalmentPennies: 3000,
  }, { settingsId: SETTINGS });
  await BP.writePlanTerms(prisma, switcher, BP.planFor('annual_offer', S));   // took it…
  await BP.writePlanTerms(prisma, switcher, BP.planFor('monthly', S));        // …switched away…
  const stillOffered = await AF.offerFor(prisma, switcher, { settingsId: SETTINGS });
  check('a garage that HELD the offer but paid nothing keeps it',
    stillOffered.plan === 'annual_offer' && stillOffered.refusal === null && stillOffered.discountPennies > 0,
    `${stillOffered.plan} / ${stillOffered.refusal ?? 'no refusal'}`);
  await prisma.groupBilling.update({ where: { group_id: switcher }, data: { first_paid_at: new Date() } });
  const afterPaying = await AF.offerFor(prisma, switcher, { settingsId: SETTINGS });
  check('  …and loses it the moment a non-zero invoice is PAID under it',
    afterPaying.plan === 'annual_renewal' && !!afterPaying.refusal, afterPaying.refusal);
  await prisma.groupBilling.update({ where: { group_id: switcher }, data: { first_paid_at: null } });

  // ── 5b. THE WRITER OF THE EVIDENCE ──────────────────────────────────────────────────────────
  // The clauses above read first_paid_at. This block is about who PUTS it there — without it the
  // whole rule rests on a column that nothing is proved to write, which is how a rule becomes a
  // permanently-NULL field that silently grants the offer for ever. No Stripe call: the handler
  // takes an invoice-shaped object, so the gate hands it one.
  console.log('\n— recording the first payment —');
  const CACHE = await import(`${R}/lib/stripe-billing-cache.ts`);
  const recGarage = await mkGarage('rec');
  const CUST = `cus_${PREFIX}REC`;
  await prisma.groupBilling.update({ where: { group_id: recGarage }, data: { stripe_customer_id: CUST } });
  const invoiceOf = (amountPaid, paidAtIso) => ({
    id: `in_${PREFIX}_${amountPaid}_${paidAtIso}`, customer: CUST, amount_paid: amountPaid,
    status_transitions: { paid_at: Math.floor(new Date(paidAtIso).getTime() / 1000) },
  });
  const paidAtOf = async () => (await prisma.groupBilling.findUnique({ where: { group_id: recGarage }, select: { first_paid_at: true } }))?.first_paid_at ?? null;

  // THE £0 TRIAL INVOICE. Every garage gets one at checkout, and treating it as a payment would
  // make every garage ineligible the instant it signed up — the old bug with a new cause.
  const zero = await CACHE.recordFirstPayment(prisma, invoiceOf(0, '2026-03-01T00:00:00Z'));
  check('a ZERO invoice is not a payment', zero === 'not a payment' && (await paidAtOf()) === null, zero);

  const first = await CACHE.recordFirstPayment(prisma, invoiceOf(75000, '2026-04-01T00:00:00Z'));
  const afterFirst = await paidAtOf();
  check('  …and a non-zero one is stamped, at the time it was PAID',
    first === 'recorded' && afterFirst?.toISOString() === '2026-04-01T00:00:00.000Z', `${first} / ${afterFirst?.toISOString()}`);

  // WRITTEN ONCE. This is the date we were FIRST paid; a later invoice moving it would turn the
  // column into "last paid" under the same name, and a re-delivered webhook must be a no-op.
  const second = await CACHE.recordFirstPayment(prisma, invoiceOf(75000, '2026-09-01T00:00:00Z'));
  check('  …and a LATER payment does not move it',
    second === 'already recorded' && (await paidAtOf())?.toISOString() === '2026-04-01T00:00:00.000Z', second);

  const stranger = await CACHE.recordFirstPayment(prisma, { id: 'in_nobody', customer: 'cus_NOBODY', amount_paid: 50000, status_transitions: { paid_at: 1 } });
  check('  …and an invoice for a customer we do not know is skipped, not thrown',
    stranger === 'unknown customer', stranger);

  // AND IT REACHES THE RULE. Proving the writer and the reader separately leaves the join untested.
  await refer(recGarage);
  const oRec = await AF.offerFor(prisma, recGarage, { settingsId: SETTINGS });
  check('  …and the stamp the handler wrote is what ends the offer',
    oRec.plan === 'annual_renewal' && /paid/i.test(oRec.refusal ?? ''), oRec.refusal);

  // ── 5c. TWO WEBHOOKS RACING ON ONE SUBSCRIPTION ─────────────────────────────────────────────
  // Checkout B put two identical annual_renewal rows on GB-GD2491: this handler runs for
  // `checkout.session.completed` AND `customer.subscription.created`, they arrived 168ms apart,
  // both read `monthly`, and both wrote. The compare has moved inside writePlanTerms, under a
  // FOR UPDATE on the garage's Group row, so the loser blocks and then finds nothing to do.
  console.log('\n— two webhooks racing on one subscription —');
  const raceGarage = await mkGarage('race');
  const RACE_CUST = `cus_${PREFIX}RACE`;
  await prisma.groupBilling.update({ where: { group_id: raceGarage }, data: { stripe_customer_id: RACE_CUST } });
  await BP.writePlanTerms(prisma, raceGarage, BP.planFor('monthly', S));
  const subOf = (shape) => ({
    id: `sub_${PREFIX}RACE`, status: 'trialing', customer: RACE_CUST,
    current_period_end: null, trial_end: null, metadata: { gd_plan: shape },
    items: { data: [{ quantity: 1, price: { id: `price_${PREFIX}RACE`, product: CORE } }] },
  });

  // ── WHY THERE IS A WARM-UP, AND WHY THE CLAUSE AFTER IT IS NOT THE PROOF ────────────────────
  // MEASURED, 2026-10-29: two interactive transactions on this client get DISTINCT backend pids
  // but do not overlap — two 400ms statements took 733ms wall, because opening the second pooled
  // connection costs ~300ms, which is longer than the whole first transaction. So a "fire two and
  // count the rows" clause passes with the lock REMOVED: the second writer genuinely reads after
  // the first has committed. It is a true statement about the outcome and it proves nothing about
  // the lock. The warm-up opens both connections first so the race at least has a window; the
  // clause that actually discriminates is the blocking one further down.
  await Promise.all([
    prisma.$queryRaw`SELECT 1 AS warm`,
    prisma.$queryRaw`SELECT 2 AS warm`,
    prisma.$queryRaw`SELECT 3 AS warm`,
  ]);

  const beforeDirect = await prisma.tenantPlanTerms.count({ where: { group_id: raceGarage } });
  const direct = await Promise.allSettled([
    BP.writePlanTerms(prisma, raceGarage, BP.planFor('annual_renewal', S)),
    BP.writePlanTerms(prisma, raceGarage, BP.planFor('annual_renewal', S)),
  ]);
  const afterDirect = await prisma.tenantPlanTerms.count({ where: { group_id: raceGarage } });
  check('two concurrent writers append exactly ONE row', afterDirect - beforeDirect === 1, `${beforeDirect} → ${afterDirect}`);
  check('  …and NEITHER of them throws', direct.every((r) => r.status === 'fulfilled'),
    direct.map((r) => r.status === 'rejected' ? describeError(r.reason) : 'ok').join(' | '));
  check('  …and both are handed the same row back, so a caller cannot tell which one won',
    direct.every((r) => r.status === 'fulfilled') && direct[0].value?.id === direct[1].value?.id,
    `${direct[0].value?.id} vs ${direct[1].value?.id} — the loser returns the tail it found, not null`);

  // AND THROUGH THE HANDLER, which is where it actually happened.
  const switchGarage = await mkGarage('switch');
  const SW_CUST = `cus_${PREFIX}SWITCH`;
  await prisma.groupBilling.update({ where: { group_id: switchGarage }, data: { stripe_customer_id: SW_CUST } });
  await BP.writePlanTerms(prisma, switchGarage, BP.planFor('monthly', S));
  const swSub = { ...subOf('annual_renewal'), id: `sub_${PREFIX}SWITCH`, customer: SW_CUST };
  const viaHandler = await Promise.allSettled([
    CACHE.applyStripeSubscriptionToCache(swSub, switchGarage),
    CACHE.applyStripeSubscriptionToCache(swSub, switchGarage),
  ]);
  const swRows = await prisma.tenantPlanTerms.findMany({ where: { group_id: switchGarage }, orderBy: { effective_from: 'asc' }, select: { plan: true } });
  check('the two REAL handlers, fired together, leave one monthly row and one annual row',
    swRows.length === 2 && swRows[0].plan === 'monthly' && swRows[1].plan === 'annual_renewal',
    JSON.stringify(swRows.map((r) => r.plan)));
  check('  …and neither handler throws', viaHandler.every((r) => r.status === 'fulfilled'),
    viaHandler.map((r) => r.status === 'rejected' ? describeError(r.reason) : 'ok').join(' | '));

  // ── THE CLAUSE THAT ACTUALLY TESTS THE LOCK ─────────────────────────────────────────────────
  // Rather than hoping the scheduler interleaves, this holds the lock open and watches the second
  // writer WAIT for it. The first half is hand-rolled — it has to keep its transaction open, which
  // the real function deliberately does not — but the second half is the real writePlanTerms, and
  // what is asserted is that it blocks and then finds nothing to do. Remove the FOR UPDATE and the
  // first of these two clauses goes red immediately: nothing makes the second writer wait.
  console.log('\n— and the second writer WAITS for the lock —');
  const lockGarage = await mkGarage('lock');
  await BP.writePlanTerms(prisma, lockGarage, BP.planFor('monthly', S));
  let releaseHolder; const holderMayCommit = new Promise((r) => { releaseHolder = r; });
  let lockTaken; const lockIsHeld = new Promise((r) => { lockTaken = r; });
  let loserSettled = false;

  const holder = prisma.$transaction(async (tx) => {
    // THE SAME MODE THE WRITER USES. With FOR UPDATE here the clause below passed even when the
    // writer's own lock was removed: the loser blocked on the foreign key's FOR KEY SHARE instead,
    // which FOR UPDATE conflicts with and FOR NO KEY UPDATE does not. Matching the writer is what
    // makes the clause measure the lock rather than the FK.
    await tx.$queryRaw`SELECT 1 FROM "Group" WHERE id = ${lockGarage} FOR NO KEY UPDATE`;
    const inserted = await tx.tenantPlanTerms.create({
      data: { group_id: lockGarage, plan: 'annual_renewal', months_paid: 10, months_given: 12,
              paid_now_pennies: 75000, trial_days: 30, effective_from: new Date() },
      select: { id: true },
    });
    lockTaken(inserted.id);          // the loser may start now; the lock is genuinely held
    await holderMayCommit;           // …and is held until this resolves
    return inserted.id;
  }, { timeout: 20000, maxWait: 20000 });

  const winnerId = await lockIsHeld;
  const loser = BP.writePlanTerms(prisma, lockGarage, BP.planFor('annual_renewal', S))
    .then((r) => { loserSettled = true; return r; }, (e) => { loserSettled = true; throw e; });
  await new Promise((r) => setTimeout(r, 1200));
  check('a second writer BLOCKS while the first holds the lock', loserSettled === false,
    loserSettled ? 'it returned while the lock was still held — nothing serialised it' : 'still waiting after 1.2s, as it must');

  releaseHolder();
  await holder;
  const loserRow = await loser;
  const lockRows = await prisma.tenantPlanTerms.count({ where: { group_id: lockGarage } });
  check('  …and once the winner commits, the loser writes NOTHING', lockRows === 2, `${lockRows} rows (monthly + one annual)`);
  check('  …and is handed the winner\'s row', loserRow?.id === winnerId, `${loserRow?.id} vs ${winnerId}`);

  // ── 5d. THE CHOKEPOINT IS THE ONLY DOOR ─────────────────────────────────────────────────────
  // The lock protects writePlanTerms. Any other module writing TenantPlanTerms directly walks
  // straight past it, and the race comes back somewhere nobody is looking — so the SET of writers
  // is asserted, not just the behaviour of the one that was fixed.
  const fsx = await import('node:fs'); // `const fs` below is declared LATER; const does not hoist
  const strip = (src) => src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l)).join('\n');
  const walk = (dir) => fsx.readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : /\.tsx?$/.test(e.name) ? [`${dir}/${e.name}`] : []));
  const sourceFiles = [...walk('lib'), ...walk('pages')].filter((f) => f !== 'lib/billing-plans.ts');
  const WRITE = /tenantPlanTerms\s*\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)/;
  const outsideWriters = sourceFiles.filter((f) => WRITE.test(strip(fsx.readFileSync(f, 'utf8'))));
  check('nothing outside lib/billing-plans WRITES TenantPlanTerms', outsideWriters.length === 0,
    outsideWriters.join(', ') || 'none — every append goes through the locked chokepoint');
  // THE DISCRIMINATOR: a scan that finds nothing proves nothing unless the term it scans for would
  // have found the real thing. lib/billing-plans itself must match.
  check('  …and the scan would have found one — billing-plans itself matches',
    WRITE.test(strip(fsx.readFileSync('lib/billing-plans.ts', 'utf8'))),
    'otherwise the clause above passes against a regex that matches nothing anywhere');

  // ── 6. THE TERMS ROW RECORDS BOTH, WHICH THE OLD CHECK FORBADE ──────────────────────────────
  console.log('\n— what the timeline records —');
  const termsGarage = await mkGarage('terms');
  const row = await BP.writePlanTerms(prisma, termsGarage, BP.planFor('annual_offer', S));
  check('an annual row carries BOTH a trial and a payment',
    row.trial_days === 30 && row.paid_now_pennies === 60000,
    'the TenantPlanTerms_trial_xor_paynow CHECK forbade exactly this until the 2026-10-28 migration');
  const mRow = await BP.writePlanTerms(prisma, await mkGarage('terms-m'), BP.planFor('monthly', S));
  check('  …and a monthly row still records NULL rather than a payment of nothing',
    mRow.trial_days === 30 && mRow.paid_now_pennies === null && mRow.months_paid === null);
  check('switching plan APPENDS, it never rewrites what was signed up under',
    (await prisma.tenantPlanTerms.count({ where: { group_id: termsGarage } })) === 1
      && !!(await BP.writePlanTerms(prisma, termsGarage, BP.planFor('monthly', S)))
      && (await prisma.tenantPlanTerms.count({ where: { group_id: termsGarage } })) === 2
      && (await BP.signupPlanTerms(prisma, termsGarage)).plan === 'annual_offer'
      && (await BP.currentPlanTerms(prisma, termsGarage)).plan === 'monthly',
    'earliest row = what they signed up under; latest = what they are on');

  // ── 7. THE SWITCH IS A TRIAL-ONLY DOOR, AND THE REMINDER EXISTS ─────────────────────────────
  console.log('\n— the switch, and the warning before money moves —');
  const fs = await import('node:fs');
  const swSrc = fs.readFileSync(`${R}/pages/api/stripe/change-plan.ts`, 'utf8');
  check('the plan switch refuses once the subscription is no longer trialing',
    /sub\.status !== 'trialing'/.test(swSrc) && /TRIAL_OVER/.test(swSrc),
    'after the first charge a switch is a credit note and a proration — out of scope, so refused');
  check('  …and it reads that status from STRIPE, not from the cache',
    /subscriptions\.retrieve\(/.test(swSrc),
    'a cached `trialing` that went active ten minutes ago would reprice a paid subscription');
  check('  …with proration explicitly off, not merely defaulted',
    AM.hasKey(swSrc, 'proration_behavior', /'none'/),
    'a raw /proration_behavior/ would also match the word in a comment saying we do NOT set it');
  check('  …and the body chooses a SHAPE; the price comes from offerFor',
    // TOLERANT OF OPTIONS, STRICT ABOUT THE SUBJECT. This matched `offerFor(prisma, groupId)`
    // exactly and went red the moment the settings were passed in — a scan failing on a comma
    // while the behaviour it describes is untouched. (It is a source scan at all only until the
    // change-plan work replaces it with a clause reading the discount off the subscription.)
    /offerFor\(prisma, groupId[,)]/.test(swSrc) && !/req\.body[^\n]*amount/i.test(swSrc));
  // NO SOURCE SCAN FOR THE PAID-YEAR REFUSAL. There was one, asserting that `annualPaidIn` and
  // `ANNUAL_PAID` appear and in that order, and a red-proof walked straight through it: changing
  // the guard to `if (false && …)` left every token in place and the clause green. It lives in
  // plan-choice-gate instead, as a POST to the real endpoint — which also pins the ORDER, since
  // a guard below the Stripe retrieve answers 502 on a fixture subscription id instead of 409.
  // A SOURCE SCAN, AND WHY THAT IS WHAT IS LEFT. D1 left the licences screen saying "you're on
  // the yearly plan" after a switch to monthly, because the page reads the TAIL of the terms
  // timeline and only the WEBHOOK wrote it — the browser reloads the instant this handler
  // returns, a second or so before the event lands. Nothing short of driving the real endpoint
  // catches that, and the endpoint retrieves a Stripe subscription, which no gate has. So the
  // handler appends the row itself and this asserts the call exists. It would NOT notice the
  // call being moved after the response, and that is the limit worth knowing.
  check('  …and it appends the terms row ITSELF, rather than leaving the screen to wait for the webhook',
    /writePlanTerms\(prisma, groupId, plan\)/.test(swSrc),
    'the licences page reads the tail of that timeline; the reader and the writer were on different clocks');

  const TPL = await import(`${R}/lib/notification-templates.ts`);
  // NAMED, NOT GUESSED. This read `TPL.TEMPLATES ?? TPL.default ?? {}` and the export is
  // NOTIFICATION_TEMPLATES — so the fallback turned a wrong name into "there is no template",
  // which is a false NEGATIVE dressed as a finding. A missing export should throw here.
  if (!TPL.NOTIFICATION_TEMPLATES) throw new Error('lib/notification-templates exports no NOTIFICATION_TEMPLATES');
  const tpl = TPL.NOTIFICATION_TEMPLATES.trial_ending;
  check('a trial-ending template exists', !!tpl, 'nothing sent one before 2026-10-28');
  check('  …and it is a known template key, so sendNotification will accept it',
    TPL.isTemplateKey('trial_ending'));
  const mail = tpl?.email?.({ name: 'A', when: '27 November 2026', planLabel: 'annual', amount: '£600.00', note: 'It renews at £750.00 a year after that.', link: 'https://x.test/a' });
  check('  …and it names the PLAN, the AMOUNT and the DATE',
    /annual/.test(mail?.html ?? '') && /£600\.00/.test(mail?.html ?? '') && /27 November 2026/.test(mail?.html ?? ''),
    '"your trial is ending" answers none of the three questions a person actually has');
  check('  …and says what it renews at when the first year is discounted',
    /£750\.00/.test(mail?.html ?? ''));
  const wh = fs.readFileSync(`${R}/pages/api/stripe/webhook.ts`, 'utf8');
  check('and the webhook actually listens for trial_will_end',
    /case 'customer\.subscription\.trial_will_end'/.test(wh),
    'a template nothing sends is not a reminder');
} catch (e) {
  console.log(`\n✗ THREW: ${describeError(e).slice(0, 700)}`);
  out.push('F');
} finally {
  const left = await sweep().catch(() => -1);
  check('teardown removed every fixture row (ZZ only)', left >= 0, left < 0 ? 'sweep threw — check for ZZANN by hand' : `${left} row(s)`);
  console.log(`\n${out.filter((x) => x === 'F').length} failures of ${out.length}`);
  await prisma?.$disconnect();
  process.exit(out.includes('F') ? 1 : 0);
}
