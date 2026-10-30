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
const { underPath } = await import('../lib/anchored-match.ts');
const SS = await import('../lib/signup-source.ts');
const CV = await import('../lib/came-via.ts');
const AF = await import('../lib/affiliate.ts');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const PREFIX = 'ZZCV';
const LOW = PREFIX.toLowerCase();
const PASS = 'GateGarage!2026';
const OP_EMAIL = `${LOW}-came-via-gate@greasedesk.test`;
const OP_PASS = 'GateCameVia!2026';

let prisma, browser;

const sweep = async () => {
  if (!prisma) return 0;
  const reps = (await prisma.rep.findMany({ where: { ref_code: { startsWith: PREFIX, mode: 'insensitive' } }, select: { id: true } })).map((r) => r.id);
  const named = (await prisma.group.findMany({ where: { group_name: { startsWith: PREFIX } }, select: { id: true } })).map((g) => g.id);
  // AND THE GARAGES THE ENDPOINT NAMED ITSELF: register-garage writes the neutral 'New garage', so
  // a sweep matching only the prefix would leave behind every garage created through the real path.
  const viaUsers = (await prisma.user.findMany({ where: { email: { startsWith: `${LOW}-` } }, select: { group_id: true } })).map((u) => u.group_id);
  const all = [...new Set([...named, ...viaUsers])].filter(Boolean);
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
  const signUp = async (n, { urlRef = null, urlUtm = null, heard = null, other = null, consent = null, cookies = null, visitFirst = null } = {}) => {
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
    await page.click('button[type="submit"]');
    await page.waitForURL(/check-email/, { timeout: 20000 });
    const cookiesAfter = await ctx.cookies();
    await ctx.close();
    // DID THE BANNER ACTUALLY WORK? The choice is only a choice if it was recorded. Returned so a
    // clause about an absence can say the absence followed a decision rather than a dead page.
    const decided = cookiesAfter.find((c) => c.name === 'gd_consent');
    const functional = decided ? /%22functional%22%3Atrue|"functional":true/.test(decided.value) : null;
    const user = await prisma.user.findUnique({ where: { email: addr }, select: { group_id: true } });
    const group = user && await prisma.group.findUnique({
      where: { id: user.group_id },
      select: { id: true, signup_ref: true, heard_about: true, heard_about_other: true, utm_source: true, utm_medium: true, utm_campaign: true },
    });
    return { group, cookiesAfter, consentRecorded: !!decided, functional };
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
