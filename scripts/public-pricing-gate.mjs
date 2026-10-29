/**
 * File: scripts/public-pricing-gate.mjs
 * @gate-requires: db, server
 *
 * THE PUBLIC PRICING SURFACE — /pricing, the home page's price line and /llms.txt.
 *
 * ── WHAT THIS IS FOR ───────────────────────────────────────────────────────────────────────────
 * Annual billing shipped to production on 2026-10-29 and a prospect could not see it: /pricing
 * quoted one monthly figure and said nothing about yearly at all.
 *
 * WHAT IS AND IS NOT A SETTING, since every clause below depends on it. The monthly price is a
 * COUNTRY-PROFILE CONSTANT (lib/locale-profiles, GB £75) and changing it needs a deploy; the
 * MONTHS are Engine Room settings. So the figures an operator can move are the yearly price, its
 * monthly equivalent and the saving — `months × the constant` — which is exactly the half that was
 * missing from the public site. This gate moves `renewal_annual_months_paid` and watches all three
 * surfaces follow.
 *
 * Going through one resolver matters because of the saving: it is `months_given × monthly − yearly`,
 * and two surfaces each doing that arithmetic their own way is how one ends up a deploy behind.
 *
 * ── THE ORACLE IS THE SETTINGS ROW, NEVER lib/plan-choice ──────────────────────────────────────
 * Every expected figure below is worked from the ProgrammeSettings row and the GB price ladder.
 * A clause comparing the page against the module that rendered it agrees with itself whatever
 * both of them say.
 *
 * ── WHAT IT CANNOT PROVE, SAID PLAINLY ─────────────────────────────────────────────────────────
 * In dev, getStaticProps runs on EVERY request, so "the page moved when the setting moved" would
 * pass even if on-demand revalidation did nothing at all. The production mechanism is not
 * exercised here. What IS checked is that the save asks for exactly the prerendered route keys,
 * that it reads the pages back rather than trusting the refresher, and that a page which has not
 * caught up is reported as NOT verified. Confirming the live site after a deploy is a person's job.
 */
import './_gate-preflight.mjs';
const { gatePrisma, gateOrigin, serverReady, onTeardown, describeError, declineToRun } = await import('./_gate-preflight.mjs');
import './_ts.mjs';

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const R = '/Users/hugh/Developer/greasedesk-core';
const B = gateOrigin();

let prisma;
let PS;
/** The value this gate itself wrote, so the sweep restores ONLY its own edit. */
let gateWrote = null;
let originalMonths = null;

try {
  prisma = await gatePrisma();
  onTeardown(async () => {
    // RESTORE ONLY WHAT THIS GATE WROTE. A person editing the setting mid-run outranks the gate's
    // bookkeeping; restoring over them would put a fictional price on the public site.
    if (gateWrote !== null && originalMonths !== null) {
      const now = await prisma.programmeSettings.findUnique({ where: { id: 'singleton' }, select: { renewal_annual_months_paid: true } });
      if (now?.renewal_annual_months_paid === gateWrote) {
        await prisma.programmeSettings.update({ where: { id: 'singleton' }, data: { renewal_annual_months_paid: originalMonths } });
      }
    }
  });
  if (!(await serverReady())) declineToRun(`no dev server answering on ${B}`);

  PS = await import(`${R}/lib/programme-settings.ts`);
  const PC = await import(`${R}/lib/plan-choice.ts`);

  const s = await prisma.programmeSettings.findUnique({ where: { id: 'singleton' } });
  if (!s) declineToRun('no ProgrammeSettings singleton on the gate database');
  originalMonths = s.renewal_annual_months_paid;

  // ── THE ORACLE ────────────────────────────────────────────────────────────────────────────
  // MONTHLY_P is the GB country-profile price, written out rather than read, exactly as
  // plan-choice-gate does: it is not a column on ProgrammeSettings and never has been, so a
  // clause that read it from the row would be reading `undefined` and comparing against NaN —
  // which is how the first draft of this gate reported eleven failures about its own arithmetic.
  const MONTHLY_P = 7500; // GB, lib/locale-profiles — a change there must be visible here
  const expectRenewal = s.renewal_annual_months_paid * MONTHLY_P;
  const expectOffer = s.offer_months_paid * MONTHLY_P;
  const equivOf = (yearPennies) => Math.round(yearPennies / s.months_given);
  const pounds = (p) => `£${Math.round(p / 100)}`;
  const poundsExact = (p) => (p % 100 === 0 ? `£${p / 100}` : `£${(p / 100).toFixed(2)}`);
  const biggest = Math.max(MONTHLY_P * s.months_given, expectRenewal);
  if (biggest >= 100000) declineToRun(`settings put a figure at ${pounds(biggest)}; this gate's oracle does not group thousands`);

  check('the offer figure DIFFERS from the renewal figure', expectOffer !== expectRenewal,
    'equal, and no clause below could tell a first-year price from a renewal price');
  check('the yearly monthly-equivalent DIFFERS from the monthly price', equivOf(expectRenewal) !== MONTHLY_P,
    'equal, and the headline clause could not tell the two plans apart');

  const text = (html) => html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
  const get = async (path) => {
    const r = await fetch(`${B}${path}`, { cache: 'no-store', headers: { 'cache-control': 'no-cache' } });
    const html = await r.text();
    return { status: r.status, html, text: text(html) };
  };

  // ── 1. THE RENDERED PAGE SHOWS BOTH PRICES, AND WHICH ONE IS SELECTED ─────────────────────
  console.log('\n— what a visitor sees on /pricing —');
  const pricing = await get('/pricing');
  check('/pricing serves', pricing.status === 200, `HTTP ${pricing.status}`);

  check('the YEARLY panel is the one rendered, not monthly',
    pricing.html.includes('data-testid="public-annual-billed"')
      && !pricing.html.includes('data-testid="public-monthly-billed"'),
    'the selection and the panel are one state — a panel for the unselected plan would be two');
  check('  …and the YEARLY toggle is the one pressed',
    /data-testid="public-toggle-annual"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*data-testid="public-toggle-annual"/.test(pricing.html)
      || /aria-pressed="true"[\s\S]{0,200}?Yearly/.test(pricing.html),
    'yearly by default — the toggle opens on the better price');
  check('  …and BOTH periods are offered', pricing.html.includes('data-testid="public-toggle-monthly"'),
    'a toggle with one option is not a choice');

  const headline = (/data-testid="public-headline"[^>]*>([^<]*)</.exec(pricing.html) ?? [])[1]?.trim();
  check('the headline is the yearly MONTHLY-EQUIVALENT, not the yearly price',
    headline === poundsExact(equivOf(expectRenewal)),
    `${headline} vs ${poundsExact(equivOf(expectRenewal))} (${pounds(expectRenewal)} ÷ ${s.months_given})`);
  check('  …and the yearly CHARGE is stated beneath it',
    pricing.text.includes(`Billed ${pounds(expectRenewal)} a year`),
    `expected "Billed ${pounds(expectRenewal)} a year" — an equivalence shown alone reads as the charge`);

  const saving = (/data-testid="public-saving"[^>]*>([^<]*)</.exec(pricing.html) ?? [])[1]?.trim();
  const wantSave = MONTHLY_P * s.months_given - expectRenewal;
  const wantPct = Math.round(((s.months_given - s.renewal_annual_months_paid) / s.months_given) * 100);
  check('  …and the saving is DERIVED, both ways',
    saving === `Save ${pounds(wantSave)} a year · Save ${wantPct}%`,
    `${saving} vs Save ${pounds(wantSave)} a year · Save ${wantPct}%`);

  // ── 2. NO REFERRAL OFFER TO A VISITOR WHO ARRIVED WITHOUT A CODE ──────────────────────────
  check('an unreferred visitor is quoted the RENEWAL price and no offer',
    !pricing.html.includes('data-testid="public-referral"')
      && !pricing.text.includes(`Billed ${pounds(expectOffer)}`),
    'an offer shown to someone not entitled to it is a price we would have to honour or withdraw');

  // ── 3. THE DATED TRIAL SENTENCE IS NOT ON A CACHED PAGE ───────────────────────────────────
  // trialSentence names a date computed from Date.now(). Frozen into an ISR render it is a dated
  // promise to a prospect that goes stale, so the public page must not carry it.
  check('the page carries NO trial-END DATE, which an ISR render would freeze',
    !/Your trial ends on/.test(pricing.text),
    'the public page states the trial LENGTH, a setting; the dated sentence belongs where "now" is the request');

  // ── 4. THE HOME PAGE AND /llms.txt NAME THE SAME TWO FIGURES ──────────────────────────────
  console.log('\n— and the other two public surfaces —');
  const home = await get('/');
  check('the home page names BOTH the monthly and the yearly price',
    home.text.includes(`${pounds(MONTHLY_P)} per site, per month`)
      && home.text.includes(`${pounds(expectRenewal)} a year`),
    `expected ${pounds(MONTHLY_P)} and ${pounds(expectRenewal)}`);
  const llms = await get('/llms.txt');
  check('/llms.txt names both, and the monthly equivalent',
    llms.text.includes(pounds(MONTHLY_P)) && llms.text.includes(pounds(expectRenewal))
      && llms.text.includes(poundsExact(equivOf(expectRenewal))),
    'the facts page is the one surface most likely to be quoted back at us');

  // ── 5. THE FIGURES MOVE WHEN THE SETTINGS MOVE ────────────────────────────────────────────
  // THE CLAUSE THE WHOLE TASK TURNS ON. A page showing £750 proves nothing about where £750 came
  // from: a typed literal passes it. So the setting is CHANGED and the three surfaces are read
  // again, and all of them must move together.
  console.log('\n— the figures follow the settings —');
  // ONE MONTH FEWER CHARGED, which moves the yearly price, its monthly equivalent and the saving
  // together. The monthly price is not a setting (see the header), so this is the knob an operator
  // actually has — and it is the one whose movement the public site could not previously show.
  const movedMonths = s.renewal_annual_months_paid - 1;
  if (movedMonths < 1) declineToRun(`renewal_annual_months_paid is ${s.renewal_annual_months_paid}; there is no smaller valid value to move it to`);
  await prisma.programmeSettings.update({ where: { id: 'singleton' }, data: { renewal_annual_months_paid: movedMonths } });
  gateWrote = movedMonths;
  const movedRenewal = movedMonths * MONTHLY_P;
  const movedSave = MONTHLY_P * s.months_given - movedRenewal;

  const pricing2 = await get('/pricing');
  const headline2 = (/data-testid="public-headline"[^>]*>([^<]*)</.exec(pricing2.html) ?? [])[1]?.trim();
  check('the /pricing headline moved with the setting',
    headline2 === poundsExact(equivOf(movedRenewal)) && headline2 !== headline,
    `${headline} → ${headline2}, expected ${poundsExact(equivOf(movedRenewal))}`);
  check('  …and so did the yearly charge and the saving',
    pricing2.text.includes(`Billed ${pounds(movedRenewal)} a year`)
      && pricing2.text.includes(`Save ${pounds(movedSave)} a year`),
    `expected "Billed ${pounds(movedRenewal)} a year" and "Save ${pounds(movedSave)} a year"`);
  const home2 = await get('/');
  check('  …and the home page\u2019s yearly figure', home2.text.includes(`${pounds(movedRenewal)} a year`),
    `expected ${pounds(movedRenewal)} a year`);
  const llms2 = await get('/llms.txt');
  check('  …and /llms.txt', llms2.text.includes(pounds(movedRenewal)),
    `expected ${pounds(movedRenewal)}`);
  // AND THE MONTHLY FIGURE DID NOT MOVE, which is the discriminator: it is a constant, not a
  // setting, so a clause that saw everything change would be a clause that cannot tell the two
  // apart — and would pass against a page that re-read some other number entirely.
  check('  …while the MONTHLY price stayed put, because it is not a setting',
    home2.text.includes(`${pounds(MONTHLY_P)} per site, per month`),
    `${pounds(MONTHLY_P)} is lib/locale-profiles, not the Engine Room`);

  await prisma.programmeSettings.update({ where: { id: 'singleton' }, data: { renewal_annual_months_paid: originalMonths } });
  gateWrote = null;

  // ── 6. THE REFERRED FIGURES ARE PRESENT AND CORRECT, AND NOT SHOWN UNASKED ────────────────
  // The referral panel is client-rendered (the page is cached and shared), so a server fetch
  // cannot press it. What IS checkable here is the resolver that produces the props, and that the
  // props carry the OFFER figures — a page whose referred set equalled its standard set would
  // show the toggle swap and no discount, and every clause above would still pass.
  console.log('\n— the referred case —');
  const refChoice = await PC.publicPlanChoice(prisma, { referred: true });
  const stdChoice = await PC.publicPlanChoice(prisma, { referred: false });
  check('a referred visitor is priced at the OFFER, an unreferred one at the renewal',
    refChoice.annual.totalPennies === expectOffer && stdChoice.annual.totalPennies === expectRenewal,
    `${refChoice.annual.totalPennies} / ${stdChoice.annual.totalPennies} vs ${expectOffer} / ${expectRenewal}`);
  check('  …and BOTH prices are offered to the referred one',
    refChoice.annual.offerApplies === true
      && refChoice.annual.renewalTotalPennies === expectRenewal,
    'a first-year price shown alone is a mis-sale — the garage would learn the real figure from its second invoice');
  check('  …and the public line names the CODE and the months, never the affiliate',
    PC.publicReferralSentence('TESTAFF', refChoice.annual.monthsGiven, refChoice.annual.monthsPaid)
      === `Referral code TESTAFF: your first year is ${s.months_given} months for the price of ${s.offer_months_paid}.`,
    PC.publicReferralSentence('TESTAFF', refChoice.annual.monthsGiven, refChoice.annual.monthsPaid));
  check('  …and the resolver refuses to carry a name onto a public page',
    refChoice.annual.offerReason !== null && !/from /.test(refChoice.annual.offerReason),
    `${refChoice.annual.offerReason} — naming the affiliate here publishes the list to anyone who guesses a code`);

  // AN INVALID CODE GETS THE NORMAL PRICES, and that is decided by check-code, not by the page.
  const bad = await fetch(`${B}/api/affiliate/check-code`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'ZZNOSUCHCODE' }),
  }).then((r) => r.json()).catch(() => null);
  check('an unknown code is answered NO, so the page falls back to the normal prices',
    bad?.ok === false, JSON.stringify(bad));
  check('  …and the answer carries no name, type or anything else about an affiliate',
    bad && Object.keys(bad).every((k) => ['ok', 'reason', 'message'].includes(k)),
    `keys: ${bad ? Object.keys(bad).join(',') : 'none'} — this endpoint is now called by every public visitor with a ?ref=`);

  // THE NORMALISER, which decides what may be echoed back to a visitor at all.
  check('the code normaliser refuses anything that is not a code',
    PC.normaliseRefCode('testaff') === 'TESTAFF'
      && PC.normaliseRefCode('<script>') === null
      && PC.normaliseRefCode('A'.repeat(64)) === null
      && PC.normaliseRefCode('') === null,
    'the page echoes this string back to the visitor — an arbitrary query string is somebody else’s sentence in our voice');

  // ── 6b. THE RATE LIMIT, AND WHAT IT MUST NOT DO (owner, 2026-10-29) ──────────────────────
  // This endpoint went from "called by the signup form on field blur" to "called by every public
  // visitor arriving with a ?ref=" the moment /pricing started quoting the offer. The limit guards
  // LOAD, not secrecy — the answer carries no name, so a sweep learns which codes exist and
  // nothing about who owns them (asserted above).
  //
  // THE CLAUSE THAT MATTERS IS THE SILENT ONE. A limiter is easy to prove restrictive and hard to
  // prove harmless, and the harm here is INVISIBLE: a referred garage behind an office or carrier
  // NAT shown the standard prices has no way to tell that anything was withheld, and the affiliate
  // loses the commission. So normal traffic is measured first, at its real shape.
  console.log('\n— the rate limit on check-code —');
  const ARL = await import(`${R}/lib/auth-rate-limit.ts`);
  const LIM = ARL.REF_CODE_LIMITS.perIp;

  // THIS GATE'S OWN KEY, and it is swept before and after. The runner's loopback reaper matches any
  // key ending in a loopback address, so refcode:ip:::1 is cleared with the rest — but this gate
  // must not inherit a budget already spent by an earlier run in the same hour, which would make
  // the "stays silent" clause fail for a reason that has nothing to do with the code.
  const clearLimiter = async () => {
    const r = await prisma.authRateLimit.deleteMany({ where: { key: { startsWith: 'refcode:ip:' } } });
    return r.count;
  };
  await clearLimiter();
  onTeardown(clearLimiter);

  const ask = async (code) => {
    const r = await fetch(`${B}/api/affiliate/check-code`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  };

  check('the limit is its OWN key, not shared with magic:ip or repauth:ip',
    ARL.refCodeIpKey('1.2.3.4') === 'refcode:ip:1.2.3.4'
      && ARL.refCodeIpKey('x') !== ARL.smsIpKey('x'),
    `${ARL.refCodeIpKey('1.2.3.4')} — a shared key means one caller silently spends another's budget`);
  // THE REAPER REALLY TAKES ITS ROWS. This was an arithmetic clause —
  // `RATE_LIMIT_RETENTION_MINUTES >= 2 × the window` — and a red-proof removing REF_CODE_LIMITS
  // from that Math.max left it GREEN, because the SMS tenant window is 24 hours and already
  // dominates the figure. It found decoration: the number it checked cannot move when this window
  // is excluded. So the clause is the behaviour instead, which is what the retention is FOR —
  // refcode:ip holds a visitor's address in clear, and this is what bounds how long we hold it.
  const stale = new Date(Date.now() - (ARL.RATE_LIMIT_RETENTION_MINUTES + 60) * 60 * 1000);
  const planted = await prisma.authRateLimit.create({ data: { key: 'refcode:ip:198.51.100.7', created_at: stale }, select: { id: true } });
  // This reaps EVERY expired row, not only the planted one — that is the function's job and what
  // the nightly cron already does. Rows it takes are expired by definition and can affect no
  // limit decision.
  await ARL.reapRateLimits();
  const survived = await prisma.authRateLimit.findUnique({ where: { id: planted.id }, select: { id: true } });
  check('  …and an expired refcode row is REAPED, address and all',
    survived === null,
    `planted at ${stale.toISOString()}, retention ${ARL.RATE_LIMIT_RETENTION_MINUTES} minutes — ipKey stores the address in clear, so this is the bound on holding it`);

  // A NORMAL SIGNUP: the field blurs a few times while somebody types and corrects a code, plus
  // the page load that arrived with it. Measured at the shape a person actually produces.
  const NORMAL = 6;
  const normal = [];
  for (let i = 0; i < NORMAL; i += 1) normal.push(await ask('ZZNOSUCHCODE'));
  check(`a normal visitor and a normal signup (${NORMAL} calls) are never rate-limited`,
    normal.every((r) => r.json?.reason !== 'rate_limited'),
    normal.map((r) => r.json?.reason).join(',') || 'no answers');
  check('  …and each still gets a real verdict about the code',
    normal.every((r) => r.json?.ok === false && r.json?.reason === 'unknown_code'),
    'silent means answering the question, not answering nothing');

  // AND THE HEADROOM IS REAL, not "six is under sixty". The limit must be far enough above normal
  // traffic that a shared address does not reach it: a tight limit here is the invisible failure.
  check('  …with the limit an order of magnitude above that',
    LIM.max >= NORMAL * 10, `${LIM.max} per ${LIM.windowMinutes} minutes against ${NORMAL} for a real signup`);

  // A BURST IS REFUSED. Spend the rest of the window's budget, then prove the next call is the
  // standard-prices answer and NOT the wrong-code wording.
  const burst = [];
  for (let i = normal.length; i < LIM.max + 2; i += 1) burst.push(await ask('ZZNOSUCHCODE'));
  const limited = burst.filter((r) => r.json?.reason === 'rate_limited');
  check('a burst past the limit IS refused', limited.length >= 2,
    `${limited.length} of ${burst.length} refused after ${LIM.max} in the window`);
  check('  …answering ok:false, so the pricing page shows the standard prices',
    limited.every((r) => r.status === 200 && r.json?.ok === false),
    limited.map((r) => `${r.status} ok=${r.json?.ok}`).slice(0, 3).join('; '));
  check('  …and carrying NO message, so no person is told a valid code is wrong',
    limited.every((r) => r.json?.message === null),
    `${JSON.stringify(limited[0]?.json)} — the signup form shows message to a human; the unknown-code wording would make them delete a code that was right`);
  check('  …and it is distinguishable from an unknown code in the REASON',
    limited.every((r) => r.json?.reason === 'rate_limited')
      && normal.every((r) => r.json?.reason === 'unknown_code'),
    'the page treats both as "no offer"; the two must still be tellable apart in a log');

  // A VALID code is refused too while the window is spent — stated because it is the cost of the
  // design, not an oversight. The signup path resolves the code itself and is unaffected: this
  // endpoint has never gated attribution.
  const validWhileLimited = await ask('TESTAFF');
  check('  …and a VALID code gets the same answer while the window is spent',
    validWhileLimited.json?.reason === 'rate_limited',
    'this is the cost of a per-IP axis, and the reason the limit is generous');

  await clearLimiter();
  const afterClear = await ask('ZZNOSUCHCODE');
  check('  …and the window RECOVERS, rather than locking the address out',
    afterClear.json?.reason === 'unknown_code', JSON.stringify(afterClear.json));

  // ── 6c. NO "FREE", AND THE DATES AND AMOUNTS DERIVED (owner ruling, 2026-10-29) ──────────
  // "Start your 30-day free trial" is a true sentence that sets a false expectation: a card is
  // taken at signup and charged on day 30. A garage that read "free" and then saw £75 leave its
  // account was told the truth and still surprised, which is what the dashboard banner's own
  // ruling forbids.
  //
  // THE SCAN IS OVER THE RENDERED TEXT, not the source. A source scan would pass against copy
  // that reaches a visitor through a component it did not think to read, and would go red over
  // the comments that explain WHY the word is gone.
  console.log('\n— no "free" in our wording —');
  const FREE = /\bfree trial\b|\bdays? free\b|\bfree for \d/i;
  const surfaces = [
    ['/pricing', pricing.text],
    ['/', home.text],
    ['/llms.txt', llms.text],
    ['/register', (await get('/register')).text],
  ];
  for (const [name, t] of surfaces) {
    check(`${name} does not call the trial FREE`, !FREE.test(t),
      (FREE.exec(t) ?? ['—'])[0]);
  }
  // THE DISCRIMINATOR: the scan must be able to find the phrase. Without this, a regex that
  // matches nothing anywhere passes on every surface and proves nothing.
  check('  …and the scan would have found it — it matches the phrase it forbids',
    FREE.test('Start your 30-day free trial') && FREE.test('30 days free') && !FREE.test('30-day trial'),
    'otherwise every clause above passes against a regex that matches nothing');

  // AND THE REPLACEMENT SAYS WHAT HAPPENS. Absence of a word is not presence of a promise.
  //
  // THE SENTENCES ARE WRITTEN OUT HERE, not read from lib/trial-wording. The first draft asserted
  // `pricing.text.includes(TW.trialUndated(s.trial_days))` and a red-proof that TYPED a 30 into
  // that function left it green: the clause compared the page against the module that rendered it
  // and agreed with itself. The NUMBER still comes from the settings row, so the length is derived
  // and only the WORDS are pinned — which is what should happen to copy this deliberate: changing
  // it goes red and a person decides.
  const TW = await import(`${R}/lib/trial-wording.ts`);
  const wantUndated = `${s.trial_days}-day trial, nothing to pay for the first ${s.trial_days} days`;
  const wantCta = `Start your ${s.trial_days}-day trial`;
  check('/pricing states the dateless promise, with the length from the setting',
    pricing.text.includes(wantUndated), `expected "${wantUndated}"`);
  check('  …and the call to action names the length and not the word',
    pricing.text.includes(wantCta) && !FREE.test(wantCta), `expected "${wantCta}"`);
  check('  …and lib/trial-wording is what the page got them from',
    TW.trialUndated(s.trial_days) === wantUndated && TW.trialCta(s.trial_days) === wantCta,
    `${TW.trialUndated(s.trial_days)} / ${TW.trialCta(s.trial_days)} — one module, so eleven surfaces cannot drift`);
  check('/llms.txt says nothing is paid for the first N days, from the same setting',
    llms.text.includes(`${s.trial_days}-day trial on either plan`)
      && llms.text.includes(`nothing to pay for the first ${s.trial_days} days`),
    `trial_days is ${s.trial_days}`);

  // THE DATED FORMS, which are what a garage with a trial sees. Asserted as pure functions here —
  // the screens that render them are driven by plan-choice-gate — and the point is that the DATE
  // and the LENGTH both come from arguments, so neither can be typed into a page.
  const when = new Date('2027-03-04T00:00:00Z');
  const prof = (await import(`${R}/lib/locale-profiles.ts`)).getProfile('GB');
  check('the dated promise names the length AND the date, both passed in',
    TW.trialDated(30, when, prof) === 'Try GreaseDesk for 30 days. Nothing to pay until 4 March 2027.',
    TW.trialDated(30, when, prof));
  check('  …and the first-payment form names the date and the way out',
    TW.firstPaymentDated(30, when, prof)
      === '30-day trial: your first payment is on 4 March 2027; cancel before then and you pay nothing.',
    TW.firstPaymentDated(30, when, prof));
  check('  …and moving the setting moves the sentence',
    TW.trialDated(45, when, prof).includes('45 days') && !TW.trialDated(45, when, prof).includes('30'),
    TW.trialDated(45, when, prof));

  // ── 6d. WHAT STRIPE CHECKOUT SHOWS NEXT TO THE BUTTON ────────────────────────────────────
  // Stripe's own "30 days free" headline comes from trial_period_days and has no parameter; this
  // is the one place on their page where our words appear, so it carries the plain version of the
  // same fact. Every figure is PASSED IN, already formatted — the module holds no price.
  console.log('\n— the checkout wording —');
  const yearly = TW.checkoutCustomText({
    plan: 'annual', days: s.trial_days, endsAt: when, profile: prof,
    firstChargeLabel: pounds(expectOffer), renewalLabel: pounds(expectRenewal),
  });
  check('the yearly message names the trial, the first year and the RENEWAL',
    yearly === `Nothing to pay for ${s.trial_days} days. Then ${pounds(expectOffer)} for your first year, renewing at ${pounds(expectRenewal)} a year. Cancel before 4 March 2027 and you pay nothing.`,
    yearly);
  check('  …and with no offer it names ONE figure rather than repeating it',
    TW.checkoutCustomText({ plan: 'annual', days: s.trial_days, endsAt: when, profile: prof,
      firstChargeLabel: pounds(expectRenewal), renewalLabel: pounds(expectRenewal) })
      === `Nothing to pay for ${s.trial_days} days. Then ${pounds(expectRenewal)} a year. Cancel before 4 March 2027 and you pay nothing.`,
    'a garage paying the list price should not read "then £750, renewing at £750"');
  const monthly = TW.checkoutCustomText({
    plan: 'monthly', days: s.trial_days, endsAt: when, profile: prof,
    firstChargeLabel: pounds(MONTHLY_P), renewalLabel: null,
  });
  check('  …and the monthly message names the month price and the date',
    monthly === `Nothing to pay for ${s.trial_days} days. Then ${pounds(MONTHLY_P)} a month. Cancel before 4 March 2027 and you pay nothing.`,
    monthly);
  check('  …and neither says "free"', !FREE.test(yearly) && !FREE.test(monthly),
    'Stripe\u2019s own headline above the card form is theirs and cannot be changed; ours must not read as a contradiction');
  check('  …and both fit Stripe\u2019s 1200-character cap on custom_text',
    yearly.length <= 1200 && monthly.length <= 1200, `${yearly.length} / ${monthly.length}`);

  // ── AND THE DATE IS TODAY PLUS THE SETTING, NOT A DATE ANYBODY PASSED IN ─────────────────
  // THE GAP THIS CLOSES, found by the owner reading the clauses above rather than the code. Every
  // checkout clause so far hands `endsAt` in as a fixture (4 March 2027), so all of them would
  // pass against a handler that passed the wrong date — or a constant. The message is only true if
  // the date is the one the subscription will really be created with: now + trial_days.
  //
  // RESOLVED THE WAY THE HANDLER RESOLVES IT. publicPlanChoice and planChoiceFor share buildChoice,
  // which computes the trial end from the clock when the caller passes none — and checkout.ts
  // passes none, because there is no subscription yet. So this reads the same field the handler
  // reads and checks it against an independently computed date.
  const liveChoice = await PC.publicPlanChoice(prisma, { referred: false });
  const resolvedEnd = new Date(liveChoice.trialEndsAt);
  const expectedEnd = new Date(Date.now() + s.trial_days * 86400000);
  // A MINUTE OF SLACK, because the two were computed a few statements apart and not because the
  // date is approximate: anything beyond a minute means it was not derived from this clock.
  check('the trial end a checkout would use is NOW plus the trial setting',
    Math.abs(resolvedEnd.getTime() - expectedEnd.getTime()) < 60_000,
    `${resolvedEnd.toISOString()} vs ${expectedEnd.toISOString()} (${s.trial_days} days)`);

  const liveMsg = TW.checkoutCustomText({
    plan: 'monthly', days: liveChoice.trialDays, endsAt: resolvedEnd, profile: prof,
    firstChargeLabel: liveChoice.monthly.totalLabel, renewalLabel: null,
  });
  // THE DATE AS A GARAGE WOULD READ IT, formatted by this gate rather than by the module, so the
  // clause does not agree with the thing it is checking.
  const expectedLabel = expectedEnd.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  check('  …so the message a real checkout shows names THAT date',
    liveMsg.includes(`Cancel before ${expectedLabel} and you pay nothing.`),
    `${liveMsg} — expected ${expectedLabel}`);
  check('  …and the amount beside it is the live monthly price, not a fixture',
    liveMsg.includes(`Then ${pounds(MONTHLY_P)} a month`), liveMsg);

  // THE COUPON NAME, derived from the amount and formatted through the money chokepoint.
  const BPg = await import(`${R}/lib/billing-plans.ts`);
  const spec = BPg.firstYearCouponSpec(expectRenewal - expectOffer, 'gbp');
  check('a new first-year coupon is NAMED for what it is, with the amount',
    spec.name === `Referral offer: first year ${pounds(expectRenewal - expectOffer)} off`,
    String(spec.name));
  check('  …and its id is unchanged, so existing coupons keep theirs',
    spec.id === `gd-first-year-${expectRenewal - expectOffer}-gbp`,
    `${spec.id} — live subscriptions point at this; ensureFirstYearCoupon only ever CREATES a missing one`);
  check('  …and pence appear only when there are pence',
    String(BPg.firstYearCouponSpec(12345, 'gbp').name).endsWith('\u00a3123.45 off')
      && String(BPg.firstYearCouponSpec(15000, 'gbp').name).endsWith('\u00a3150 off'),
    `${BPg.firstYearCouponSpec(12345, 'gbp').name} / ${BPg.firstYearCouponSpec(15000, 'gbp').name}`);

  // ── 7. SAVING THE SETTINGS REFRESHES THE PUBLIC COPY, AND READS IT BACK ───────────────────
  console.log('\n— revalidation on save —');
  // THE EXTRACTOR IS THE ORACLE for every verification clause, so it is proved on planted cases
  // first — including the one that matters, React's SSR markers splitting a figure out of its run.
  check('the yearly-price extractor reads through React’s SSR comment markers',
    PS.renderedYearlyPrice('<p>Billed <!-- -->£750<!-- --> a year, per site.</p>') === '£750',
    'an extractor that cannot would report "no price" about a page plainly showing one');
  check('  …and ignores figures that are only in __NEXT_DATA__',
    PS.renderedYearlyPrice('<script id="__NEXT_DATA__">{"x":"£999 a year"}</script><p>Billed £750 a year</p>') === '£750',
    'the referred figure set is in the props and is never rendered — a raw grep would find a price no visitor sees');
  check('  …and answers NULL when a page names two different ones',
    PS.renderedYearlyPrice('<p>£750 a year</p><p>£600 a year</p>') === null,
    'two answers is not an answer');

  const asked = [];
  const saved = await PS.savePlanSettings(prisma, {
    changes: { renewal_annual_months_paid: originalMonths - 1 },
    actorId: null,
    revalidate: async (p) => { asked.push(p); },
    origin: B,
  });
  gateWrote = originalMonths - 1;
  check('the save asks to revalidate the PRERENDERED ROUTE KEYS, locale-prefixed',
    asked.length > 0 && asked.every((p) => /^\/[a-z]{2}-[A-Z]{2}(\/|$)/.test(p))
      && asked.some((p) => p.endsWith('/pricing')),
    `${asked.join(', ')} — revalidating "/pricing" addresses a page that is not the one in the cache`);
  check('  …and NOT /llms.txt, which is server-rendered and has no cache to invalidate',
    !asked.some((p) => p.includes('llms')),
    'handing res.revalidate() a path that was never prerendered throws, and the save would report a failure that is not one');
  check('  …and it READ THE PAGES BACK rather than trusting the refresher',
    saved.checks.length === asked.length / Math.max(1, asked.length / 2) || saved.checks.length > 0,
    `${saved.checks.length} page(s) read: ${saved.checks.map((c) => `${c.url.replace(/^https?:\/\//, '')} shows ${c.shows ?? 'nothing'}`).join('; ')}`);
  check('  …and it VERIFIES, because the dev server really is showing the new price',
    saved.verified === true && saved.checks.every((c) => c.agrees),
    `verified ${saved.verified}; ${saved.checks.map((c) => `${c.url} → ${c.shows}`).join('; ')}`);

  // THE DANGEROUS CASE, and the one that used to be indistinguishable from success: the refresh
  // resolves and the page does not move. A revalidate that does nothing must come back NOT
  // verified — this is the 2026-10-25 failure, reproduced on purpose.
  const noop = await PS.savePlanSettings(prisma, {
    changes: { renewal_annual_months_paid: originalMonths - 2 },
    actorId: null,
    revalidate: async (p) => p,
    origin: 'http://127.0.0.1:1',   // nothing answers here, so the read-back cannot agree
  });
  gateWrote = originalMonths - 2;
  check('a refresh that resolves while the page does NOT agree is reported as unverified',
    noop.verified === false && noop.note != null && noop.revalidateError == null,
    `verified ${noop.verified}, note ${noop.note}`);

  const threw = await PS.savePlanSettings(prisma, {
    changes: { renewal_annual_months_paid: originalMonths - 3 },
    actorId: null,
    revalidate: async () => { throw new Error('nope'); },
    origin: B,
  });
  gateWrote = originalMonths - 3;
  // THE ERROR ONLY, and not `verified === false` beside it. In dev getStaticProps runs on every
  // request, so the page agrees whether or not the refresh happened — asserting it disagreed would
  // be asserting something dev cannot produce. Measured: this clause went red for exactly that
  // reason, and the red was about the gate, not the code.
  check('  …and a THROWN revalidation is REPORTED, not swallowed',
    threw.revalidateError != null, threw.revalidateError ?? 'swallowed');

  // A SAVE THAT CHANGES NOTHING REFRESHES NOTHING. Reporting "not verified" for a no-op would
  // teach the operator to ignore the line, which is the whole value of the line.
  const same = await PS.savePlanSettings(prisma, {
    changes: { renewal_annual_months_paid: originalMonths - 3 },
    actorId: null,
    revalidate: async (p) => { asked.push(`SHOULD-NOT-HAPPEN:${p}`); },
    origin: B,
  });
  check('a save that moves nothing asks for no refresh at all',
    Object.keys(same.changed).length === 0 && same.attempted.length === 0
      && !asked.some((p) => p.startsWith('SHOULD-NOT-HAPPEN')),
    `changed ${JSON.stringify(same.changed)}, attempted ${same.attempted.length}`);

  await prisma.programmeSettings.update({ where: { id: 'singleton' }, data: { renewal_annual_months_paid: originalMonths } });
  gateWrote = null;
} catch (e) {
  check('the gate ran to the end', false, describeError(e));
} finally {
  await prisma?.$disconnect().catch(() => {});
}

const failures = out.filter((x) => x === 'F').length;
console.log(`\n${out.length} checks, ${failures} failures`);
process.exit(failures ? 1 : 0);
