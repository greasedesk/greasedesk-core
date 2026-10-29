/**
 * File: scripts/plan-choice-gate.mjs
 * THE PLAN CHOICE, ASSERTED ON THE SCREEN RATHER THAN UNDER IT.
 *
 * @gate-requires: db, server
 *
 * ── WHY THIS GATE EXISTS ───────────────────────────────────────────────────────────────────────
 * Annual billing shipped complete and unreachable. checkout.ts read `plan` from the body; the
 * onboarding step sent `{ context: 'onboarding' }` and the licences screen sent no body at all, so
 * monthly was the only plan any garage could buy. Every gate written for that slice was green,
 * because every one of them tested a library or an API and none went through a page.
 *
 * So the clauses here deliberately start from a REQUEST for a page and read the markup that comes
 * back. A clause that imports planChoiceFor and compares it with planChoiceFor would agree with
 * itself; the expected figures below are computed INDEPENDENTLY from the settings row and the
 * country price, which is the only way the arithmetic is being checked rather than echoed.
 *
 * ── WHAT THE FIGURES ARE PROVED AGAINST (owner, 2026-10-29) ────────────────────────────────────
 * The screen now shows a percentage ("Save 17%"), a monthly equivalent ("£62.50 /month") and a
 * money saving ("Save £150 a year"). Every one of those is a number somebody could reasonably
 * have typed, and a typed one stays right until the day months-paid moves in the Engine Room and
 * then is quietly wrong on the signup screen. The RED-PROOF for this slice is therefore a DATA
 * mutation and not only a code one: change `renewal_annual_months_paid` on the gate's settings row
 * and these clauses must still pass with DIFFERENT numbers printed. A typed figure fails that.
 */
import './_gate-preflight.mjs';
import { gatePrisma, gateOrigin, serverReady, onTeardown, describeError, declineToRun } from './_gate-preflight.mjs';
import './_ts.mjs';

const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');
const bcrypt = (await import('bcryptjs')).default;

const prisma = await gatePrisma();
const B = gateOrigin();
const PREFIX = 'ZZPLAN';
const PW = 'PlanGate!2026';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };

let groupId = null, userId = null, repId = null, browser = null;

const sweep = async () => {
  if (!groupId) return;
  await prisma.tenantAttribution.deleteMany({ where: { group_id: groupId } }).catch(() => {});
  await prisma.tenantPlanTerms.deleteMany({ where: { group_id: groupId } }).catch(() => {});
  await prisma.groupBilling.deleteMany({ where: { group_id: groupId } }).catch(() => {});
  await prisma.serviceCatalogue.deleteMany({ where: { group_id: groupId } }).catch(() => {});
  await prisma.site.deleteMany({ where: { group_id: groupId } }).catch(() => {});
  await prisma.user.deleteMany({ where: { group_id: groupId } }).catch(() => {});
  await prisma.group.deleteMany({ where: { id: groupId } }).catch(() => {});
  if (repId) await prisma.rep.deleteMany({ where: { id: repId } }).catch(() => {});
};
onTeardown(sweep);

/** A signed-in cookie jar for the fixture admin, over the real next-auth credentials callback. */
async function signIn(email) {
  const jar = new Map();
  const keep = (r) => { for (const c of r.headers.getSetCookie?.() ?? []) { const kv = c.split(';')[0]; const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); } };
  const cookies = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const csrfRes = await fetch(`${B}/api/auth/csrf`); keep(csrfRes);
  const { csrfToken } = await csrfRes.json();
  keep(await fetch(`${B}/api/auth/callback/credentials`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', cookie: cookies() },
    body: new URLSearchParams({ email, password: PW, csrfToken, json: 'true' }),
  }));
  return cookies;
}

try {
  if (!(await serverReady())) declineToRun(`no dev server answering on ${B}`);

  // ── THE INDEPENDENT ORACLE ────────────────────────────────────────────────────────────────────
  // Read from the settings row and the country ladder, NOT from lib/plan-choice. If these came
  // from the module under test every clause below would be a tautology.
  const s = await prisma.programmeSettings.findUnique({ where: { id: 'singleton' } });
  if (!s) declineToRun('no ProgrammeSettings singleton on the gate database');
  const MONTHLY_P = 7500; // GB, lib/locale-profiles — the ladder, written out so a change here is visible
  const expectMonthly = MONTHLY_P;
  const expectRenewal = s.renewal_annual_months_paid * MONTHLY_P;
  const expectOffer = s.offer_months_paid * MONTHLY_P;
  const expectFree = s.months_given - s.renewal_annual_months_paid;
  // THE COMPARISON FIGURES, worked here from the settings row alone. The owner's formula for the
  // percentage is (months given − months paid) ÷ months given; the money saving is twelve months
  // of monthly less the year's price; the headline is the year's price spread over the months of
  // service it buys. If any of these came from lib/plan-choice the clauses would be tautologies.
  const equivOf = (yearPennies) => Math.round(yearPennies / s.months_given);
  const pctOf = (monthsPaid) => Math.round(((s.months_given - monthsPaid) / s.months_given) * 100);
  const saveOf = (yearPennies) => MONTHLY_P * s.months_given - yearPennies;
  const expectRenewalEquiv = equivOf(expectRenewal);
  const expectOfferEquiv = equivOf(expectOffer);
  const expectRenewalPct = pctOf(s.renewal_annual_months_paid);
  const expectOfferPct = pctOf(s.offer_months_paid);
  const expectRenewalSave = saveOf(expectRenewal);
  const expectOfferSave = saveOf(expectOffer);

  const pounds = (p) => `£${Math.round(p / 100)}`;
  // Pence ONLY when there are pence — stated as this gate's own arithmetic rather than borrowed.
  const poundsExact = (p) => (p % 100 === 0 ? `£${p / 100}` : `£${(p / 100).toFixed(2)}`);
  // A PREMISE, CHECKED RATHER THAN ASSUMED: the two formatters above do no thousands grouping,
  // so at four figures they would disagree with Intl for a reason that has nothing to do with the
  // screen. Decline instead of reporting a false red.
  const biggest = Math.max(MONTHLY_P * s.months_given, expectRenewal, expectOffer);
  if (biggest >= 100000) declineToRun(`settings put a figure at ${pounds(biggest)}; this gate's oracle does not group thousands`);

  console.log(`  settings: monthly ${pounds(expectMonthly)} | renewal ${pounds(expectRenewal)} (${poundsExact(expectRenewalEquiv)}/mo, save ${pounds(expectRenewalSave)}, ${expectRenewalPct}%) | offer ${pounds(expectOffer)} (${poundsExact(expectOfferEquiv)}/mo, ${expectOfferPct}%)`);
  check('the offer figure DIFFERS from the renewal figure', expectOffer !== expectRenewal,
    'if they are equal this gate cannot tell a first-year price from a renewal price and proves nothing about the offer');
  check('the yearly monthly-equivalent DIFFERS from the monthly price', expectRenewalEquiv !== expectMonthly,
    'if they are equal the headline clause below cannot tell the two plans apart');

  // ── A GARAGE SITTING EXACTLY ON THE CHECKOUT STEP ─────────────────────────────────────────────
  // Everything before `checkout` complete, nothing bought. The phone step is EXEMPT because no
  // code can be delivered from a test database (lib/environment refuses every send), which is the
  // documented break-glass and not a shortcut around the gate.
  const stamp = Date.now();
  const group = await prisma.group.create({
    data: {
      group_name: `${PREFIX} Motors`, country_code: 'GB', tax_default_rate_bp: 2000,
      // billing_email is an IDENTITY key, so the fixture gets its own and never borrows one.
      billing_email: `${PREFIX.toLowerCase()}-billing-${stamp}@example.invalid`,
      phone_step_exempt_at: new Date(), phone_step_exempt_reason: `${PREFIX} gate fixture`,
    },
    select: { id: true, ref: true },
  });
  groupId = group.id;
  await prisma.site.create({ data: { group_id: groupId, site_name: `${PREFIX} Bay` } });
  await prisma.serviceCatalogue.create({
    data: { group_id: groupId, service_code: 'LABOUR_HR', name: `${PREFIX} Labour`, default_labour_rate: 90 },
  });
  const email = `${PREFIX.toLowerCase()}-${stamp}@example.invalid`;
  const user = await prisma.user.create({
    data: { email, name: `${PREFIX} Owner`, role: 'ADMIN', passwordHash: bcrypt.hashSync(PW, 10), group_id: groupId },
    select: { id: true, passwordHash: true },
  });
  userId = user.id;
  // THE FIXTURE PASSWORD MUST BE GENUINELY CORRECT, or a page that redirects to the login screen
  // would look like a missing control rather than a failed sign-in.
  check('the fixture password is genuinely correct', bcrypt.compareSync(PW, user.passwordHash),
    'so a redirect below is about the page, never the credential');

  const cookies = await signIn(email);
  const get = async (path) => {
    const r = await fetch(`${B}${path}`, { headers: { cookie: cookies() }, redirect: 'manual', cache: 'no-store' });
    return { status: r.status, location: r.headers.get('location'), html: await r.text() };
  };
  const post = async (path, body) => {
    const r = await fetch(`${B}${path}`, { method: 'POST', redirect: 'manual', cache: 'no-store',
      headers: { cookie: cookies(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* an HTML error page */ }
    return { status: r.status, json, text };
  };

  // ── 1. BOTH CHOICES RENDER, ON THE ONLY CHECKOUT A NEW GARAGE SEES ────────────────────────────
  const onb = await get('/onboarding/billing');
  check('the onboarding checkout step renders for a garage on that step', onb.status === 200,
    `HTTP ${onb.status}${onb.location ? ` → ${onb.location}` : ''}`);
  check('BOTH intervals are offered', onb.html.includes('data-testid="plan-toggle-monthly"') && onb.html.includes('data-testid="plan-toggle-annual"'),
    'the defect this gate exists for was a screen with only one');
  check('  …YEARLY is the one selected by default (owner, 2026-10-29)',
    /data-testid="plan-toggle-annual"[^>]*data-selected="true"/.test(onb.html)
    && /data-testid="plan-toggle-monthly"[^>]*data-selected="false"/.test(onb.html),
    'this reverses the 2026-10-28 default; the toggle opens on the better price');
  check('  …and the YEARLY panel is the one rendered', onb.html.includes('data-testid="plan-panel-annual"')
    && !onb.html.includes('data-testid="plan-panel-monthly"'),
    'the selection and the panel are one state — a panel for the unselected plan would be two');

  // ── 2. THE FIGURES ON THE SCREEN ARE THE ONES THE SETTINGS IMPLY ──────────────────────────────
  // READ THE WHOLE ELEMENT, NOT ITS FIRST TEXT NODE. React splits `Billed {x} a year.` across
  // three nodes with `<!-- -->` between them, so a `[^<]+` capture stops at "Billed " and the
  // clause then fails for a reason that has nothing to do with the price. These elements hold no
  // child tags, so "everything up to the first closing tag" is the whole of their text.
  const textOf = (html, testid) => {
    const m = html.match(new RegExp(`data-testid="${testid}"[^>]*>([\\s\\S]*?)</`));
    return m
      ? m[1].replace(/<!--[\s\S]*?-->/g, '').replace(/&#x27;|&apos;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()
      : null;
  };
  check('the YEARLY headline is the monthly EQUIVALENT, not the yearly price',
    textOf(onb.html, 'plan-headline-annual') === poundsExact(expectRenewalEquiv),
    `${textOf(onb.html, 'plan-headline-annual')} vs ${poundsExact(expectRenewalEquiv)} (${pounds(expectRenewal)} ÷ ${s.months_given})`);
  check('  …and the yearly price is stated beneath it', (textOf(onb.html, 'plan-billed-annual') ?? '').includes(pounds(expectRenewal)),
    `${textOf(onb.html, 'plan-billed-annual')} should name ${pounds(expectRenewal)}`);
  check('the money saving is stated and DERIVED', (textOf(onb.html, 'plan-saving-annual') ?? '').includes(pounds(expectRenewalSave)),
    `expected ${pounds(expectRenewalSave)} from ${s.months_given} × ${pounds(MONTHLY_P)} − ${pounds(expectRenewal)}`);
  check('the PERCENTAGE on the toggle is stated and DERIVED', textOf(onb.html, 'plan-saving-pct') === `Save ${expectRenewalPct}%`,
    `${textOf(onb.html, 'plan-saving-pct')} vs Save ${expectRenewalPct}% (${expectFree} of ${s.months_given} months free)`);
  check('an unreferred garage is shown NO first-year/renewal split', !onb.html.includes('data-testid="plan-renewal-annual"'),
    'there is no offer to explain, and inventing one would misprice the plan');

  // ── 3. THE CHARGE SENTENCE NAMES THE SELECTED PLAN'S AMOUNT AND A DATE ────────────────────────
  const aSent = textOf(onb.html, 'plan-trial-annual') ?? '';
  check('the charge sentence belongs to the SELECTED plan', aSent.includes(pounds(expectRenewal)) && !aSent.includes(` ${pounds(expectMonthly)} a month`),
    aSent);
  check('  …and it names the TOTAL charged, never the headline equivalent', !aSent.includes(poundsExact(expectRenewalEquiv)),
    `the headline ${poundsExact(expectRenewalEquiv)} is an illustration; nothing bills monthly on the yearly plan`);
  check('  …and it names a date', /\d{4}/.test(aSent),
    'a trial that ends "in 30 days" is not a date the garage can diary');

  // ── 4. THE OFFER CASE SHOWS BOTH PRICES ───────────────────────────────────────────────────────
  const rep = await prisma.rep.create({
    data: {
      name: `${PREFIX} Affiliate`, email: `${PREFIX.toLowerCase()}-aff-${stamp}@example.invalid`,
      ref_code: `${PREFIX}${stamp}`, party_type: 'affiliate', updated_at: new Date(),
    },
    select: { id: true },
  });
  repId = rep.id;
  await prisma.tenantAttribution.create({
    // The same shape lib/attribution writes: one referrer at the full share, sourced from ?ref=.
    data: { group_id: groupId, party_type: 'affiliate', party_id: repId, role: 'referrer',
            share_bp: 10000, effective_from: new Date(), source: 'ref_param' },
  });
  const onbOffer = await get('/onboarding/billing');
  check('a REFERRED garage headlines the FIRST-YEAR monthly equivalent',
    textOf(onbOffer.html, 'plan-headline-annual') === poundsExact(expectOfferEquiv),
    `${textOf(onbOffer.html, 'plan-headline-annual')} vs ${poundsExact(expectOfferEquiv)} (${pounds(expectOffer)} ÷ ${s.months_given})`);
  const split = textOf(onbOffer.html, 'plan-renewal-annual') ?? '';
  check('  …and sees BOTH the first-year and the renewal price', split.includes(pounds(expectOffer)) && split.includes(pounds(expectRenewal)),
    `"${split}" — a first-year price shown alone is a mis-sale; the garage would learn the real figure from its second invoice`);
  check('  …and the plain "billed £X a year" line is REPLACED, not shown as well',
    !onbOffer.html.includes('data-testid="plan-billed-annual"'),
    'two yearly figures on one panel is a question, not an offer');
  check('  …and the saving is against monthly, at the OFFER price',
    (textOf(onbOffer.html, 'plan-saving-annual') ?? '').includes(pounds(expectOfferSave))
    && textOf(onbOffer.html, 'plan-saving-pct') === `Save ${expectOfferPct}%`,
    `${textOf(onbOffer.html, 'plan-saving-annual')} / ${textOf(onbOffer.html, 'plan-saving-pct')} vs ${pounds(expectOfferSave)} / Save ${expectOfferPct}%`);
  // ── WHY, AND FROM WHOM (owner, 2026-10-29) ────────────────────────────────────────────────────
  // A cheaper first year with no stated reason reads as a mistake or a trick. The sentence must
  // name the affiliate from the ATTRIBUTION and the months from the SETTINGS — so it is checked
  // against the fixture's own rep name and the settings row, not against a string in the renderer.
  const reason = textOf(onbOffer.html, 'plan-offer-reason') ?? '';
  const repName = `${PREFIX} Affiliate`;
  check('the offer says WHOSE it is, by name from the attribution', reason.includes(repName),
    `"${reason}" should name ${repName}`);
  check('  …and what it buys, from the settings and not typed',
    reason.includes(`${s.months_given} months for the price of ${s.offer_months_paid}`),
    `"${reason}" should say ${s.months_given} months for the price of ${s.offer_months_paid}`);
  check('  …and an unreferred garage is given no reason, because there is none',
    !onb.html.includes('data-testid="plan-offer-reason"'),
    'an explanation of a discount nobody is getting is a confusing promise');

  const aSentOffer = textOf(onbOffer.html, 'plan-trial-annual') ?? '';
  check('  …and the charge sentence states BOTH', aSentOffer.includes(pounds(expectOffer)) && aSentOffer.includes(pounds(expectRenewal)), aSentOffer);

  // ── 5. CHOOSING ANNUAL ACTUALLY POSTS annual ──────────────────────────────────────────────────
  // The clause the markup cannot answer. The checkout route is INTERCEPTED, so the gate reads the
  // body the page really sent and no Stripe call is made from a gate.
  browser = await chromium.launch({ channel: 'chrome' });
  const ctx = await browser.newContext();
  for (const [name, value] of cookies().split('; ').map((c) => [c.slice(0, c.indexOf('=')), c.slice(c.indexOf('=') + 1)])) {
    await ctx.addCookies([{ name, value, domain: 'localhost', path: '/' }]);
  }
  const page = await ctx.newPage();
  let posted = null;
  await page.route('**/api/stripe/checkout', async (route) => {
    posted = route.request().postDataJSON();
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'intercepted by the gate' }) });
  });
  await page.goto(`${B}/onboarding/billing`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="plan-toggle-annual"]');
  // NOTHING IS CLICKED FIRST. The default is the claim under test, so the gate submits the page
  // exactly as a garage that touched no control would, and reads what the body carried.
  await page.click('button:has-text("Continue to secure checkout")');
  for (let i = 0; i < 40 && posted === null; i++) await new Promise((r) => setTimeout(r, 100));
  check('touching NOTHING and submitting posts plan:"annual"', posted?.plan === 'annual', JSON.stringify(posted));
  check('  …and still says it is the onboarding context', posted?.context === 'onboarding', JSON.stringify(posted));
  // A RELOAD, NOT A SECOND CLICK. The intercepted 503 puts the page into its `unconfigured` state,
  // which unmounts the chooser — so the monthly case has to start from a fresh render. The first
  // version of this clause clicked into a detached, disabled radio and read as a product defect.
  posted = null;
  await page.reload({ waitUntil: 'domcontentloaded' });
  // The LABEL, not the input: the radio is sr-only, which is the right markup and the wrong
  // click target. A garage clicks the tab it can see.
  await page.click('[data-testid="plan-toggle-monthly"]');
  await page.waitForSelector('[data-testid="plan-panel-monthly"]');
  const liveSentence = (await page.textContent('[data-testid="plan-trial-monthly"]')) ?? '';
  check('switching the toggle moves the charge sentence to THAT plan',
    liveSentence.includes(pounds(expectMonthly)) && !liveSentence.includes(pounds(expectRenewal)), liveSentence);
  const liveHeadline = (await page.textContent('[data-testid="plan-headline-monthly"]')) ?? '';
  check('  …and the headline with it', liveHeadline.trim() === poundsExact(expectMonthly),
    `${liveHeadline.trim()} vs ${poundsExact(expectMonthly)}`);
  await page.click('button:has-text("Continue to secure checkout")');
  for (let i = 0; i < 40 && posted === null; i++) await new Promise((r) => setTimeout(r, 100));
  check('  …and submitting then posts plan:"monthly", not an empty body', posted?.plan === 'monthly', JSON.stringify(posted));

  // ── 6. THE SWITCH IS PRESENT ONLY WHILE TRIALING ──────────────────────────────────────────────
  await prisma.groupBilling.create({
    data: { group_id: groupId, plan_name: 'core', status: 'ok', retention_months: 84, included_sites: 1,
      subscription_status: 'trialing', stripe_customer_id: `cus_${PREFIX}${stamp}`, stripe_subscription_id: `sub_${PREFIX}${stamp}` },
  });
  await prisma.tenantPlanTerms.create({
    data: { group_id: groupId, plan: 'monthly', trial_days: s.trial_days, effective_from: new Date() },
  });
  const licTrial = await get('/admin/settings/licences');
  check('the licences screen renders', licTrial.status === 200, `HTTP ${licTrial.status}`);
  check('a TRIALING garage is offered the switch', licTrial.html.includes('data-testid="plan-switch"'), '');
  check('  …to the plan it is NOT on', licTrial.html.includes('data-testid="plan-switch-to-annual"')
    && !licTrial.html.includes('data-testid="plan-switch-to-monthly"'),
    'it is on monthly and the toggle opens on yearly, so the only move offered is to yearly');
  check('  …showing the SAME chooser, derived the same way', licTrial.html.includes('data-testid="plan-choice"')
    && licTrial.html.includes('data-testid="plan-toggle-annual"'),
    'one resolver and one renderer, or the figures a garage switches on are not the figures it was quoted');
  // THE OFFER SURVIVES A SWITCH DURING THE TRIAL (owner ruling, 2026-10-29). This asserted the
  // OPPOSITE yesterday: the fixture is referred and trialing, and under the 2026-10-28 definition
  // a trialing subscription made it "not a new garage", so the screen quoted the renewal price.
  // The £300 therefore turned on which button was pressed at signup. It no longer does — what
  // ends the offer is having paid — so the OFFER figures must reach this screen, which is the
  // whole of the ruling and the one place it is visible to a garage.
  check('  …and a referred garage that has NOT paid is quoted the OFFER here too',
    textOf(licTrial.html, 'plan-headline-annual') === poundsExact(expectOfferEquiv)
    && textOf(licTrial.html, 'plan-saving-pct') === `Save ${expectOfferPct}%`,
    `${textOf(licTrial.html, 'plan-headline-annual')} / ${textOf(licTrial.html, 'plan-saving-pct')} vs ${poundsExact(expectOfferEquiv)} / Save ${expectOfferPct}%`);
  check('  …with BOTH prices, because a switch is as much a mis-sale risk as a signup',
    (textOf(licTrial.html, 'plan-renewal-annual') ?? '').includes(pounds(expectOffer))
    && (textOf(licTrial.html, 'plan-renewal-annual') ?? '').includes(pounds(expectRenewal)),
    textOf(licTrial.html, 'plan-renewal-annual'));
  check('  …and the charge sentence agrees with the headline', (textOf(licTrial.html, 'plan-trial-annual') ?? '').includes(pounds(expectOffer)),
    textOf(licTrial.html, 'plan-trial-annual'));

  // AND THE MOMENT MONEY ARRIVES, IT IS GONE. The same fixture, one column later: this is the
  // clause that stops "the offer survives a trial switch" quietly becoming "the offer never ends".
  await prisma.groupBilling.update({ where: { group_id: groupId }, data: { first_paid_at: new Date() } });
  const licPaid = await get('/admin/settings/licences');
  check('  …but a garage that has PAID is back to the renewal price',
    textOf(licPaid.html, 'plan-headline-annual') === poundsExact(expectRenewalEquiv)
    && !licPaid.html.includes('data-testid="plan-renewal-annual"'),
    `${textOf(licPaid.html, 'plan-headline-annual')} vs ${poundsExact(expectRenewalEquiv)}`);
  await prisma.groupBilling.update({ where: { group_id: groupId }, data: { first_paid_at: null } });

  // ── 6b. A PAID YEAR CLOSES THE SWITCH, AND SAYS SO (owner, 2026-10-29) ────────────────────────
  // NOT covered by "present only while trialing" below: this fixture still reads trialing. A
  // subscription can read trialing with money already taken — a trial extended in the Stripe
  // dashboard after a charge, a pause and resume — and in that gap the control was offered and
  // change-plan would have taken it. The testids differ by a suffix, so each `includes` carries
  // the closing quote: `plan-switch-locked` contains `plan-switch`.
  await prisma.tenantPlanTerms.create({
    data: { group_id: groupId, plan: 'annual_renewal', months_paid: 10, months_given: 12,
      paid_now_pennies: 75000, effective_from: new Date() },
  });
  await prisma.groupBilling.update({ where: { group_id: groupId }, data: { first_paid_at: new Date() } });
  const licLocked = await get('/admin/settings/licences');
  check('a garage that has PAID for the year is not offered the switch, though it still reads trialing',
    !licLocked.html.includes('data-testid="plan-switch"') && !/data-testid="plan-switch-to-/.test(licLocked.html),
    'a paid year is not given back a month at a time — that is a credit note and a proration');
  check('  …and the absence is EXPLAINED, not silent',
    licLocked.html.includes('data-testid="plan-switch-locked"') && /last 14 days before your renewal/.test(licLocked.html),
    'a yearly garage that looked for the switch and found nothing would ask us where it went');
  // AND WITH NO DATE TO GIVE, IT GIVES NONE. This fixture's subscription id is one Stripe has
  // never heard of and its cache carries no period end, so the renewal date is genuinely unknown
  // — the copy says what is true in general rather than naming a date derived from nothing.
  check('  …and an UNKNOWN renewal date is not dressed up as one',
    !/before your renewal on/.test(licLocked.html),
    'a date we cannot read is unknown, not a date to compute from today');
  // AND THE API REFUSES IT, which is the half that holds when the screen is old or bypassed.
  // A source scan could only see that the guard is PRESENT — a red-proof that disabled it with
  // `if (false && …)` left every scan green. So this posts to the real endpoint.
  //
  // WHY A FIXTURE SUBSCRIPTION ID IS ENOUGH, and it is no longer "the guard runs first". The
  // retrieve now runs BEFORE every branch, because the window needs Stripe's renewal date. An id
  // Stripe has never heard of therefore fails the retrieve — and for a paid annual garage asking
  // for monthly that is an UNKNOWN renewal date, which leaves the window shut, which is this
  // refusal. The handler fails CLOSED to the safe answer rather than 502-ing a garage towards
  // something that would keep refusing. Remove the paid-year branch and this comes back 502.
  const refused = await post('/api/stripe/change-plan', { plan: 'monthly' });
  check('  …and change-plan refuses the same switch, with its own reason',
    refused.status === 409 && refused.json?.code === 'ANNUAL_PAID',
    `HTTP ${refused.status} ${JSON.stringify(refused.json ?? refused.text.slice(0, 120))}`);
  check('  …naming renewal, not "contact us"',
    /renewal/i.test(refused.json?.message ?? ''), refused.json?.message);

  // ── 6c. THE LAST FOURTEEN DAYS (owner ruling, 2026-10-29) ────────────────────────────────────
  // The paid year closes the switch everywhere EXCEPT the fortnight before renewal, where the
  // choice is about a period nobody has paid for and so moves no money. The screen and the
  // endpoint read one predicate (lib/renewal-window), and these clauses drive both.
  //
  // THE LIMB THESE WALK. The renewal date resolves live-first with the cache as the fallback, and
  // this fixture's subscription id is not one Stripe knows — so both the screen and the endpoint
  // reach the date through the FALLBACK, from GroupBilling.current_period_end planted below. The
  // live limb is proved by the pure clauses in annual-billing-gate and, against a real
  // subscription, by checkout E. Said plainly because a clause that walks one of two limbs and
  // reports on both is the kind of coverage that is not coverage.
  const DAY_MS = 86_400_000;
  const setRenewal = (ms) => prisma.groupBilling.update({
    where: { group_id: groupId }, data: { current_period_end: new Date(Date.now() + ms) } });
  const fmt = (d) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

  // A MONTH OUT: shut, and the copy names the day to come back on.
  await setRenewal(30 * DAY_MS);
  const farRenewal = new Date(Date.now() + 30 * DAY_MS);
  const farOpens = new Date(farRenewal.getTime() - 14 * DAY_MS);
  const licFar = await get('/admin/settings/licences');
  check('a month before renewal the switch is still shut',
    licFar.html.includes('data-testid="plan-switch-locked"') && !licFar.html.includes('data-testid="plan-window-open"'),
    'outside the window the control is ABSENT, not disabled');
  check('  …and the note names the OPENING date and the renewal date',
    licFar.html.includes(fmt(farOpens)) && licFar.html.includes(fmt(farRenewal)),
    `expected ${fmt(farOpens)} and ${fmt(farRenewal)}`);
  const farRefused = await post('/api/stripe/change-plan', { plan: 'monthly' });
  check('  …and the endpoint refuses, naming the same opening date',
    farRefused.status === 409 && farRefused.json?.code === 'ANNUAL_PAID'
      && farRefused.json?.opensAt?.slice(0, 10) === farOpens.toISOString().slice(0, 10),
    `HTTP ${farRefused.status} ${farRefused.json?.code} opensAt ${farRefused.json?.opensAt ?? 'absent'} vs ${farOpens.toISOString()}`);

  // THE BOUNDARY, FROM THE OUTSIDE IN. One second earlier than the window and it is shut; one
  // second later and it is open. Both go through the real screen, so this is the rule REACHING
  // the garage rather than the arithmetic agreeing with itself.
  await setRenewal(14 * DAY_MS + 60_000);
  const licJustOutside = await get('/admin/settings/licences');
  check('a minute before the window opens, it is shut',
    licJustOutside.html.includes('data-testid="plan-switch-locked"'),
    'the boundary is 14 days to the second, not "about a fortnight"');

  await setRenewal(14 * DAY_MS - 60_000);
  const licJustInside = await get('/admin/settings/licences');
  check('  …and a minute after it opens, the switch is THERE',
    licJustInside.html.includes('data-testid="plan-window-open"')
      && !licJustInside.html.includes('data-testid="plan-switch-locked"'),
    'the two blocks are exclusive — a screen showing both would be telling a garage two things');
  check('  …with a button to move to monthly AT RENEWAL',
    licJustInside.html.includes('data-testid="plan-window-to-monthly"'),
    'its own testid: plan-switch-to-monthly belongs to the trial control');
  check('  …and it promises the paid year is not cut short',
    /not shortened and nothing is refunded/.test(licJustInside.html),
    'the whole reason the window is safe is that it changes only the period nobody has paid for');

  // AND THE TRIAL CONTROL IS STILL ABSENT. The window is not the trial switch reappearing: that
  // one changes the price NOW, which is the thing a paid year forbids.
  check('  …while the TRIAL switch stays absent, because this is a different door',
    !licJustInside.html.includes('data-testid="plan-switch"') && !/data-testid="plan-switch-to-/.test(licJustInside.html),
    'a paid year is never re-priced today, in or out of the window');

  // THE ENDPOINT AGREES. It gets as far as Stripe — which is the proof it is no longer refusing —
  // and fails there on a subscription id Stripe has never heard of. A 409 ANNUAL_PAID here would
  // mean the screen offering a door the endpoint had shut, which is the disagreement this one
  // shared predicate exists to prevent.
  const insideTry = await post('/api/stripe/change-plan', { plan: 'monthly' });
  check('  …and the endpoint stops refusing on the paid-year ground inside the window',
    insideTry.json?.code !== 'ANNUAL_PAID',
    `${insideTry.status} ${JSON.stringify(insideTry.json ?? insideTry.text.slice(0, 120))} — it goes on to Stripe, which is the right next step for a fixture id`);

  // A CACHED DATE IN THE PAST IS NOT A RENEWAL DATE. Without this the window would stand open for
  // ever on any garage whose cache went quiet — the switch offered against a day that has passed.
  await setRenewal(-3 * DAY_MS);
  const licStale = await get('/admin/settings/licences');
  check('a cached renewal date in the PAST is treated as unknown, not as an open window',
    licStale.html.includes('data-testid="plan-switch-locked"')
      && !licStale.html.includes('data-testid="plan-window-open"')
      && !/before your renewal on/.test(licStale.html),
    'a stale cache must not hold the door open');
  await prisma.groupBilling.update({ where: { group_id: groupId }, data: { current_period_end: null } });

  // THE DISCRIMINATOR: the same annual tail with the money not yet taken keeps the door open, so
  // the two clauses above are about the PAYMENT and not about being on a yearly plan.
  await prisma.groupBilling.update({ where: { group_id: groupId }, data: { first_paid_at: null } });
  const licUnpaid = await get('/admin/settings/licences');
  check('  …while the same annual garage mid-trial still has it',
    licUnpaid.html.includes('data-testid="plan-switch"') && !licUnpaid.html.includes('data-testid="plan-switch-locked"'),
    'what closes the door is the money, not the plan');
  const notRefused = await post('/api/stripe/change-plan', { plan: 'monthly' });
  check('  …and change-plan stops refusing on that ground too',
    notRefused.json?.code !== 'ANNUAL_PAID',
    `${notRefused.status} ${JSON.stringify(notRefused.json ?? '')} — it goes on to Stripe and fails there on a fixture id, which is the right next step`);

  await prisma.groupBilling.update({ where: { group_id: groupId }, data: { subscription_status: 'active' } });
  const licActive = await get('/admin/settings/licences');
  check('an ACTIVE garage is NOT offered the switch', !licActive.html.includes('data-testid="plan-switch"'),
    'after the first charge a switch is a credit note and a proration — change-plan refuses it with TRIAL_OVER');
  check('  …and the switch is ABSENT, not merely disabled', !/data-testid="plan-switch-to-/.test(licActive.html),
    'a disabled control invites a support call asking why');
} catch (e) {
  check('the gate ran to the end', false, describeError(e));
} finally {
  await browser?.close().catch(() => {});
  await sweep();
  await prisma.$disconnect().catch(() => {});
}

const failures = out.filter((x) => x === 'F').length;
console.log(`\n${out.length} checks, ${failures} failures`);
process.exit(failures ? 1 : 0);
