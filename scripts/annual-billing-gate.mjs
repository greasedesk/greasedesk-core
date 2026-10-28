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

  const taken = await mkGarage('taken');
  await refer(taken);
  await BP.writePlanTerms(prisma, taken, BP.planFor('annual_offer', S));
  const o4 = await AF.offerFor(prisma, taken, { settingsId: SETTINGS });
  check('a garage that ALREADY took the offer cannot take it twice',
    o4.plan === 'annual_renewal' && /already/i.test(o4.refusal), o4.refusal);

  const live = await mkGarage('live');
  await refer(live);
  await prisma.groupBilling.update({ where: { group_id: live }, data: { stripe_subscription_id: 'sub_ZZANN', subscription_status: 'active' } });
  const o5 = await AF.offerFor(prisma, live, { settingsId: SETTINGS });
  check('a garage that has HAD a subscription is not a new garage',
    /new garage/i.test(o5.refusal ?? ''), o5.refusal);

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
    /offerFor\(prisma, groupId\)/.test(swSrc) && !/req\.body[^\n]*amount/i.test(swSrc));

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
