/**
 * File: scripts/came-via-gate.mjs
 * WHERE DID THIS GARAGE COME FROM — the question, the capture, and the screen.
 * @gate-requires: server, db
 *
 * ── THE DEFECT THIS GATE WAS WRITTEN AROUND ─────────────────────────────────────────────────────
 * The Engine Room tenant page derived its "Signup source" line inline:
 *
 *     attribCount > 0 ? `Reseller (ref …)` : ref ? 'Referral (ref …)' : 'Direct'
 *
 * TenantAttribution has carried `party_type` since affiliates shipped. That expression never read
 * it, so every garage introduced by an AFFILIATE was labelled a RESELLER signup on the one screen
 * an operator uses to check who introduced whom — and the two are paid completely differently.
 * The discriminating clause below is the one that asserts an affiliate referral does NOT say
 * reseller, in the rendered HTML: a clause that only checked "it says something about a referral"
 * would have passed against the defect for as long as it existed.
 *
 * ── AND THE THREE AXES ARE KEPT APART ───────────────────────────────────────────────────────────
 * WHO introduced them (money, from the frozen terms), HOW THEY SAY THEY HEARD OF US (self-reported,
 * optional, NULL for nearly every row) and WHAT THE LINK SAID (utm_*, consent-gated). Collapsing
 * them is how "we don't know" came to be printed as "Direct". So the absences are asserted as
 * ABSENT — null, and the words "not recorded" on the screen — not merely as "not a referral".
 *
 * ── THE COLUMN HAS NO CHECK, SO normaliseHeardAbout IS THE CONSTRAINT ───────────────────────────
 * heard_about is deliberately unconstrained in SQL (the option set is marketing copy; a CHECK would
 * make a rewording a constraining migration). That moves the whole guard into one function, so it
 * is exercised BOTH as a function and through a hand-posted body that never went near the form —
 * which is how a client would actually put its own string in our figures.
 *
 * FIXTURES: the ZZCV prefix on the gate database, swept before and after in a registered teardown.
 * Garages are created through the REAL signup endpoint, because what is being proved is that the
 * answer survives the journey from a <select> to a column — a hand-written row proves the fixture.
 */
import './_gate-preflight.mjs';
const { gatePrisma, describeError, gateOrigin, erOrigin, ER_RESOLVER_ARGS, serverReady, onTeardown, declineToRun } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');
const bcrypt = (await import('/Users/hugh/Developer/greasedesk-core/node_modules/bcryptjs/index.js')).default;
const AM = await import('../lib/anchored-match.ts');
const { underPath } = AM;
const { readFileSync } = await import('node:fs');
const R = '/Users/hugh/Developer/greasedesk-core';
const PF = await import('../lib/phone-format.ts');
const CR = await import('../lib/contact-routes.ts');
const SS = await import('../lib/signup-source.ts');
const CV = await import('../lib/came-via.ts');
const AF = await import('../lib/affiliate.ts');
const SR = await import('../lib/signup-refusals.ts');
const CI = await import('../lib/company-info.ts');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const PREFIX = 'ZZCV';
const LOW = PREFIX.toLowerCase();
const PASS = 'GateGarage!2026';
/**
 * THE MOBILE EVERY SIGNUP IN THIS GATE GIVES — required from 2026-11-01, so a signup without one
 * does not complete and every clause below that needs a garage needs a number first.
 *
 * 07700 900xxx is Ofcom's RESERVED DRAMA RANGE: numbers that exist for fiction and are allocated to
 * nobody. A made-up 07 number is somebody's phone, and this gate's garages end up in alert rows and
 * onboarding states that a person might one day ring.
 */
const MOBILE = '07700900123';
const OP_EMAIL = `${LOW}-came-via-gate@greasedesk.test`;
const OP_PASS = 'GateCameVia!2026';

let prisma, browser;

const sweep = async () => {
  if (!prisma) return 0;
  const reps = (await prisma.rep.findMany({ where: { ref_code: { startsWith: PREFIX, mode: 'insensitive' } }, select: { id: true } })).map((r) => r.id);
  const named = (await prisma.group.findMany({ where: { group_name: { startsWith: PREFIX } }, select: { id: true } })).map((g) => g.id);
  // AND THE GARAGES THE ENDPOINT NAMED ITSELF: register-garage writes the neutral 'New garage', so
  // a sweep matching only the prefix would leave behind every garage created through the real path.
  const mine = await prisma.user.findMany({ where: { email: { startsWith: `${LOW}-` } }, select: { id: true, group_id: true } });
  const viaUsers = mine.map((u) => u.group_id);
  const all = [...new Set([...named, ...viaUsers])].filter(Boolean);
  // THE PERSON'S MOBILE, WHICH HANGS OFF NO GROUP. TwoFactorSecret is keyed on (subject_type,
  // subject_id) with no relation to User, so deleting the user leaves the row — and since the
  // mobile became required (2026-11-01) EVERY signup here writes one. Captured BEFORE the users
  // go, or there is nothing left to key the delete on.
  if (mine.length) {
    await prisma.twoFactorSecret.deleteMany({
      where: { subject_type: 'tenant', subject_id: { in: mine.map((u) => u.id) } },
    }).catch(() => {});
  }
  if (all.length) {
    await prisma.superAdminAudit.deleteMany({ where: { target_group_id: { in: all } } }).catch(() => {});
    for (const t of ['tenantAffiliateTerms', 'tenantAttribution', 'commissionEntry', 'tenantPlanTerms', 'notificationLog', 'auditLog', 'groupBilling', 'user']) {
      await prisma[t].deleteMany({ where: { group_id: { in: all } } }).catch(() => {});
    }
    await prisma.group.deleteMany({ where: { id: { in: all } } }).catch(() => {});
  }
  await prisma.verificationToken.deleteMany({ where: { identifier: { startsWith: `${LOW}-` } } }).catch(() => {});
  if (reps.length) {
    await prisma.tenantAffiliateTerms.deleteMany({ where: { affiliate_id: { in: reps } } }).catch(() => {});
    await prisma.rep.deleteMany({ where: { id: { in: reps } } }).catch(() => {});
  }
  await prisma.operator.deleteMany({ where: { email: OP_EMAIL } }).catch(() => {});
  return all.length + reps.length;
};

try {
  prisma = await gatePrisma();
  onTeardown(sweep);
  await sweep();

  const ready = await serverReady('/register');
  if (!ready.ok) declineToRun(`the dev server is not answering on ${gateOrigin()} — ${ready.reason ?? 'no response'}. Every clause below drives the real signup page or the real Engine Room; without a server nothing here has been tested.`);
  check('the dev server serves the signup page before we drive it', ready.ok, `HTTP ${ready.status} after ${ready.attempts} attempt(s)`);

  // ── 1. THE LIST, AND THE CLEAN THAT STANDS IN FOR A CHECK CONSTRAINT ─────────────────────────
  console.log('\n— the option list is the constraint —');
  // ENUMERATED FROM THE EXPORTED SURFACE, not from a name pattern and not from a copy of the list
  // written out here: a second copy agrees with itself and says nothing about the first.
  check('every option on the list is accepted by the validator',
    SS.HEARD_ABOUT_OPTIONS.length >= 6 && SS.HEARD_ABOUT_OPTIONS.every((o) => SS.normaliseHeardAbout(o.value) === o.value),
    `${SS.HEARD_ABOUT_OPTIONS.length} options: ${SS.HEARD_ABOUT_OPTIONS.map((o) => o.value).join(', ')}`);
  check('  …and every one has copy to render', SS.HEARD_ABOUT_OPTIONS.every((o) => typeof o.label === 'string' && o.label.trim().length > 2));
  check('a value that is NOT on the list is refused, not stored',
    SS.normaliseHeardAbout('a friend in the trade') === null && SS.normaliseHeardAbout('<script>') === null,
    'the column carries no CHECK, deliberately — so this function is the whole guard');
  check('  …and nothing-shaped input is null rather than a crash',
    [null, undefined, 42, {}, []].every((x) => SS.normaliseHeardAbout(x) === null));
  check('the free text is kept ONLY with the option that opens it',
    SS.normaliseHeardAboutOther(SS.HEARD_ABOUT_OTHER, 'the tool van') === 'the tool van'
    && SS.normaliseHeardAboutOther('youtube', 'the tool van') === null,
    'a stray sentence beside "YouTube" would be shown next to an option it does not describe');
  check('  …a blank answer is NULL, not an empty string',
    SS.normaliseHeardAboutOther(SS.HEARD_ABOUT_OTHER, '   ') === null,
    'an empty string is a typed answer of nothing, and reads on the screen as one');
  check('  …a NUL byte is stripped rather than sent to Postgres',
    SS.normaliseHeardAboutOther(SS.HEARD_ABOUT_OTHER, `a\u0000b`) === 'a b',
    'Postgres refuses a string containing one (22021), and it would surface as a crashed signup');
  check('  …and it is capped',
    (SS.normaliseHeardAboutOther(SS.HEARD_ABOUT_OTHER, 'x'.repeat(500)) ?? '').length === SS.HEARD_ABOUT_OTHER_MAX);
  check('a label that has been reworded still shows what was answered',
    SS.heardAboutLabel('a_value_we_retired') === 'a_value_we_retired' && SS.heardAboutLabel('youtube') === 'YouTube',
    'the stored value is permanent and the copy is not — a row must not vanish because a sentence changed');
  check('the campaign cleaner reads a query and reports nothing honestly',
    SS.hasUtm(SS.readUtmFromQuery({ utm_source: 'yt', utm_medium: 'video', utm_campaign: 'spring' }))
    && !SS.hasUtm(SS.readUtmFromQuery({ ref: 'ABC' })) && !SS.hasUtm(SS.readUtmFromQuery(null)),
    'all-null is "no campaign", which is not the same as a campaign called nothing');

  // ── 2. THE FORM ASKS, AND DOES NOT ANSWER FOR THEM ───────────────────────────────────────────
  console.log('\n— the question on the signup page —');
  browser = await chromium.launch({ channel: 'chrome' });

  /** Sign up through the real page. Returns the group's five columns, read back from the database. */
  const signUp = async (n, { urlRef = null, urlUtm = null, heard = null, other = null, consent = null, cookies = null, visitFirst = null, mobile = MOBILE } = {}) => {
    const ctx = await browser.newContext();
    if (cookies) await ctx.addCookies(cookies);
    const page = await ctx.newPage();
    const addr = `${LOW}-${n}@example.invalid`;
    // A FIRST VISIT ON ANOTHER PAGE, which is where a campaign link actually lands somebody. The
    // signup is a later page view, and the cookie is the only thing that carries the campaign to it.
    //
    // ON THE HOME PAGE, AND NOT /pricing, FOR A REASON WORTH WRITING DOWN. In DEVELOPMENT webpack
    // does not tree-shake, so a page with a module-scope import of a server library ships it to
    // the browser even when the import is used only inside getStaticProps — /pricing imports
    // lib/programme-settings, so in dev its client bundle throws on PrismaClient and the page has
    // NO working JavaScript. The consent banner there does nothing, no cookie is written, and a
    // clause asserting "nothing was stored" passes for a reason that has nothing to do with
    // consent. (Production tree-shakes it out: the deployed pricing chunk is 11 KB and carries no
    // Prisma. This is a dev-only hazard, which is precisely why it is invisible.)
    if (visitFirst) {
      for (const q of visitFirst) {
        await page.goto(`${gateOrigin()}/${q}`, { waitUntil: 'domcontentloaded' });
        if (consent) {
          await page.click(`[data-testid="consent-${consent}"]`, { timeout: 15000 }).catch(() => {});
          // WAIT FOR THE CHOICE TO BE RECORDED, not for the click to return. The banner writes the
          // cookie and POSTs to /api/consent; navigating away mid-flight aborts the next goto and
          // reports as ERR_ABORTED, which looks nothing like what it is.
          await page.waitForFunction(() => document.cookie.includes('gd_consent'), null, { timeout: 15000 }).catch(() => {});
        }
      }
    }
    const qs = [urlRef ? `ref=${encodeURIComponent(urlRef)}` : null, urlUtm].filter(Boolean).join('&');
    await page.goto(`${gateOrigin()}/register${qs ? `?${qs}` : ''}`, { waitUntil: 'domcontentloaded' })
      // One retry: an aborted navigation is an interrupted one, not a refusal.
      .catch(async () => { await page.goto(`${gateOrigin()}/register${qs ? `?${qs}` : ''}`, { waitUntil: 'domcontentloaded' }); });
    await page.waitForSelector('[data-testid="heard-about"]');
    if (consent && !visitFirst) await page.click(`[data-testid="consent-${consent}"]`, { timeout: 15000 }).catch(() => {});
    if (urlRef) {
      // THE PREFILL'S OWN CONDITION, not the element and not a delay: the field exists from the
      // first paint and an effect fills it a tick later.
      await page.waitForFunction(() => document.querySelector('[data-testid="ref-code"]')?.value !== '', null, { timeout: 5000 }).catch(() => {});
    }
    await page.fill('input[autocomplete="name"]', `${PREFIX} garage ${n}`);
    await page.fill('input[type="email"]', addr);
    await page.fill('input[type="password"]', PASS);
    if (heard) await page.selectOption('[data-testid="heard-about"]', heard);
    if (other !== null) await page.fill('[data-testid="heard-about-other"]', other);
    // ALWAYS FILLED, because the field is required and the form will not submit without it. The
    // REFUSAL is driven in its own block below rather than by passing nothing here — a helper that
    // can produce a signup that never happens makes every clause reading its return value lie.
    await page.fill('[data-testid="signup-mobile"]', mobile);
    await page.click('button[type="submit"]');
    await page.waitForURL(/check-email/, { timeout: 20000 });
    const cookiesAfter = await ctx.cookies();
    await ctx.close();
    // DID THE BANNER ACTUALLY WORK? The choice is only a choice if it was recorded. Returned so a
    // clause about an absence can say the absence followed a decision rather than a dead page.
    const decided = cookiesAfter.find((c) => c.name === 'gd_consent');
    const functional = decided ? /%22functional%22%3Atrue|"functional":true/.test(decided.value) : null;
    const user = await prisma.user.findUnique({ where: { email: addr }, select: { id: true, group_id: true } });
    const group = user && await prisma.group.findUnique({
      where: { id: user.group_id },
      select: { id: true, signup_ref: true, heard_about: true, heard_about_other: true, utm_source: true, utm_medium: true, utm_campaign: true, phone: true },
    });
    const twoFa = user && await prisma.twoFactorSecret.findUnique({
      where: { subject_type_subject_id: { subject_type: 'tenant', subject_id: user.id } },
      select: { phone_e164: true, phone_recorded_at: true, phone_verified_at: true, enabled: true, method: true },
    });
    return { group, user, twoFa, cookiesAfter, consentRecorded: !!decided, functional };
  };

  const page0 = await (await browser.newContext()).newPage();
  await page0.goto(`${gateOrigin()}/register`, { waitUntil: 'domcontentloaded' });
  await page0.waitForSelector('[data-testid="heard-about"]');
  check('the question is on the page, and nothing is chosen for them',
    (await page0.inputValue('[data-testid="heard-about"]')) === '',
    'a pre-selected first option would make it the most common answer in our own figures');
  const optionCount = await page0.locator('[data-testid="heard-about"] option').count();
  check('  …with every option from the list, plus the way out',
    optionCount === SS.HEARD_ABOUT_OPTIONS.length + 1,
    `${optionCount} options for ${SS.HEARD_ABOUT_OPTIONS.length} answers and one "prefer not to say"`);
  check('  …and the box for "something else" is not there until it is chosen',
    (await page0.locator('[data-testid="heard-about-other"]').count()) === 0);
  await page0.selectOption('[data-testid="heard-about"]', SS.HEARD_ABOUT_OTHER);
  await page0.waitForSelector('[data-testid="heard-about-other"]', { timeout: 5000 }).catch(() => {});
  check('  …choosing it reveals the box', (await page0.locator('[data-testid="heard-about-other"]').count()) === 1);
  await page0.selectOption('[data-testid="heard-about"]', 'youtube');
  check('  …and choosing something else takes it away again',
    (await page0.locator('[data-testid="heard-about-other"]').count()) === 0,
    'a box left on screen under "YouTube" is a free-text answer about to be typed into the wrong option');

  // ── 3. AND THE ANSWER REACHES THE COLUMN ─────────────────────────────────────────────────────
  console.log('\n— from the <select> to the column —');
  const chosen = await signUp('chose', { heard: 'supplier_van' });
  check('the chosen answer is stored as its VALUE',
    chosen.group?.heard_about === 'supplier_van' && chosen.group?.heard_about_other === null,
    `${chosen.group?.heard_about} / other ${JSON.stringify(chosen.group?.heard_about_other)}`);
  const typed = await signUp('typed', { heard: SS.HEARD_ABOUT_OTHER, other: 'A bloke at the auction' });
  check('  …and "something else" stores both halves',
    typed.group?.heard_about === SS.HEARD_ABOUT_OTHER && typed.group?.heard_about_other === 'A bloke at the auction');
  const skipped = await signUp('skipped');
  check('a skipped question leaves NULL in all five columns',
    skipped.group?.heard_about === null && skipped.group?.heard_about_other === null
    && skipped.group?.utm_source === null && skipped.group?.utm_medium === null && skipped.group?.utm_campaign === null,
    'not "direct", not an empty string — an optional question that was not answered');
  // ── THE MOBILE GOES WHERE THE STEP VERIFIES IT, AND NOWHERE ELSE ────────────────────────────
  // It went to Group.phone first, which was wrong twice over: that column is the COMPANY's
  // customer-facing number, and pages/api/setup-wizard counts the contact step done on
  // `!!(group.phone || group.whatsapp)` — so a personal mobile would have become the number this
  // garage's customers are given, and skipped the step that would have confirmed it.
  //
  // IT IS NO LONGER OPTIONAL (owner, 2026-11-01), so "a skipped mobile writes nothing" is a state
  // the form can no longer produce — the clause that used to be here had its premise removed. What
  // replaces it is the fact that now matters: every signup carries one, on the person, not the
  // company. The no-mobile case is still real for garages that signed up while it was optional, and
  // the onboarding comparison below is driven against exactly that.
  check('every signup now carries the number, on the PERSON',
    skipped.twoFa?.phone_e164 === CR.toE164Digits(MOBILE) && skipped.group?.phone === null,
    `phone_e164 ${JSON.stringify(skipped.twoFa?.phone_e164)}, Group.phone ${JSON.stringify(skipped.group?.phone)}`);
  const rang = await signUp('mobile', { mobile: ' 07397 387332 ' });
  // DIGITS, NO '+'. That is what lib/contact-routes::toE164Digits returns and what
  // confirmPhoneVerification already stores, so it is the column's convention — asserted against
  // the HELPER rather than against a literal of my own, which is how I nearly "fixed" working code
  // to match an assumption.
  check('a mobile typed at signup lands on the PERSON, normalised by the comms spine',
    rang.twoFa?.phone_e164 === CR.toE164Digits('07397 387332') && rang.twoFa?.phone_e164 === '447397387332',
    `phone_e164 ${JSON.stringify(rang.twoFa?.phone_e164)} from " 07397 387332 "`);
  check('  …and NOT on Group.phone, the company\'s customer-facing number',
    rang.group?.phone === null, `Group.phone ${JSON.stringify(rang.group?.phone)}`);
  check('  …unverified, unrecorded and not enabled — a number somebody typed, not proof of anything',
    rang.twoFa?.phone_verified_at === null && rang.twoFa?.phone_recorded_at === null
    && rang.twoFa?.enabled === false && rang.twoFa?.method === 'sms',
    `verified ${rang.twoFa?.phone_verified_at} / recorded ${rang.twoFa?.phone_recorded_at} / enabled ${rang.twoFa?.enabled}`);

  /**
   * AND THE STEP STILL STANDS. Driven through lib/onboarding itself rather than asserted from the
   * source: the gate keys the phone step on `phone_recorded_at`, so this is the clause that proves
   * writing the number did not quietly satisfy it. Asked for the garage that GAVE a mobile — the
   * one where a mistake would show.
   */
  const OB = await import('../lib/onboarding.ts');
  // COUNTRY FIRST, because the phone step is GB-only and sits BEHIND it: a fresh signup's first
  // incomplete step is 'country', so asking about 'phone' before setting one would have been
  // asserting about a step the gate had not reached. Planted on both garages so the two readings
  // below differ in one thing only — whether a mobile was given.
  for (const gid of [rang.group?.id, skipped.group?.id]) {
    await prisma.group.update({ where: { id: gid }, data: { country_code: 'GB' } });
  }
  /**
   * ── AND THE OTHER ARM OF THE COMPARISON IS MADE, NOT ASSUMED ─────────────────────────────────
   * "A garage that gave no mobile" is no longer something the form can produce, and that does not
   * make the population empty: every garage that signed up while the field was optional is in
   * exactly this state. So the row is removed from one fixture to put it in that state, rather than
   * the clause being deleted along with the state it was about.
   */
  /**
   * SCOPED, AND REFUSED RATHER THAN WIDENED. This read `subject_id: skipped.user?.id`, and in
   * Prisma an `undefined` in a where clause is an OMITTED FILTER, not a match on nothing — so a
   * fixture that failed to sign up would have turned this into "delete every tenant's mobile
   * record in the database", including the gate tenant's, which locks ZZ out of its own dashboard
   * through the onboarding gate. It did not fire; it was one failed fixture away from firing.
   */
  check('the fixture whose mobile is about to be removed was actually created',
    typeof skipped.user?.id === 'string' && skipped.user.id.length > 0,
    'without this the delete below has no WHERE and takes every tenant row');
  if (skipped.user?.id) {
    await prisma.twoFactorSecret.deleteMany({ where: { subject_type: 'tenant', subject_id: skipped.user.id } });
  }
  const stateWith = await OB.getOnboardingState(rang.group?.id, { userId: rang.user?.id, isAdmin: true });
  check('the onboarding phone step still stands, with the number already on file',
    stateWith.firstIncompleteStep === 'phone' && stateWith.onboarded === false,
    `first incomplete: ${stateWith.firstIncompleteStep}`);
  const stateWithout = await OB.getOnboardingState(skipped.group?.id, { userId: skipped.user?.id, isAdmin: true });
  check('  …exactly as it does for a garage from before the field was required — the number changes nothing here',
    stateWithout.firstIncompleteStep === stateWith.firstIncompleteStep,
    `with ${stateWith.firstIncompleteStep} / without ${stateWithout.firstIncompleteStep}`);
  // NOT VACUOUS: if 'phone' were never the first incomplete step for either, both clauses above
  // would agree about something else entirely and prove nothing about this field.
  check('  …and that step is genuinely the one being asked about',
    stateWith.firstIncompleteStep === 'phone', 'if this moves, the two clauses above stop being about the mobile');

  /**
   * ── THE FIELD IS REQUIRED, AND THE REFUSAL IS THE SAME SENTENCE IN BOTH PLACES ───────────────
   * The owner's instruction (2026-11-01): required, labelled "Mobile", a plausible UK mobile, and
   * still unverified at signup. Three surfaces have to agree — the browser's own `required`, the
   * page's refusal, and the endpoint's — because a POST does not have to come from a form.
   */
  console.log('\n— and the mobile is required, with one sentence for it —');
  const mobPage = await (await browser.newContext()).newPage();
  await mobPage.goto(`${gateOrigin()}/register`, { waitUntil: 'domcontentloaded' });
  await mobPage.waitForSelector('[data-testid="signup-mobile"]');
  check('the field is marked required on the page itself',
    (await mobPage.locator('[data-testid="signup-mobile"]').getAttribute('required')) !== null,
    'the browser stops an empty submit before any of our code runs');
  check('  …and the label no longer calls it optional, with the promise under it',
    !/\(optional\)/.test(await mobPage.locator('label[for="mobile"]').innerText())
    && /won.t use it for marketing/i.test(await mobPage.locator('[data-testid="signup-mobile-why"]').innerText()),
    await mobPage.locator('[data-testid="signup-mobile-why"]').innerText());
  const mobAddr = `${LOW}-landline@example.invalid`;
  await mobPage.fill('input[autocomplete="name"]', `${PREFIX} landline`);
  await mobPage.fill('input[type="email"]', mobAddr);
  await mobPage.fill('input[type="password"]', PASS);
  // A LANDLINE IS A REAL NUMBER THAT CANNOT DO THE ONE THING THIS FIELD IS FOR, so `required` is
  // satisfied and only our own rule can refuse it. That is why this case is driven and not the
  // empty one: the empty one never reaches our code.
  await mobPage.fill('[data-testid="signup-mobile"]', '01204 123456');
  await mobPage.click('button[type="submit"]');
  await mobPage.waitForSelector('[data-testid="signup-error"]', { timeout: 10000 }).catch(() => {});
  const shown = await mobPage.locator('[data-testid="signup-error"]').innerText().catch(() => '');
  check('a landline is refused ON THE PAGE, in words that say what to type',
    /starting 07/.test(shown) && shown.includes(PF.UK_MOBILE_REFUSAL),
    shown.replace(/\n/g, ' ').slice(0, 120) || 'no error was shown');
  check('  …and no garage was created by the attempt',
    (await prisma.user.findUnique({ where: { email: mobAddr }, select: { id: true } })) === null,
    'a refusal that still signs somebody up is not a refusal');
  /**
   * AND THE ENDPOINT REFUSES IT TOO, from a page on the origin. The page's check is convenience;
   * this is the write surface. 400 and the SAME sentence, so somebody who corrects the field is not
   * then refused in different words by the route.
   */
  /**
   * `mobile: null` MEANS THE KEY IS OMITTED, deliberately, rather than `undefined` being passed to
   * evaluate: an undefined inside a serialized argument is not a thing to rely on, and "the field
   * was absent from the body" is the case being tested.
   */
  const rawMobile = async (mobile, email) => mobPage.evaluate(async ([origin, m, e]) => {
    const r = await fetch(`${origin}/api/auth/register-garage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'ZZCV raw', email: e, password: 'GateGarage!2026', ...(m === null ? {} : { mobile: m }) }),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, [gateOrigin(), mobile, email]);
  const noneSent = await rawMobile(null, `${LOW}-raw-none@example.invalid`);
  check('the endpoint refuses a POST with no mobile at all',
    noneSent.status === 400 && /mobile number/i.test(String(noneSent.body?.message)),
    `${noneSent.status} ${JSON.stringify(noneSent.body?.message)}`);
  const landlineSent = await rawMobile('01204123456', `${LOW}-raw-landline@example.invalid`);
  check('  …and one that is not a mobile, in the same sentence as the page',
    landlineSent.status === 400 && landlineSent.body?.message === PF.UK_MOBILE_REFUSAL,
    `${landlineSent.status} ${JSON.stringify(landlineSent.body?.message)}`);
  check('  …and nothing was written by either',
    (await prisma.user.count({ where: { email: { startsWith: `${LOW}-raw-` } } })) === 0,
    'refused before the password is hashed and before any row is created');
  const okSent = await rawMobile('+44 7700 900125', `${LOW}-raw-ok@example.invalid`);
  check('  …while a UK mobile written internationally is accepted',
    okSent.status === 201,
    `${okSent.status} ${JSON.stringify(okSent.body?.message ?? '')} — the refusal is about the shape, not about the +`);
  check('    …and lands normalised, still unverified',
    await (async () => {
      const u = await prisma.user.findUnique({ where: { email: `${LOW}-raw-ok@example.invalid` }, select: { id: true } });
      const tf = u && await prisma.twoFactorSecret.findUnique({
        where: { subject_type_subject_id: { subject_type: 'tenant', subject_id: u.id } },
        select: { phone_e164: true, phone_verified_at: true, phone_recorded_at: true, enabled: true },
      });
      return tf?.phone_e164 === '447700900125' && tf?.phone_verified_at === null
        && tf?.phone_recorded_at === null && tf?.enabled === false;
    })(), 'required is not verified — the SMS step still has to happen');
  check('the shape rule, over the numbers people actually type',
    ['07700900123', ' 07700 900123 ', '+447700900123', '447700900123', '0044 7700 900123']
      .every((m) => PF.plausibleUkMobile(m))
    && ['', '  ', '0770090012', '077009001234', '01204123456', '02079460000', '+353871234567', 'ask me later']
      .every((m) => !PF.plausibleUkMobile(m)),
    'a GB mobile is 07 and nine more digits, however it is written; a landline and a +353 are not');
  check('  …and an empty field is its own sentence, because the fix is different',
    PF.refuseSignupMobile('') !== PF.refuseSignupMobile('01204123456')
    && /Enter your mobile number/.test(PF.refuseSignupMobile('')),
    `${JSON.stringify(PF.refuseSignupMobile(''))}`);
  await mobPage.context().close();

  // THE STORAGE NORMALISER, including what it REFUSES. A column holding "ask me later" is worse
  // than an empty one: the alert built on it prints it to somebody about to dial.
  check('normaliseSignupMobile refuses what is not a number, rather than storing it',
    PF.normaliseSignupMobile('ask me later') === null
    && PF.normaliseSignupMobile('   ') === null
    && PF.normaliseSignupMobile('') === null
    && PF.normaliseSignupMobile(undefined) === null
    && PF.normaliseSignupMobile('12345') === null,
    'fewer than seven digits is not a phone number');
  check('  …strips control characters, which Postgres rejects as 22021',
    PF.normaliseSignupMobile('07397\u0000387332') === '07397387332');
  check('  …caps the length rather than storing a paste',
    PF.normaliseSignupMobile('0'.repeat(500))?.length === PF.SIGNUP_MOBILE_MAX,
    `capped at ${PF.SIGNUP_MOBILE_MAX}`);

  /**
   * ── 2b. A CONFLICT IS SAID IN WORDS, AND THE DATABASE NEVER SPEAKS TO A CUSTOMER ─────────────
   * THE INCIDENT (owner, 2026-11-01). A real signup through a real affiliate link answered, in the
   * box on the page: "Database error: P2002. Check your schema constraints. [catch]".
   *
   * The cause was two columns and one check. The endpoint read `User.email` and the transaction
   * wrote `Group.billing_email`, which carries its own @unique — so an address held by a GARAGE
   * with no account on it passed the check and collided inside the transaction. That is the exact
   * situation planted below: a group holding the address, and zero users on it.
   *
   * THE SENTENCES ARE DRIVEN THROUGH THE SCREEN, because the defect was a sentence on a screen.
   */
  console.log('\n— a conflict is said in words, and the database never speaks —');
  const heldAddr = `${LOW}-held@example.invalid`;
  const heldGroup = await prisma.group.create({
    data: { group_name: `${PREFIX} holds the address`, billing_email: heldAddr, trial_ends_at: new Date(Date.now() + 86400000) },
    select: { id: true },
  });
  check('the premise: a garage holds the address and there is NO account on it',
    (await prisma.user.count({ where: { email: heldAddr } })) === 0
    && (await prisma.group.count({ where: { billing_email: heldAddr } })) === 1,
    'this is the owner\'s own case — 0 User rows, 1 Group. Without it the clauses below test a different conflict');

  /** A mobile used by NOTHING ELSE in this gate, so "no row was written" can be counted exactly. */
  const HELD_MOBILE = '07700900199';
  const confPage = await (await browser.newContext()).newPage();
  await confPage.goto(`${gateOrigin()}/register`, { waitUntil: 'domcontentloaded' });
  await confPage.waitForSelector('[data-testid="signup-mobile"]');
  /**
   * THE SITE'S OWN NUMBER, READ OFF THE PAGE — not from company-info, and not typed here. The
   * owner's instruction was that the number in a refusal is the number on the site, so the oracle
   * has to be the site. COUNTED FIRST: one tel: link on this page, so the string below belongs to
   * the subject it is named after rather than to whichever link came first.
   */
  const telCount = await confPage.locator('a[href^="tel:"]').count();
  const siteNumber = (await confPage.locator('a[href^="tel:"]').first().innerText().catch(() => '')).trim();
  check('the page states the site\'s number exactly once, which is what the clauses below compare against',
    telCount === 1 && /\d/.test(siteNumber), `${telCount} tel: link(s), "${siteNumber}"`);
  await confPage.fill('input[autocomplete="name"]', `${PREFIX} held`);
  await confPage.fill('input[type="email"]', heldAddr);
  await confPage.fill('input[type="password"]', PASS);
  await confPage.fill('[data-testid="signup-mobile"]', HELD_MOBILE);
  await confPage.click('button[type="submit"]');
  await confPage.waitForSelector('[data-testid="signup-error"]', { timeout: 15000 }).catch(() => {});
  const conf = (await confPage.locator('[data-testid="signup-error"]').innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
  check('an address a garage already holds is refused in a sentence about garages',
    /already in use for an existing GreaseDesk garage/i.test(conf),
    conf.slice(0, 160) || 'no error was shown');
  check('  …and does NOT send them to reset a password for an account that does not exist',
    conf.length > 0 && !/reset your password/i.test(conf),
    'the old advice would have been a dead end: there is no account on this address to reset');
  check('  …and the database says nothing: no code, no "schema constraints", no stage marker',
    conf.length > 0 && !/P2002/.test(conf) && !/schema constraint/i.test(conf) && !/\[(catch|conflict|unique|validate)\]/.test(conf),
    conf.slice(0, 160));
  check('  …and the number it offers is the number the site states',
    siteNumber.length > 0 && conf.includes(siteNumber),
    `message ${conf.includes(siteNumber) ? 'carries' : 'does NOT carry'} "${siteNumber}"`);

  /**
   * ── AND NOTHING WAS LEFT BEHIND (item c) ─────────────────────────────────────────────────────
   * Counted on the address and on a mobile nothing else in this gate uses. The P2002 fired on the
   * FIRST statement in the transaction, so a rollback happened to be clean — that is luck, not a
   * property, and these are the counts that would have shown it otherwise.
   */
  check('the refused attempt left no account, no second garage, no mobile and no token',
    (await prisma.user.count({ where: { email: heldAddr } })) === 0
    && (await prisma.group.count({ where: { billing_email: heldAddr } })) === 1
    && (await prisma.twoFactorSecret.count({ where: { phone_e164: CR.toE164Digits(HELD_MOBILE) } })) === 0
    && (await prisma.verificationToken.count({ where: { identifier: heldAddr } })) === 0,
    'all-or-nothing, counted rather than assumed');

  /**
   * REFUSED BEFORE ANYTHING IS ATTEMPTED, which is the half a sentence cannot show. `where` is the
   * endpoint's own stage marker: 'unique' is the pre-flight check, 'conflict' is the mapped P2002
   * from inside the transaction. Both say the same true thing to the person; only the first costs
   * nothing — no bcrypt hash, no transaction, and no group ref burned out of the sequence by an
   * insert that rolls back. Delete the billing_email pre-check and this clause goes red while the
   * sentence clauses above stay green, which is exactly the distinction being drawn.
   */
  const rawPost = async (body) => confPage.evaluate(async ([origin, b]) => {
    const r = await fetch(`${origin}/api/auth/register-garage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, [gateOrigin(), body]);
  const heldPost = await rawPost({ name: 'ZZCV held raw', email: heldAddr, password: PASS, mobile: HELD_MOBILE });
  check('the endpoint refuses it at 409, at the pre-flight check rather than inside the transaction',
    heldPost.status === 409 && heldPost.body?.where === 'unique'
    && /existing GreaseDesk garage/i.test(String(heldPost.body?.message)),
    `${heldPost.status} where=${heldPost.body?.where}`);
  /** THE OTHER EMAIL CASE: an address somebody can actually sign in with gets the other advice. */
  const dupPost = await rawPost({ name: 'ZZCV dup raw', email: `${LOW}-raw-ok@example.invalid`, password: PASS, mobile: HELD_MOBILE });
  check('an address with a REAL account on it is told to sign in or reset — the other situation, the other advice',
    dupPost.status === 409 && /Sign in instead/i.test(String(dupPost.body?.message))
    && /reset your password/i.test(String(dupPost.body?.message)),
    `${dupPost.status} ${String(dupPost.body?.message).slice(0, 90)}`);
  check('  …and the two email conflicts are not answered with one sentence',
    String(heldPost.body?.message) !== String(dupPost.body?.message),
    'one of them has no account to sign into; collapsing them is how the dead-end advice got shipped');

  /**
   * AN ERROR NOBODY MAPPED, DRIVEN RATHER THAN SIMULATED. A NUL byte makes the pre-flight lookup
   * genuinely throw (Postgres refuses it, 22021) — the same honest technique sign-in-failure-gate
   * uses. What reaches the person must be the one generic sentence, and nothing of the error.
   * The address is never printed into this log: a NUL in the output corrupts the whole file.
   */
  const nulPost = await rawPost({ name: 'ZZCV nul', email: `${LOW}-nul\u0000bad@example.invalid`, password: PASS, mobile: HELD_MOBILE });
  const nulMsg = String(nulPost.body?.message ?? '');
  check('an error nobody mapped is answered with the one generic sentence, at 500',
    nulPost.status === 500 && nulMsg === SR.SIGNUP_GENERIC,
    `${nulPost.status} ${JSON.stringify(nulMsg).replace(/\u0000/g, '')}`);
  check('  …which names the site\'s number, and carries nothing of the error',
    nulMsg.includes(siteNumber) && !/22021|unicode|postgres|prisma|invalid byte/i.test(nulMsg),
    'the old code put err.message on the screen for anything that was not a Prisma error');

  /**
   * ── THE PURE RULE, OVER THE SHAPES A CONNECTOR ACTUALLY SENDS ────────────────────────────────
   * P2002 arrives carrying either a constraint NAME or a column LIST depending on the connector, so
   * both are exercised. The first clause is the ORDERING clause: 'billing_email' contains 'email',
   * so a registry in the wrong order answers every garage-level clash with "reset your password".
   */
  check('a billing_email clash is recognised as a garage, in both shapes a connector sends',
    SR.signupRefusal({ code: 'P2002', meta: { target: 'Group_billing_email_key' } }).code === 'billing_email'
    && SR.signupRefusal({ code: 'P2002', meta: { target: ['billing_email'] } }).code === 'billing_email',
    'put the user_email row first and this goes red: the substring matches both');
  check('  …and a User.email clash as an account, in both shapes',
    SR.signupRefusal({ code: 'P2002', meta: { target: 'User_email_key' } }).code === 'user_email'
    && SR.signupRefusal({ code: 'P2002', meta: { target: ['email'] } }).code === 'user_email');
  check('a conflict we cannot NAME is still a conflict — 409, and no guess about which field',
    SR.signupRefusal({ code: 'P2002', meta: {} }).status === 409
    && SR.signupRefusal({ code: 'P2002', meta: {} }).code === 'conflict_unknown'
    && SR.signupRefusal({ code: 'P2002', meta: {} }).message === SR.SIGNUP_GENERIC,
    'three outcomes, not two: named, unnamed, and not a conflict at all');
  check('anything else is a 500 with the generic sentence, and the error\'s own words are NOT in it',
    SR.signupRefusal(new Error('boom')).status === 500
    && SR.signupRefusal(new Error('boom')).message === SR.SIGNUP_GENERIC
    && !/boom/.test(SR.signupRefusal(new Error('boom')).message));
  /**
   * AN ERROR CARRYING CREDENTIALS. Written as host/user/password fields rather than as a
   * `scheme://user:pass@host` URI ON PURPOSE: gitleaks blocks a database URI in this repo, and it
   * is right to — the repo is public and has carried a live Neon string before. A fabricated one is
   * a false positive, and the remedy for a false positive is not to teach the scanner to ignore
   * that rule on this line; the assertion needs an error with secrets in it, not a URI.
   */
  const leaky = new Error('connect ECONNREFUSED db.invalid:5432 user=gd password=hunter2');
  check('  …including an error carrying credentials, which used to go straight to the browser',
    !/hunter2|db\.invalid|ECONNREFUSED|password=/.test(SR.signupRefusal(leaky).message),
    'this is a disclosure path, not a wording problem');
  check('every sentence a person can read names the site\'s number or says what to do, and none names a code',
    [SR.SIGNUP_GENERIC, SR.conflictMessage('user_email'), SR.conflictMessage('billing_email'), SR.conflictMessage('mobile')]
      .every((m) => m.length > 20 && !/P\d{4}|constraint|schema|prisma/i.test(m))
    && SR.SIGNUP_GENERIC.includes(CI.COMPANY.phone) && SR.conflictMessage('billing_email').includes(CI.COMPANY.phone),
    'and the number is company-info\'s, which is the one the page prints');

  /**
   * ── THE MOBILE: A SENTENCE EXISTS, AND NOTHING CAN PRODUCE IT ────────────────────────────────
   * The owner decided on 2026-11-01 that a mobile stays NON-UNIQUE — a couple running a garage
   * share one, and the field is there to help us set them up, not to identify anybody. The sentence
   * is registered so it never has to be invented under pressure; BOTH halves are asserted, because
   * a registered message for an impossible conflict is a blindfold unless the impossibility is
   * asserted too. Add a unique index on phone_e164 and this goes red naming that decision.
   */
  const schemaSrc = readFileSync(`${R}/prisma/schema.prisma`, 'utf8');
  const tfsAt = schemaSrc.indexOf('model TwoFactorSecret');
  const tfsBlock = tfsAt < 0 ? '' : schemaSrc.slice(tfsAt, schemaSrc.indexOf('\n}', tfsAt));
  check('the registry answers a mobile clash plainly, naming no field and no code',
    /already in use/i.test(SR.conflictMessage('mobile')) && !/P2002|phone_e164/.test(SR.conflictMessage('mobile')),
    JSON.stringify(SR.conflictMessage('mobile')));
  check('  …and NOTHING can raise it: no unique index makes a mobile an identifier',
    tfsBlock.includes('phone_e164')
    && !/phone_e164[^\n]*@unique/.test(tfsBlock)
    && !/@@unique\(\[[^\]]*phone_e164/.test(tfsBlock),
    tfsBlock.includes('phone_e164') ? 'the owner\'s 2026-11-01 decision, asserted' : 'the scan never reached TwoFactorSecret');

  /**
   * ── (c) NOTHING AFTER THE COMMIT MAY REPORT A FAILURE ────────────────────────────────────────
   * The garage is committed before the verification token is inserted or the email attempted. Those
   * sat in the same try as the transaction, so a throw there answered 500 for a signup that had
   * SUCCEEDED — the person would try again and be told the address was taken, by their own account.
   *
   * DRIVEN WHERE IT CAN BE: in this environment the send is genuinely refused (no provider, and the
   * environment marker refuses real sends from a gate), so every signup here exercises the
   * failed-send arm for real. What is NOT driven is a THROW in that tail: nothing reachable from a
   * signup can be made to throw there without putting a test hook in the route, so the structural
   * rule is asserted instead — no `return res` exists between the commit and the 201.
   */
  const tailAddr = `${LOW}-tail@example.invalid`;
  const tailPost = await rawPost({ name: 'ZZCV tail', email: tailAddr, password: PASS, mobile: '07700900198' });
  const tailUser = await prisma.user.findUnique({ where: { email: tailAddr }, select: { id: true, group_id: true } });
  const tailLog = tailUser && await prisma.notificationLog.findFirst({
    where: { group_id: tailUser.group_id, template: 'signup_verify' }, select: { status: true },
  });
  check('a verification email that did not go does NOT fail the signup',
    tailPost.status === 201 && !!tailUser && tailLog?.status !== 'sent',
    `201=${tailPost.status === 201} garage=${!!tailUser} send=${tailLog?.status ?? 'no row'}`);
  check('  …and the endpoint SAYS the email did not go, rather than letting the next page claim it did',
    tailPost.body?.verifySent === false && /could not send your verification email/i.test(String(tailPost.body?.message)),
    `verifySent=${JSON.stringify(tailPost.body?.verifySent)}`);
  const route = readFileSync(`${R}/pages/api/auth/register-garage.ts`, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const commitAt = route.indexOf('} catch (txErr');
  const afterAt = route.indexOf('= committed;');
  const okAt = route.indexOf('return res.status(201)');
  const commitCatch = commitAt < 0 ? '' : route.slice(commitAt, afterAt);
  const tail = afterAt < 0 || okAt < 0 ? '' : route.slice(afterAt, okAt);
  check('the commit\'s own catch RETURNS — a conflict is answered there and nowhere else',
    commitAt >= 0 && commitAt < afterAt && /return res\.status\(refusal\.status\)/.test(commitCatch),
    `${commitCatch.length} chars`);
  check('  …and between the commit and the 201 there is not one `return res`',
    tail.length > 500 && !/return\s+res\./.test(tail),
    tail.length > 500 ? `${tail.length} chars of tail, none of it able to answer a failure` : 'the slice collapsed — this clause proved nothing');

  /**
   * AND THE PAGE THAT SAYS SO. /onboarding/check-email was one long claim that a link had been
   * sent; it now reads the endpoint's answer. Both states are driven, because the one that matters
   * is the one nobody sees until a provider is down.
   */
  const okPage = await (await browser.newContext()).newPage();
  await okPage.goto(`${gateOrigin()}/onboarding/check-email?email=${encodeURIComponent(tailAddr)}`, { waitUntil: 'domcontentloaded' });
  check('check-email claims a link was sent when one was',
    (await okPage.locator('[data-testid="check-email-sent"]').count()) === 1
    && (await okPage.locator('[data-testid="check-email-not-sent"]').count()) === 0);
  await okPage.goto(`${gateOrigin()}/onboarding/check-email?email=${encodeURIComponent(tailAddr)}&verify=0`, { waitUntil: 'domcontentloaded' });
  const notSent = (await okPage.locator('[data-testid="check-email-not-sent"]').innerText().catch(() => '')).replace(/\s+/g, ' ');
  check('  …and when it was not, it says the account exists, gives the number, and does not claim a link',
    (await okPage.locator('[data-testid="check-email-sent"]').count()) === 0
    && /account is set up/i.test(notSent) && notSent.includes(CI.COMPANY.phone)
    && !/sent a verification link/i.test(notSent),
    notSent.slice(0, 140) || 'nothing rendered');
  check('  …and does not tell them to register again, which is now a refusal',
    notSent.length > 0 && !/register(ing)? again/i.test(notSent),
    'the address is taken now — by them');
  await okPage.context().close();
  await confPage.context().close();

  // A CLIENT THAT NEVER WENT NEAR THE FORM. This is the shape the missing CHECK constraint would
  // have caught in the database, so it is asserted at the only place that can refuse it.
  // FROM A PAGE ON THE ORIGIN, not from about:blank: a fetch from a blank context is cross-origin
  // and fails before it reaches us, which looks exactly like the endpoint refusing.
  const postPage = await (await browser.newContext()).newPage();
  await postPage.goto(`${gateOrigin()}/register`, { waitUntil: 'domcontentloaded' });
  const posted = await postPage.evaluate(async (origin) => {
    const r = await fetch(`${origin}/api/auth/register-garage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'ZZCV handposted', email: 'zzcv-handposted@example.invalid', password: 'GateGarage!2026',
        heardAbout: 'MY OWN STRING', heardAboutOther: 'and some prose', utm: { source: 'x'.repeat(400) },
        // REQUIRED SINCE 2026-11-01. Without it this POST is refused at 400 and the clause below
        // would be asserting about a garage that was never created — which is what it did when the
        // field changed and this line was not yet here.
        mobile: '07700900124',
      }),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, gateOrigin());
  const handposted = await prisma.user.findUnique({ where: { email: 'zzcv-handposted@example.invalid' }, select: { group_id: true } });
  const handGroup = handposted && await prisma.group.findUnique({ where: { id: handposted.group_id }, select: { heard_about: true, heard_about_other: true, utm_source: true } });
  check('a hand-posted answer that is not on the list lands as NULL',
    posted.status === 201 && handGroup?.heard_about === null && handGroup?.heard_about_other === null,
    `HTTP ${posted.status}, heard_about ${JSON.stringify(handGroup?.heard_about)} — refused, and the signup still succeeded`);
  check('  …and an over-long campaign value is capped, not rejected',
    (handGroup?.utm_source ?? '').length === SS.UTM_MAX,
    'a bad parameter must not fail somebody\'s signup');

  // ── 4. THE CAMPAIGN, UNDER THE SAME CONSENT RULE AS THE REF ──────────────────────────────────
  console.log('\n— what the link said —');
  const urlUtm = await signUp('urlutm', { urlUtm: 'utm_source=youtube&utm_medium=video&utm_campaign=zzcv-spring' });
  check('utm_* on the signup URL is captured with NO cookie and NO consent',
    urlUtm.group?.utm_source === 'youtube' && urlUtm.group?.utm_medium === 'video' && urlUtm.group?.utm_campaign === 'zzcv-spring',
    'read from the URL into the form and submitted with it — nothing is stored, so there is nothing to ask about');
  check('  …and it stored nothing on the way: no gd_utm was written',
    !urlUtm.cookiesAfter.some((c) => c.name === 'gd_utm'),
    'the consent banner was sitting there undecided');

  const refused = await signUp('refused', { visitFirst: ['?utm_source=zzcv-refused&utm_campaign=zzcv-no'], consent: 'reject' });
  check('the refusal was actually recorded, so the absence below means something',
    refused.consentRecorded === true && refused.functional === false,
    `gd_consent written: ${refused.consentRecorded}, functional: ${refused.functional} — without this, a page with no working JavaScript stores nothing and passes`);
  check('  …and a campaign seen on an earlier page with consent REFUSED records nothing',
    refused.group?.utm_source === null && refused.group?.utm_campaign === null
    && !refused.cookiesAfter.some((c) => c.name === 'gd_utm'),
    'this is the cost of the cookie rule, and it is the same cost gd_ref pays');

  const accepted = await signUp('accepted', {
    visitFirst: ['?utm_source=zzcv-first&utm_medium=cpc&utm_campaign=zzcv-one', '?utm_source=zzcv-second&utm_campaign=zzcv-two'],
    consent: 'accept',
  });
  check('the consent was recorded as GIVEN', accepted.functional === true, `functional: ${accepted.functional}`);
  check('  …and the cookie carries the campaign between the two page views',
    accepted.cookiesAfter.some((c) => c.name === 'gd_utm'),
    'the only thing that gets a campaign from the first visit to a signup days later');
  check('a campaign seen on an earlier page with consent GIVEN reaches the signup',
    accepted.group?.utm_source === 'zzcv-first' && accepted.group?.utm_medium === 'cpc',
    `${accepted.group?.utm_source} / ${accepted.group?.utm_medium} / ${accepted.group?.utm_campaign}`);
  check('  …and the FIRST visit wins: the second link did not overwrite it',
    accepted.group?.utm_campaign === 'zzcv-one',
    'the campaign that introduced somebody is the one that did the work');

  const urlBeatsCookie = await signUp('urlbeats', {
    cookies: [{ name: 'gd_utm', value: encodeURIComponent(JSON.stringify({ s: 'zzcv-cookie', c: 'zzcv-old' })), domain: 'localhost', path: '/' }],
    urlUtm: 'utm_source=zzcv-url&utm_campaign=zzcv-now',
  });
  check('on the signup page itself the URL beats the cookie',
    urlBeatsCookie.group?.utm_source === 'zzcv-url' && urlBeatsCookie.group?.utm_campaign === 'zzcv-now',
    'arriving on the form with a campaign on it describes THIS arrival, which is the better evidence');

  // WITHDRAWAL CLEARS IT. gd_utm was added second, and a withdrawal that clears one of two cookies
  // is exactly the shape this misses.
  const wctx = await browser.newContext();
  const wpage = await wctx.newPage();
  await wpage.goto(`${gateOrigin()}/?utm_source=zzcv-withdraw&utm_campaign=zzcv-bye`, { waitUntil: 'domcontentloaded' });
  // NO .catch ON THESE CLICKS. A swallowed driving failure is how this clause first reported the
  // code as broken: the footer link opens the MODAL, whose backdrop then intercepts the strip's
  // own Reject button, so the second click never landed and the cookie was still there — which
  // looks exactly like a withdrawal that does not clear it.
  await wpage.click('[data-testid="consent-accept"]', { timeout: 15000 });
  await wpage.waitForFunction(() => document.cookie.includes('gd_utm'), null, { timeout: 10000 });
  const hadUtm = (await wctx.cookies()).some((c) => c.name === 'gd_utm');
  await wpage.getByRole('button', { name: 'Cookie settings' }).first().click({ timeout: 15000 });
  await wpage.locator('[data-testid="consent-modal"]').getByRole('button', { name: 'Reject all' }).click({ timeout: 15000 });
  await wpage.waitForFunction(() => !document.cookie.includes('gd_utm'), null, { timeout: 10000 }).catch(() => {});
  const stillUtm = (await wctx.cookies()).some((c) => c.name === 'gd_utm');
  await wctx.close();
  check('withdrawing functional consent clears the campaign cookie too',
    hadUtm && !stillUtm, `written: ${hadUtm}, still there after withdrawal: ${stillUtm}`);

  // ── 5. CAME VIA: FOUR ANSWERS, AND THEY ARE TOLD APART ───────────────────────────────────────
  console.log('\n— who introduced them —');
  const aff = await prisma.rep.create({ data: {
    party_type: 'affiliate', email: `${LOW}-aff@example.invalid`, name: `${PREFIX} Affiliate`,
    ref_code: `${PREFIX}AFF`, terms_accepted_at: new Date('2026-01-01T00:00:00Z') }, select: { id: true } });
  const rep = await prisma.rep.create({ data: {
    party_type: 'rep', email: `${LOW}-rep@example.invalid`, name: `${PREFIX} Reseller`,
    ref_code: `${PREFIX}REP` }, select: { id: true } });

  const byAff = await signUp('byaff', { urlRef: `${PREFIX}AFF`, heard: 'youtube' });
  const viaAff = await CV.cameVia(prisma, byAff.group.id);
  check('a garage an affiliate introduced reads as an AFFILIATE',
    viaAff.referrer.kind === 'affiliate' && viaAff.referrer.refCode === `${PREFIX}AFF`,
    CV.referrerSentence(viaAff.referrer));
  check('  …from the FROZEN terms, with the date those terms were struck',
    viaAff.referrer.frozen === true && typeof viaAff.referrer.since === 'string',
    `frozen ${viaAff.referrer.frozen}, since ${viaAff.referrer.since}`);

  const byRep = await signUp('byrep', { urlRef: `${PREFIX}REP` });
  const viaRep = await CV.cameVia(prisma, byRep.group.id);
  check('a garage a RESELLER introduced reads as a reseller',
    viaRep.referrer.kind === 'reseller' && viaRep.referrer.refCode === `${PREFIX}REP`,
    CV.referrerSentence(viaRep.referrer));
  check('  …and it is NOT the word used for the affiliate',
    viaAff.referrer.kind !== viaRep.referrer.kind,
    'both had an active attribution, and the old expression called both of them resellers');
  check('  …a reseller has no frozen terms row, and the screen is told so',
    viaRep.referrer.frozen === false,
    'the rate is effective-dated and resolved at collection — there is no per-garage document');

  // AN AFFILIATE ATTRIBUTION WITH NO FROZEN TERMS. A real state: a code that resolved after the
  // fact attributes without freezing anything, and there is then no document saying what is owed.
  const orphan = await signUp('orphan');
  await prisma.tenantAttribution.create({ data: {
    group_id: orphan.group.id, party_type: 'affiliate', party_id: aff.id, role: 'referrer',
    share_bp: 10000, effective_from: new Date('2026-05-05T00:00:00Z'), source: 'ref_param' } });
  const viaOrphan = await CV.cameVia(prisma, orphan.group.id);
  check('an affiliate attributed with no frozen terms is still an affiliate, and says it is unfrozen',
    viaOrphan.referrer.kind === 'affiliate' && viaOrphan.referrer.frozen === false,
    'otherwise the reward would quietly be read from today\'s settings and nobody would know');

  // THE DISAGREEMENT. No path writes this; a hand-made correction can.
  await prisma.tenantAttribution.create({ data: {
    group_id: byAff.group.id, party_type: 'rep', party_id: rep.id, role: 'referrer',
    share_bp: 10000, effective_from: new Date('2026-06-06T00:00:00Z'), source: 'manual' } });
  const viaConflict = await CV.cameVia(prisma, byAff.group.id);
  check('frozen affiliate terms AND a live reseller attribution is a CONFLICT, not a choice',
    viaConflict.referrer.kind === 'conflict' && /affiliate/.test(viaConflict.referrer.detail) && /reseller/.test(viaConflict.referrer.detail),
    'picking the first would be a guess about who is owed money, printed as a fact');
  await prisma.tenantAttribution.deleteMany({ where: { group_id: byAff.group.id, party_type: 'rep' } });

  const unknown = await signUp('unknown', { urlRef: `${PREFIX}NOBODY` });
  const viaUnknown = await CV.cameVia(prisma, unknown.group.id);
  check('a code nobody holds is reported as unmatched, with the code',
    viaUnknown.referrer.kind === 'unmatched_code' && viaUnknown.referrer.code === `${PREFIX}NOBODY`,
    'it is kept, and resolves on its own if that code is ever issued');
  const viaDirect = await CV.cameVia(prisma, skipped.group.id);
  check('a garage that presented no code at all is DIRECT',
    viaDirect.referrer.kind === 'direct',
    'the form submits a code without needing a cookie, so its absence is a fact about the signup');
  check('  …and the sentence says why, rather than just the word',
    /no referral code was presented/.test(CV.referrerSentence(viaDirect.referrer)),
    CV.referrerSentence(viaDirect.referrer));

  // AND THE OTHER TWO AXES ARE SEPARATE FROM ALL OF THAT.
  check('a DIRECT garage that answered the question still carries its answer',
    viaDirect.heardAbout === null && viaAff.heardAbout?.value === 'youtube' && viaAff.heardAbout?.label === 'YouTube',
    'who referred them and how they heard of us are different questions with different sources');
  check('  …and "not recorded" is NULL, not an empty answer',
    viaDirect.heardAbout === null && viaDirect.utm.source === null,
    'an empty object would pass every `if (x)` and read on the screen as an answer of nothing');

  await prisma.rep.update({ where: { id: aff.id }, data: { suspended_at: new Date('2026-07-07T00:00:00Z') } });
  const viaSuspended = await CV.cameVia(prisma, byAff.group.id);
  check('a suspended introducer is surfaced with the date',
    (viaSuspended.referrer.suspendedAt ?? '').startsWith('2026-07-07'),
    'the operator looking at this page is usually looking for exactly that');
  // BOTH BRANCHES, because there are two. The clause above reads the garage with FROZEN TERMS, and
  // a red-proof that blanked the date in the attribution branch came back green — the assertion
  // covered one of the two paths that answer this question, which is the same as covering neither.
  const viaSuspendedAttrib = await CV.cameVia(prisma, orphan.group.id);
  check('  …including the garage whose introducer comes from the ATTRIBUTION, not the terms',
    (viaSuspendedAttrib.referrer.suspendedAt ?? '').startsWith('2026-07-07'),
    'two branches answer this question and a clause through one of them says nothing about the other');
  await prisma.rep.update({ where: { id: aff.id }, data: { suspended_at: null } });

  // ── 6. AND AN OPERATOR CAN READ IT ON THE SCREEN ─────────────────────────────────────────────
  console.log('\n— through the real Engine Room —');
  const op = await prisma.operator.create({ data: {
    email: OP_EMAIL, name: 'Came via gate', role: 'owner', status: 'active',
    regions: ['GB'], passwordHash: await bcrypt.hash(OP_PASS, 10) }, select: { id: true } });
  const erBrowser = await chromium.launch({ channel: 'chrome', args: ER_RESOLVER_ARGS });
  try {
    const page = await (await erBrowser.newContext({ viewport: { width: 1280, height: 2400 } })).newPage();
    const ER = erOrigin();
    const onLogin = (p) => underPath(p, '/superadmin/login');
    await page.goto(`${ER}/superadmin/login`, { waitUntil: 'domcontentloaded' });
    await page.fill('input[type="email"]', OP_EMAIL);
    await page.fill('input[type="password"]', OP_PASS);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !onLogin(u.pathname), { timeout: 60000 }).catch(() => {});
    check('an owner operator is signed in', !onLogin(new URL(page.url()).pathname), page.url());

    const open = async (groupId) => {
      await page.goto(`${ER}/superadmin/tenants/${groupId}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-testid="came-via-referrer"]', { timeout: 30000 });
      return {
        referrer: (await page.locator('[data-testid="came-via-referrer"]').innerText()).trim(),
        heard: (await page.locator('[data-testid="came-via-heard"]').innerText()).trim(),
        campaign: (await page.locator('[data-testid="came-via-campaign"]').innerText()).trim(),
        html: await page.content(),
      };
    };

    const screenAff = await open(byAff.group.id);
    check('the affiliate-referred garage names the affiliate on the screen',
      screenAff.referrer.includes(`${PREFIX} Affiliate`) && screenAff.referrer.includes(`${PREFIX}AFF`),
      screenAff.referrer);
    // THE DISCRIMINATING CLAUSE. This is the defect, in the rendered page: the old expression put
    // "Reseller" here for every affiliate referral.
    check('  …and the word "reseller" appears nowhere in that answer',
      !/reseller/i.test(screenAff.referrer),
      'the defect this gate exists for — an affiliate is paid instalments against frozen terms, a reseller on a taper by a pay run');
    check('  …with the answer to the question beside it, not folded into it',
      screenAff.heard.includes('YouTube'), screenAff.heard);

    const screenRep = await open(byRep.group.id);
    check('the reseller-referred garage says reseller',
      /reseller/i.test(screenRep.referrer) && screenRep.referrer.includes(`${PREFIX}REP`), screenRep.referrer);

    const screenDirect = await open(skipped.group.id);
    check('a direct signup reads as direct, with the reason',
      /direct/i.test(screenDirect.referrer) && /no referral code/i.test(screenDirect.referrer), screenDirect.referrer);
    check('  …and the two unanswered axes say NOT RECORDED, in words',
      /not recorded/i.test(screenDirect.heard) && /not recorded/i.test(screenDirect.campaign),
      `${screenDirect.heard} | ${screenDirect.campaign}`);

    const screenCampaign = await open(urlUtm.group.id);
    check('a garage that arrived on a campaign link shows the campaign',
      screenCampaign.campaign.includes('youtube') && screenCampaign.campaign.includes('zzcv-spring'),
      screenCampaign.campaign);

    const screenTyped = await open(typed.group.id);
    check('and the free-text answer is shown as what they wrote',
      screenTyped.heard.includes('A bloke at the auction'), screenTyped.heard);
  } finally {
    await erBrowser.close().catch(() => {});
  }

} catch (e) {
  console.log(`\n✗ THREW: ${describeError(e).slice(0, 700)}`);
  out.push('F');
} finally {
  await browser?.close().catch(() => {});
  const left = await sweep().catch(() => -1);
  check('teardown removed every fixture row', left >= 0, `${left} row(s)`);
  console.log(`\n${out.filter((x) => x === 'F').length} failures of ${out.length}`);
  await prisma?.$disconnect();
  process.exit(out.includes('F') ? 1 : 0);
}
