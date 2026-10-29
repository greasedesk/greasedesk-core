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
