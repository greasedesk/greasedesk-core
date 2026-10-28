/**
 * File: scripts/billing-plans-gate.mjs
 * @gate-requires: db
 *
 * THE PLAN SHAPES, AND THE ARITHMETIC THAT PRICES THEM.
 *
 * ── THE RULE EVERYTHING HERE TURNS ON (REVERSED 2026-10-28) ─────────────────────────────────────
 * It was TRIAL OR PAY NOW, NEVER BOTH (owner, 2026-10-24): annual paid at the front and had no
 * trial, because the trial WAS the discount. The offer changed on 2026-10-28 — every garage gets
 * the 30-day trial whatever plan it picks, and is charged its plan when the trial ends, so an
 * annual garage gets thirteen months of service for its first payment, deliberately.
 *
 * What survives is the SHAPE rule: monthly is rolling, so it takes nothing up front and names no
 * term; every annual shape takes one payment for a stated number of months. That is what is
 * asserted below, over every shape the module says it can sell rather than over hand-written
 * cases. The trial clauses now live in annual-billing-gate with the rest of the reversal.
 *
 * These clauses began life in affiliate-gate, written before any of the code. They live here
 * because the plans are their own subject and ship a stage earlier; affiliate-gate keeps the
 * clauses about rewards, attribution and who may take the offer.
 *
 * ── FIXTURES ────────────────────────────────────────────────────────────────────────────────────
 * Groups prefixed ZZBP and a settings row of this gate's own, swept before and after and
 * REGISTERED. Nothing here touches the live settings singleton or any real tenant: gates run
 * against the production database, and on 2026-10-25 one of them changed a public offer.
 */
import './_gate-preflight.mjs';
const { gatePrisma, describeError, onTeardown } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { readFileSync, readdirSync, statSync, existsSync } = await import('node:fs');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const R = '/Users/hugh/Developer/greasedesk-core';
const PREFIX = 'ZZBP';
const GATE_SETTINGS = 'ZZBP-settings';

let prisma;
const sweep = async () => {
  if (!prisma) return 0;
  const groups = (await prisma.group.findMany({ where: { group_name: { startsWith: PREFIX } }, select: { id: true } })).map((g) => g.id);
  if (groups.length) {
    await prisma.tenantPlanTerms.deleteMany({ where: { group_id: { in: groups } } }).catch(() => {});
    await prisma.group.deleteMany({ where: { id: { in: groups } } }).catch(() => {});
  }
  const settings = await prisma.programmeSettings.deleteMany({ where: { id: GATE_SETTINGS } }).catch(() => ({ count: 0 }));
  return groups.length + (settings?.count ?? 0);
};

try {
  prisma = await gatePrisma();
  onTeardown(sweep);
  await sweep();

  const BP = await import(`${R}/lib/billing-plans.ts`);
  const PS = await import(`${R}/lib/programme-settings.ts`);
  const S = { monthlyPricePennies: 7500, trialDays: 30, newAnnualMonthsPaid: 9, renewalAnnualMonthsPaid: 10, offerMonthsPaid: 6, monthsGiven: 12 };

  // ── 1. ROLLING OR A TERM, AND EVERY PLAN CARRIES THE TRIAL ──────────────────────────────────
  console.log('— rolling or a term, and always a trial —');
  check('the module names every plan shape it can sell', Array.isArray(BP.PLAN_KINDS) && BP.PLAN_KINDS.length >= 4,
    JSON.stringify(BP.PLAN_KINDS));
  for (const kind of BP.PLAN_KINDS ?? []) {
    const p = BP.planFor(kind, S);
    const rolling = kind === 'monthly';
    check(`  ${kind}: ${rolling ? 'rolling — no payment up front, no term' : 'a term — one payment, months named'}`,
      rolling
        ? (p.payNowPennies === 0 && p.monthsPaid === null && p.monthsGiven === null)
        : (p.payNowPennies > 0 && p.monthsPaid > 0 && p.monthsGiven > 0),
      `payNow=${p.payNowPennies} monthsPaid=${p.monthsPaid}`);
    check(`  ${kind}: carries the trial`, p.trialDays === S.trialDays,
      `trialDays=${p.trialDays} — reversed 2026-10-28; this asserted the OPPOSITE until then`);
  }

  // ── 2. THE PRICES ARE DERIVED, NEVER TYPED ──────────────────────────────────────────────────
  console.log('\n— the amount is arithmetic over the settings —');
  check('monthly is the monthly price, with the trial',
    BP.planFor('monthly', S).payNowPennies === 0 && BP.planFor('monthly', S).trialDays === 30);
  // 12-FOR-10, NEW OR RENEWAL (owner, 2026-10-26). The old 12-for-9 for a new garage is gone —
  // every annual plan is the same price now — and new_annual_months_paid is kept only for a
  // future promotion. S below still carries 9 so that this clause proves planFor reads the
  // SETTING rather than a constant; the live default is 10.
  check('a new garage on annual pays what the new-annual setting says',
    BP.planFor('annual_new', S).payNowPennies === S.newAnnualMonthsPaid * 7500
      && BP.planFor('annual_new', S).monthsGiven === 12,
    `${BP.planFor('annual_new', S).payNowPennies} at ${S.newAnnualMonthsPaid} months`);
  check('  …and at the CURRENT terms that is 12 for 10 = £750',
    BP.planFor('annual_new', { ...S, newAnnualMonthsPaid: 10 }).payNowPennies === 75000
      && BP.planFor('annual_renewal', { ...S, renewalAnnualMonthsPaid: 10 }).payNowPennies === 75000,
    'new and renewal are the same price today; a difference would be a promotion nobody has set');
  check('  …and the affiliate offer is 12 for 8 = £600',
    BP.planFor('annual_offer', { ...S, offerMonthsPaid: 8 }).payNowPennies === 60000,
    'was 12-for-6 (£450) until 2026-10-26');
  check('the affiliate offer pays 6 months for 12', BP.planFor('annual_offer', S).payNowPennies === 6 * 7500,
    `${BP.planFor('annual_offer', S).payNowPennies}`);
  check('a renewal pays 10 months for 12', BP.planFor('annual_renewal', S).payNowPennies === 10 * 7500,
    `${BP.planFor('annual_renewal', S).payNowPennies}`);
  check('  …and changing a SETTING moves the price, with no Price to create',
    BP.planFor('annual_offer', { ...S, offerMonthsPaid: 5 }).payNowPennies === 5 * 7500,
    'ruling 4 — admin changes a number, Stripe is told an amount');
  // THE DISCRIMINATOR. Every clause above passes against a module that returns one constant for
  // all three annual shapes, as long as that constant happens to be the one each asked for.
  const amounts = ['annual_new', 'annual_offer', 'annual_renewal'].map((k) => BP.planFor(k, S).payNowPennies);
  check('  …and the three annual shapes DISAGREE with each other',
    new Set(amounts).size === 3, `${JSON.stringify(amounts)} — one shared constant would satisfy every clause above`);
  check('the amount is PER SITE', BP.planFor('annual_new', S, 3).payNowPennies === 3 * 9 * 7500,
    `${BP.planFor('annual_new', S, 3).payNowPennies} — the monthly price is per location and the annual one is the same price twelve times`);

  // ── 3. SETTINGS THAT CANNOT SELL ARE REFUSED ────────────────────────────────────────────────
  console.log('\n— and settings that cannot produce a plan are refused —');
  const throws = (fn) => { try { fn(); return false; } catch { return true; } };
  check('a zero-day trial is REFUSED, not normalised',
    throws(() => BP.planFor('monthly', { ...S, trialDays: 0 })),
    'monthly with no trial and no payment is service given away with nothing to charge later');
  check('zero months paid is REFUSED', throws(() => BP.planFor('annual_offer', { ...S, offerMonthsPaid: 0 })));
  check('zero sites is REFUSED', throws(() => BP.planFor('annual_new', S, 0)));
  check('  …while the ordinary settings are accepted', !throws(() => BP.planFor('monthly', S)),
    'without this the three refusals above pass against a function that throws on everything');

  // ── 4. ONE TRIAL LENGTH, AND ITS SETTINGS ROW IS THE GATE'S OWN ─────────────────────────────
  console.log('\n— one trial length, and a settings row this gate owns —');
  const src = (f) => readFileSync(`${R}/${f}`, 'utf8');
  check('no hard-coded trial constant survives in lib/stripe or lib/trial',
    !/TRIAL_PERIOD_DAYS\s*=\s*\d/.test(src('lib/stripe.ts')) && !/TRIAL_DAYS\s*=\s*\d/.test(src('lib/trial.ts')),
    'a mirror maintained by a comment is not a single source');
  const liveBefore = (await prisma.programmeSettings.findUnique({ where: { id: 'singleton' }, select: { trial_days: true } }))?.trial_days ?? null;
  await prisma.programmeSettings.create({ data: { id: GATE_SETTINGS, trial_days: 11, offer_months_paid: 4 } });
  const mine = await BP.planSettings(prisma, { settingsId: GATE_SETTINGS });
  check('planSettings reads the row it was POINTED AT', mine.trialDays === 11 && mine.offerMonthsPaid === 4,
    JSON.stringify({ trialDays: mine.trialDays, offerMonthsPaid: mine.offerMonthsPaid }));
  const liveAfter = (await prisma.programmeSettings.findUnique({ where: { id: 'singleton' }, select: { trial_days: true } }))?.trial_days ?? null;
  check('  …and the LIVE singleton is untouched by any of it', liveAfter === liveBefore,
    `singleton ${liveBefore} → ${liveAfter} — the whole reason the id is a parameter`);
  check('  …and with no id it resolves the singleton', (await BP.planSettings(prisma)).trialDays === liveBefore,
    `${(await BP.planSettings(prisma)).trialDays} vs ${liveBefore}`);
  check('the derived monthly price is the country profile’s, in pennies', mine.monthlyPricePennies === 7500,
    `${mine.monthlyPricePennies}`);

  // ── 5. ONLY A GATE MAY NAME A SETTINGS ROW (owner's condition, 2026-10-25) ──────────────────
  // A scan, not a promise. The id lives in an options object with a distinctive name precisely so
  // this is checkable: a bare second argument would be invisible here.
  console.log('\n— and no production path names one —');
  const walk = (dir, acc = []) => {
    if (!existsSync(dir)) return acc;
    for (const e of readdirSync(dir)) {
      const p = `${dir}/${e}`;
      if (statSync(p).isDirectory()) walk(p, acc);
      else if (/\.(ts|tsx)$/.test(e)) acc.push(p);
    }
    return acc;
  };
  const pageHits = walk(`${R}/pages`).filter((f) => /settingsId/.test(readFileSync(f, 'utf8')));
  check('NO file under pages/ names a settings id', pageHits.length === 0,
    pageHits.map((f) => f.replace(`${R}/`, '')).join(', ') || `${walk(`${R}/pages`).length} files scanned`);
  check('  …and the scan would find one — it is not looking for a token nothing uses',
    /settingsId/.test(src('lib/programme-settings.ts')) && /settingsId/.test(src('lib/billing-plans.ts')),
    'the term has to exist somewhere, or a clean sweep of pages/ proves nothing');

  // ── 6. TERMS ARE A TIMELINE ─────────────────────────────────────────────────────────────────
  console.log('\n— the terms a garage is on are a timeline —');
  const g = (await prisma.group.create({
    data: { group_name: `${PREFIX} garage 1`, billing_email: `${PREFIX.toLowerCase()}-1@example.invalid` },
    select: { id: true },
  })).id;
  const t0 = new Date('2026-01-10T09:00:00.000Z');
  const t1 = new Date('2026-06-10T09:00:00.000Z');
  await BP.writePlanTerms(prisma, g, BP.planFor('monthly', S), { at: t0 });
  await BP.writePlanTerms(prisma, g, BP.planFor('annual_offer', S), { at: t1 });
  const rows = await prisma.tenantPlanTerms.count({ where: { group_id: g } });
  check('writing twice APPENDS — it does not overwrite', rows === 2, `${rows} row(s)`);
  const now = await BP.currentPlanTerms(prisma, g);
  const signup = await BP.signupPlanTerms(prisma, g);
  check('  …what they are ON NOW is the latest', now?.plan === 'annual_offer' && now?.paid_now_pennies === 6 * 7500,
    `${now?.plan} / ${now?.paid_now_pennies}`);
  check('  …what they SIGNED UP under is the earliest, and it still says monthly',
    signup?.plan === 'monthly' && signup?.trial_days === 30,
    `${signup?.plan} / trial ${signup?.trial_days} — the row a later choice must not erase`);
  // ── AND THE DATABASE STILL REFUSES THE SHAPES THAT ARE STILL WRONG ──────────────────────────
  // TenantPlanTerms_trial_xor_paynow came in on 2026-10-24 and was found by a red-proof rather
  // than by reading. The 2026-10-28 reversal REPLACED it with TenantPlanTerms_shape_by_plan —
  // trial_days is now unconstrained (it is 30 on both shapes), and what the database still
  // refuses is a plan whose shape contradicts its name. Asserted here for the same reason as
  // before: a guard nobody knows about is one the next migration drops with nothing to notice.
  const monthlyPaidRefused = await prisma.tenantPlanTerms.create({
    data: { group_id: g, plan: 'monthly', months_paid: 12, months_given: 12,
      paid_now_pennies: 75000, trial_days: 30, effective_from: new Date('2026-09-01T00:00:00.000Z') },
  }).then(() => false, (e) => /shape_by_plan/.test(describeError(e)));
  check('the DATABASE refuses a MONTHLY row that took a payment for a term', monthlyPaidRefused,
    'monthly is rolling; a term on it is a contradiction no screen could render honestly');
  const annualFreeRefused = await prisma.tenantPlanTerms.create({
    data: { group_id: g, plan: 'annual_offer', months_paid: null, months_given: null,
      paid_now_pennies: null, trial_days: 30, effective_from: new Date('2026-09-02T00:00:00.000Z') },
  }).then(() => false, (e) => /shape_by_plan/.test(describeError(e)));
  check('  …and an ANNUAL row that names no term and takes no payment', annualFreeRefused,
    'a year given away with nothing to charge is the other half of the same rule');
  const bothNowAllowed = await prisma.tenantPlanTerms.create({
    data: { group_id: g, plan: 'annual_renewal', months_paid: 10, months_given: 12,
      paid_now_pennies: 75000, trial_days: 30, effective_from: new Date('2026-09-03T00:00:00.000Z') },
  }).then(() => true, () => false);
  check('  …while a trial AND a payment together is now ALLOWED', bothNowAllowed,
    'the reversal, proved against the database rather than against the module that writes it');

  // NULL IS A MEANINGFUL ABSENCE HERE, NOT ZERO.
  check('monthly records NO payment, rather than a payment of nothing', signup?.paid_now_pennies === null,
    `${signup?.paid_now_pennies} — zero would read as money collected`);
  check('  …and an annual row records its trial alongside the payment',
    now?.trial_days === 30, `${now?.trial_days} — NULL here was the old rule`);
  // ── 7. EVERY NEW GARAGE GETS A FIRST TERMS ROW ──────────────────────────────────────────────
  // The 2026-10-24 backfill gave every EXISTING garage a row so there would be ONE SHAPE for every
  // garage. Signup wrote none, so the next garage to register would have broken that the day after
  // it was established — built and unread, found by the owner rather than by this file.
  console.log('\n— and a new garage starts with terms —');
  const g2 = (await prisma.group.create({
    data: { group_name: `${PREFIX} garage 2`, billing_email: `${PREFIX.toLowerCase()}-2@example.invalid` },
    select: { id: true },
  })).id;
  const live = (await prisma.programmeSettings.findUnique({ where: { id: 'singleton' }, select: { trial_days: true } }))?.trial_days;
  await BP.ensureStartingPlanTerms(prisma, g2);
  const started = await prisma.tenantPlanTerms.findMany({ where: { group_id: g2 } });
  check('a new garage gets EXACTLY ONE terms row', started.length === 1, `${started.length} row(s)`);
  check('  …on monthly, with the trial length in force TODAY',
    started[0]?.plan === 'monthly' && started[0]?.trial_days === live,
    `${started[0]?.plan} / trial ${started[0]?.trial_days} vs the live setting ${live}`);
  await BP.ensureStartingPlanTerms(prisma, g2);
  check('  …and calling it again writes nothing more',
    (await prisma.tenantPlanTerms.count({ where: { group_id: g2 } })) === 1,
    'the onboarding upsert can run twice, and an upsert does not say which branch it took');
  // AND IT DOES NOT CLIMB IN UNDERNEATH A GARAGE THAT HAS MOVED ON.
  await BP.writePlanTerms(prisma, g2, BP.planFor('annual_new', S), { at: new Date('2027-01-01T00:00:00.000Z') });
  await BP.ensureStartingPlanTerms(prisma, g2);
  const afterAnnual = await BP.currentPlanTerms(prisma, g2);
  check('  …and a garage already on annual keeps it', afterAnnual?.plan === 'annual_new'
    && (await prisma.tenantPlanTerms.count({ where: { group_id: g2 } })) === 2,
    `${afterAnnual?.plan}, ${await prisma.tenantPlanTerms.count({ where: { group_id: g2 } })} row(s) — starting terms are not something to re-add underneath`);

  // ── THE REACH CLAUSE ────────────────────────────────────────────────────────────────────────
  // The unit above proves the chokepoint. This proves the SIGNUP PATHS GO THROUGH IT, which is the
  // half that was missing: lib/billing-plans existed and nothing called it.
  //
  // NOT driven end to end on purpose, and this is a limitation rather than a preference: the real
  // endpoint sends the verification email, and a Resend key is present in development, so every
  // run of this gate would make an outbound send attempt. Proving the wiring by reading the two
  // files is weaker than driving them; it is written down here so nobody mistakes it for proof
  // that a signup works.
  const SIGNUP_PATHS = ['pages/api/auth/register-garage.ts', 'pages/api/onboarding/setup.ts'];
  const missing = SIGNUP_PATHS.filter((f) => !/ensureStartingPlanTerms\s*\(/.test(readFileSync(`${R}/${f}`, 'utf8')));
  check('EVERY path that creates a garage calls the chokepoint', missing.length === 0,
    missing.join(', ') || SIGNUP_PATHS.join(', '));
  check('  …and the list is every such path — each one really does create a Group',
    SIGNUP_PATHS.every((f) => /(tx|prisma)\.group\.(create|upsert)\s*\(/.test(readFileSync(`${R}/${f}`, 'utf8'))),
    'a file that stopped creating garages would sit on this list forever, passing');

  // ── 8. THE PRICES ARE A SETTING AN OPERATOR CHANGES, NOT A DEPLOY ───────────────────────────
  // Until 2026-10-26 /superadmin/billing could edit the trial length and nothing else, so moving
  // the annual price meant a migration or a direct database write — a price change with no
  // operator against it and no audit row.
  console.log('\n— and the prices are editable, validated and audited —');
  check('every plan setting is named in one closed list', PS.PLAN_SETTING_FIELDS.length === 7
    && PS.PLAN_SETTING_FIELDS.every((f) => PS.PLAN_SETTING_LABEL[f] && PS.PLAN_SETTING_KIND[f]),
    JSON.stringify(PS.PLAN_SETTING_FIELDS));

  // VALIDATION, each refusal and then the discriminator. Months are 1..12; money is whole pennies
  // and zero or more — zero is a real setting (a programme paying nothing) and must be ALLOWED,
  // which is the half a "must be positive" rule would get wrong.
  check('months outside 1..12 are refused', !!PS.refusePlanSetting('offer_months_paid', 0)
    && !!PS.refusePlanSetting('offer_months_paid', 13) && !!PS.refusePlanSetting('offer_months_paid', 1.5));
  check('negative money is refused', !!PS.refusePlanSetting('total_reward_pennies', -1));
  check('fractional pennies are refused', !!PS.refusePlanSetting('total_reward_pennies', 12.5));
  check('  …while a legitimate value is ACCEPTED, including ZERO pennies',
    PS.refusePlanSetting('offer_months_paid', 8) === null
      && PS.refusePlanSetting('total_reward_pennies', 0) === null
      && PS.refusePlanSetting('total_reward_pennies', 60000) === null,
    'otherwise the refusals above prove only that nothing can be saved');

  // ── THE RULES THAT ARE ABOUT TWO FIELDS AT ONCE ─────────────────────────────────────────────
  // Checked over the RESULTING state: a save touching only months_given can invalidate an offer
  // value set months ago and never moved, so a per-field check cannot see it.
  const base = { new_annual_months_paid: 10, renewal_annual_months_paid: 10, offer_months_paid: 8,
    months_given: 12, total_reward_pennies: 12000, instalment_pennies: 3000, affiliate_signups_open: true };
  check('months charged may not exceed months given',
    !!PS.refusePlanCombination({ ...base, offer_months_paid: 13 - 1, months_given: 10 })
      && !!PS.refusePlanCombination({ ...base, new_annual_months_paid: 11, months_given: 10 })
      && !!PS.refusePlanCombination({ ...base, renewal_annual_months_paid: 11, months_given: 10 }),
    'charging for eleven and giving ten is worse than monthly, and nobody means it');
  check('an instalment may not exceed the total reward',
    !!PS.refusePlanCombination({ ...base, instalment_pennies: 12001 }),
    'the cap would be reached by the first payment — a single payment wearing the word instalment');
  check('  …and a sensible combination is ACCEPTED', PS.refusePlanCombination(base) === null,
    'otherwise the two refusals above prove only that nothing can be saved');
  // AND IT IS ENFORCED AT THE WRITE, over the merged result — not only exported as a predicate.
  const crossRefused = await PS.savePlanSettings(prisma, {
    changes: { months_given: 6 }, actorId: null, settingsId: GATE_SETTINGS,
  }).then(() => false, (e) => /cannot be more than/.test(describeError(e)));
  check('  …and savePlanSettings refuses it over the MERGED state',
    crossRefused, 'lowering months_given alone must be refused when a months-charged already exceeds it');

  // A SWITCH IS NOT A NUMBER. Number(false) is 0, a perfectly plausible value that would read
  // back as "off" by accident rather than by decision.
  check('the signups switch is a boolean, and a number is refused',
    PS.refusePlanSetting('affiliate_signups_open', true) === null
      && PS.refusePlanSetting('affiliate_signups_open', false) === null
      && !!PS.refusePlanSetting('affiliate_signups_open', 0),
    'false must be ACCEPTED — it is the whole point of the switch');

  // THE WRITE: on this gate's OWN row, never the singleton, and audited old-to-new.
  await prisma.programmeSettings.upsert({ where: { id: GATE_SETTINGS }, update: {}, create: { id: GATE_SETTINGS } });
  const singletonBefore = (await prisma.programmeSettings.findUnique({ where: { id: 'singleton' }, select: { offer_months_paid: true } }))?.offer_months_paid ?? null;
  const op = await prisma.operator.create({ data: {
    email: 'zzbp-plan-gate@greasedesk.test', name: 'Plan settings gate', role: 'owner', status: 'active',
    regions: ['GB'], passwordHash: 'x' }, select: { id: true } });
  const saved = await PS.savePlanSettings(prisma, {
    changes: { offer_months_paid: 8, total_reward_pennies: 60000, affiliate_signups_open: false },
    actorId: op.id, settingsId: GATE_SETTINGS,
  });
  check('a save reports what CHANGED, old to new', saved.changed.offer_months_paid?.to === 8
    && saved.changed.total_reward_pennies?.to === 60000, JSON.stringify(saved.changed));
  check('  …and READS BACK from the database, not from what it was sent',
    saved.after.offer_months_paid === 8 && saved.after.total_reward_pennies === 60000
      && saved.after.affiliate_signups_open === false,
    JSON.stringify(saved.after));
  const audit = await prisma.superAdminAudit.findFirst({
    where: { action: 'programme_plan_settings', operator_user_id: op.id },
    orderBy: { created_at: 'desc' }, select: { target_ref_snapshot: true, detail: true },
  });
  check('  …and writes ONE audit row naming the change and who made it',
    !!audit && /offer_months_paid .* → 8/.test(String(audit.target_ref_snapshot)),
    String(audit?.target_ref_snapshot));
  check('  …and the SINGLETON is untouched by any of it',
    (await prisma.programmeSettings.findUnique({ where: { id: 'singleton' }, select: { offer_months_paid: true } }))?.offer_months_paid === singletonBefore,
    `singleton offer_months_paid ${singletonBefore} — a gate must not reprice the live programme`);
  // A SAVE THAT CHANGES NOTHING WRITES NOTHING. An audit row per form submission, rather than per
  // change, fills the log with "nothing happened" and buries the entries that matter.
  const again = await PS.savePlanSettings(prisma, { changes: { offer_months_paid: 8 }, actorId: op.id, settingsId: GATE_SETTINGS });
  check('  …and re-saving the same value records no change', Object.keys(again.changed).length === 0,
    JSON.stringify(again.changed));
  await prisma.operator.deleteMany({ where: { id: op.id } });

  // AND NO PRODUCTION PATH NAMES A ROW. The existing scan covers pages/; this is the same rule
  // for the new PUT handler, which must take its row from the chokepoint's default.
  const apiSrc = readFileSync(`${R}/pages/api/superadmin/programme-settings.ts`, 'utf8');
  check('the Engine Room API never names a settings row',
    !/settingsId/.test(apiSrc) && /savePlanSettings\(/.test(apiSrc),
    'it calls the chokepoint and lets it default — a caller that can choose the row can choose a gate\u2019s');

} catch (e) {
  console.log(`\n✗ THREW: ${describeError(e).slice(0, 700)}`);
  out.push('F');
} finally {
  const left = await sweep().catch(() => -1);
  const liveStill = await prisma?.programmeSettings.findUnique({ where: { id: 'singleton' }, select: { trial_days: true } }).catch(() => null);
  const mineGone = await prisma?.programmeSettings.count({ where: { id: GATE_SETTINGS } }).catch(() => -1);
  check('teardown removed every fixture, and the live settings row is still there',
    left >= 0 && mineGone === 0 && liveStill != null,
    `swept ${left}; gate settings rows left ${mineGone}; singleton trial_days ${liveStill?.trial_days}`);
  console.log(`\n${out.filter((x) => x === 'F').length} failures of ${out.length}`);
  await prisma?.$disconnect();
  process.exit(out.includes('F') ? 1 : 0);
}
