/**
 * File: scripts/billing-plans-gate.mjs
 * @gate-requires: db
 *
 * THE PLAN SHAPES, AND THE ARITHMETIC THAT PRICES THEM.
 *
 * ── THE RULE EVERYTHING HERE TURNS ON ───────────────────────────────────────────────────────────
 * TRIAL OR PAY NOW, NEVER BOTH (owner, 2026-10-24). A new garage on annual pays immediately for
 * twelve months at the price of nine — the trial IS the discount, taken at the front. Monthly
 * keeps the trial. The affiliate offer is twelve for six. A renewal is twelve for ten. Four
 * shapes, one rule, and the rule is ASSERTED over every shape the module says it can sell rather
 * than over four hand-written cases, which is the same mistake as a hand-kept status list.
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

  // ── 1. TRIAL OR PAY NOW, NEVER BOTH ─────────────────────────────────────────────────────────
  console.log('— trial or pay now, never both —');
  check('the module names every plan shape it can sell', Array.isArray(BP.PLAN_KINDS) && BP.PLAN_KINDS.length >= 4,
    JSON.stringify(BP.PLAN_KINDS));
  for (const kind of BP.PLAN_KINDS ?? []) {
    const p = BP.planFor(kind, S);
    check(`  ${kind}: exactly one of trial / pay-now`,
      (p.trialDays > 0) !== (p.payNowPennies > 0),
      `trialDays=${p.trialDays} payNow=${p.payNowPennies} — both or neither is the contradiction this rule exists to stop`);
  }

  // ── 2. THE PRICES ARE DERIVED, NEVER TYPED ──────────────────────────────────────────────────
  console.log('\n— the amount is arithmetic over the settings —');
  check('monthly is the monthly price, with the trial',
    BP.planFor('monthly', S).payNowPennies === 0 && BP.planFor('monthly', S).trialDays === 30);
  check('a new garage on annual pays 9 months for 12',
    BP.planFor('annual_new', S).payNowPennies === 9 * 7500 && BP.planFor('annual_new', S).monthsGiven === 12,
    `${BP.planFor('annual_new', S).payNowPennies}`);
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
  // ── AND THE DATABASE REFUSES IT TOO ─────────────────────────────────────────────────────────
  // TenantPlanTerms_trial_xor_paynow came in with the affiliate migration on 2026-10-24 and was
  // found by a red-proof rather than by reading — a mutation that broke the rule in the module hit
  // the CHECK on the way out. A guard nobody knows about is a guard that gets dropped by the next
  // migration with nothing to notice, so it is asserted here: the rule holds even for a writer
  // that bypasses lib/billing-plans entirely.
  const bothRefused = await prisma.tenantPlanTerms.create({
    data: { group_id: g, plan: 'annual_offer', months_paid: 6, months_given: 12,
      paid_now_pennies: 45000, trial_days: 30, effective_from: new Date('2026-09-01T00:00:00.000Z') },
  }).then(() => false, (e) => /trial_xor_paynow/.test(describeError(e)));
  check('the DATABASE refuses a row carrying both a trial and a payment', bothRefused,
    'the module cannot produce one, and a writer that goes round the module still cannot store one');
  const neitherRefused = await prisma.tenantPlanTerms.create({
    data: { group_id: g, plan: 'monthly', months_paid: null, months_given: null,
      paid_now_pennies: null, trial_days: null, effective_from: new Date('2026-09-02T00:00:00.000Z') },
  }).then(() => false, (e) => /trial_xor_paynow/.test(describeError(e)));
  check('  …and a row carrying NEITHER', neitherRefused,
    'service given away with nothing to charge later is the other half of the same rule');

  // NULL IS A MEANINGFUL ABSENCE HERE, NOT ZERO.
  check('monthly records NO payment, rather than a payment of nothing', signup?.paid_now_pennies === null,
    `${signup?.paid_now_pennies} — zero would read as money collected`);
  check('  …and the annual row records NO trial, rather than one that ended instantly',
    now?.trial_days === null, `${now?.trial_days}`);
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
