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
  const pounds = (p) => `£${Math.round(p / 100)}`;
  console.log(`  settings: monthly ${pounds(expectMonthly)} | renewal ${pounds(expectRenewal)} | offer ${pounds(expectOffer)}`);
  check('the offer figure DIFFERS from the renewal figure', expectOffer !== expectRenewal,
    'if they are equal this gate cannot tell a first-year price from a renewal price and proves nothing about the offer');

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

  // ── 1. BOTH CHOICES RENDER, ON THE ONLY CHECKOUT A NEW GARAGE SEES ────────────────────────────
  const onb = await get('/onboarding/billing');
  check('the onboarding checkout step renders for a garage on that step', onb.status === 200,
    `HTTP ${onb.status}${onb.location ? ` → ${onb.location}` : ''}`);
  check('BOTH plans are offered', onb.html.includes('data-testid="plan-option-monthly"') && onb.html.includes('data-testid="plan-option-annual"'),
    'the defect this gate exists for was a screen with only one');
  check('  …monthly is the one selected by default',
    /data-testid="plan-option-monthly"[^>]*data-selected="true"/.test(onb.html)
    && /data-testid="plan-option-annual"[^>]*data-selected="false"/.test(onb.html),
    'a garage must fall into the smaller commitment, never the larger');

  // ── 2. THE FIGURES ON THE SCREEN ARE THE ONES THE SETTINGS IMPLY ──────────────────────────────
  const priceOf = (html, which) => {
    const m = html.match(new RegExp(`data-testid="plan-price-${which}"[^>]*>([^<]+)<`));
    return m ? m[1].trim() : null;
  };
  check('the monthly price on the screen is the ladder price', priceOf(onb.html, 'monthly') === pounds(expectMonthly),
    `${priceOf(onb.html, 'monthly')} vs ${pounds(expectMonthly)}`);
  check('the yearly price on the screen is months × the monthly price', priceOf(onb.html, 'annual') === pounds(expectRenewal),
    `${priceOf(onb.html, 'annual')} vs ${pounds(expectRenewal)} (${s.renewal_annual_months_paid} × ${pounds(MONTHLY_P)})`);
  check('the saving is stated and DERIVED', onb.html.includes('data-testid="plan-saving-annual"')
    && onb.html.includes(`${expectFree} months free`),
    `expected "${expectFree} months free" from ${s.months_given} given − ${s.renewal_annual_months_paid} charged`);
  check('an unreferred garage is shown NO first-year/renewal split', !onb.html.includes('data-testid="plan-renewal-annual"'),
    'there is no offer to explain, and inventing one would misprice the plan');

  // ── 3. THE TRIAL SENTENCE NAMES THE DATE AND THE AMOUNT ───────────────────────────────────────
  const sentenceOf = (html, which) => {
    const m = html.match(new RegExp(`data-testid="plan-trial-${which}"[^>]*>([^<]+)<`));
    return m ? m[1].replace(/&#x27;|&apos;/g, "'").replace(/&amp;/g, '&').trim() : null;
  };
  const mSent = sentenceOf(onb.html, 'monthly') ?? '';
  const aSent = sentenceOf(onb.html, 'annual') ?? '';
  check('the monthly trial sentence names its amount', mSent.includes(pounds(expectMonthly)), mSent);
  check('the yearly trial sentence names ITS amount, not the monthly one', aSent.includes(pounds(expectRenewal)) && !aSent.includes(` ${pounds(expectMonthly)} a month`), aSent);
  check('both trial sentences name a date', /\d{4}/.test(mSent) && /\d{4}/.test(aSent),
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
  check('a REFERRED garage is quoted the offer price', priceOf(onbOffer.html, 'annual') === pounds(expectOffer),
    `${priceOf(onbOffer.html, 'annual')} vs ${pounds(expectOffer)} (${s.offer_months_paid} × ${pounds(MONTHLY_P)})`);
  check('  …and sees the RENEWAL price beside it', onbOffer.html.includes('data-testid="plan-renewal-annual"')
    && onbOffer.html.includes(pounds(expectRenewal)),
    'a first-year price shown alone is a mis-sale — the garage would learn the real figure from its second invoice');
  const aSentOffer = sentenceOf(onbOffer.html, 'annual') ?? '';
  check('  …and the trial sentence states BOTH', aSentOffer.includes(pounds(expectOffer)) && aSentOffer.includes(pounds(expectRenewal)), aSentOffer);

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
  await page.waitForSelector('[data-testid="plan-radio-annual"]');
  await page.click('[data-testid="plan-radio-annual"]');
  await page.click('button:has-text("Continue to secure checkout")');
  await page.waitForFunction(() => true, null, { timeout: 2000 }).catch(() => {});
  for (let i = 0; i < 40 && posted === null; i++) await new Promise((r) => setTimeout(r, 100));
  check('choosing yearly posts plan:"annual"', posted?.plan === 'annual', JSON.stringify(posted));
  check('  …and still says it is the onboarding context', posted?.context === 'onboarding', JSON.stringify(posted));
  // A RELOAD, NOT A SECOND CLICK. The intercepted 503 puts the page into its `unconfigured` state,
  // which unmounts the chooser — so the monthly case has to start from a fresh render. The first
  // version of this clause clicked into a detached, disabled radio and read as a product defect.
  posted = null;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="plan-radio-monthly"]');
  await page.click('[data-testid="plan-radio-monthly"]');
  await page.click('button:has-text("Continue to secure checkout")');
  for (let i = 0; i < 40 && posted === null; i++) await new Promise((r) => setTimeout(r, 100));
  check('  …and choosing monthly posts plan:"monthly", not an empty body', posted?.plan === 'monthly', JSON.stringify(posted));

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
    'it is on monthly, so the only move offered is to yearly');

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
