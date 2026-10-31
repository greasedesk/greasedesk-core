/**
 * File: scripts/affiliate-site-gate.mjs
 * THE PUBLIC AFFILIATE SITE: its own host, its own boundary, its own figures — and the switch.
 * @gate-requires: server, db
 *
 * affiliates.greasedesk.com is the THIRD public host (after the apex and reps.), and the mistakes
 * available here are the ones the reseller site already paid for once each:
 *
 *   1. THE BOUNDARY. One named prefix, /affiliate-site, is the whole allow-list addition — so the
 *      clause that matters is not "the prefix works" but "NOTHING OUTSIDE IT IS REACHABLE", and
 *      /public is what proves that. There is a second half here that reps. did not have:
 *      /api/affiliate/check-code is a PUBLIC APEX endpoint, and the obvious copy of the reseller
 *      rules would have closed it on the apex and silently broken the referral prefill on /register.
 *      That is asserted from both sides.
 *   2. THE CANONICAL. A second public host whose pages canonicalise to the apex tells a crawler the
 *      whole site duplicates URLs that 404 on it. Nothing in a page's appearance shows that.
 *   3. THE ADDRESS OF /terms. Shipped inside the namespace on reps., which 404'd the obvious URL in
 *      production for a day. Here it is a rewrite from day one, and this proves it.
 *
 * ── AND THE THING THIS SLICE IS REALLY FOR ──────────────────────────────────────────────────────
 * Every figure on the page comes from ProgrammeSettings, and the page is SERVER-RENDERED so the
 * joining switch takes effect on the next request. Both halves are asserted by MOVING THE SETTING
 * and reading the rendered HTML back: the reward, the cap, how many paid months the cap is worth and
 * the garage's offer all follow the row, and with joining shut the join button is REPLACED by the
 * waiting-list form rather than merely hidden.
 *
 * ── ON ITS OWN SETTINGS ROW ─────────────────────────────────────────────────────────────────────
 * It cannot be. The page reads the SINGLETON — a public page must not take a row from a query
 * parameter, and it does not — so this gate changes the singleton, records what it found first, and
 * puts it back in a registered teardown. That is the one way to drive a public page's figures, and
 * it is why the restore is registered rather than written at the end of the happy path.
 */
import './_gate-preflight.mjs';
import './_ts.mjs';
const { gatePrisma, describeError, gateOrigin, affiliateOrigin, repOrigin, erOrigin, ER_RESOLVER_ARGS, serverReady, onTeardown } = await import('./_gate-preflight.mjs');
const { readFileSync } = await import('node:fs');
const http = await import('node:http');
const { AFFILIATE_SITE_URL } = await import('../lib/company-info.ts');
const { underPath } = await import('../lib/anchored-match.ts');
const ROBOTS = await import('../lib/robots-rules.ts');
const PUB = await import('../lib/affiliate-public.ts');
const WAIT = await import('../lib/affiliate-waitlist.ts');
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');
const bcrypt = (await import('/Users/hugh/Developer/greasedesk-core/node_modules/bcryptjs/index.js')).default;

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const B = new URL(gateOrigin());
const AFF_HOST = new URL(affiliateOrigin()).hostname;
const REP_HOST = new URL(repOrigin()).hostname;
const ER_HOST = new URL(erOrigin()).hostname;
const APEX = B.hostname;

/** One request, one Host header, no redirect following — a redirect is the answer, not a detour. */
const ask = (host, path, { method = 'GET', body, xff } = {}) => new Promise((resolve) => {
  const headers = { Host: `${host}:${B.port}` };
  // A FORWARDED IP OF OUR OWN. The limiter keys on x-forwarded-for and falls back to the literal
  // 'unknown', which every anonymous caller shares — so a burst clause without this would spend a
  // budget a real visitor and the next gate also draw on. TEST-NET-3 (RFC 5737), which is
  // documentation-only and can never be a real client.
  if (xff) headers['x-forwarded-for'] = xff;
  if (body) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(body); }
  const r = http.request({ hostname: B.hostname, port: B.port, path, method, headers }, (res) => {
    let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: b, headers: res.headers }));
  });
  r.on('error', (e) => resolve({ status: 0, body: String(e), headers: {} }));
  if (body) r.write(body);
  r.end();
});

const canon = (html) => (html.match(/<link rel="canonical" href="([^"]+)"/) ?? [])[1] ?? '';
const ogImage = (html) => (html.match(/<meta property="og:image" content="([^"]+)"/) ?? [])[1] ?? '';
/** The visible text of the rendered page, so a clause about COPY is about what a person reads. */
const text = (html) => html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/&pound;/g, '£').replace(/\s+/g, ' ');

let prisma, browser;
/** Every address this gate leaves ends with this, so the sweep can find them by shape. */
const MARK = '@zz-affiliate-site.invalid';
/** Our own forwarded IP, so the limiter budget we spend is nobody else's. */
const GATE_IP = '203.0.113.7';
const OP_EMAIL = 'zzas-affiliate-site-gate@greasedesk.test';
const OP_PASS = 'GateAffiliateSite!2026';
/** What the singleton held before this gate touched it — restored in teardown, whatever happens. */
let before = null;
const restore = async () => {
  if (!prisma) return 0;
  // EVERY FIXTURE, in one registered function. The waiting-list rows, the limiter tokens this gate
  // spent, the operator it signed in as, and the settings row it moved — a teardown that restored
  // only the settings would leave the next run colliding on a unique email.
  await prisma.affiliateWaitlist.deleteMany({ where: { email: { endsWith: MARK } } }).catch(() => {});
  await prisma.authRateLimit.deleteMany({ where: { key: { startsWith: `waitlist:ip:${GATE_IP}` } } }).catch(() => {});
  await prisma.operator.deleteMany({ where: { email: OP_EMAIL } }).catch(() => {});
  if (!before) return 0;
  await prisma.programmeSettings.update({ where: { id: 'singleton' }, data: before });
  return 1;
};

try {
  prisma = await gatePrisma();
  onTeardown(restore);

  const ready = await serverReady();
  check('the dev server serves pages before we drive it', ready.ok, `HTTP ${ready.status} after ${ready.attempts} attempt(s)`);

  before = await prisma.programmeSettings.findUnique({
    where: { id: 'singleton' },
    select: { affiliate_joining_open: true, total_reward_pennies: true, instalment_pennies: true, offer_months_paid: true, months_given: true },
  });
  check('the live settings row exists to read figures from', !!before, JSON.stringify(before));

  // ── 1. THE HOST SERVES THE PUBLIC PAGE AT ITS ROOT ───────────────────────────────────────────
  console.log('\n— the bare domain is the public affiliate page —');
  const root = await ask(AFF_HOST, '/');
  check('the bare domain answers 200', root.status === 200, `HTTP ${root.status}`);
  check('  …with the affiliate page, not the garage site', /data-testid="terms-card"/.test(root.body) && !/data-testid="plan-chooser"/.test(root.body),
    'the terms card is the marker: it exists on no other page');
  check('  …and it is indexable: no noindex on it', !/name="robots" content="noindex"/.test(root.body));

  // ── 2. THE BOUNDARY ──────────────────────────────────────────────────────────────────────────
  console.log('\n— nothing outside the prefix is reachable on this host —');
  for (const [path, want, what] of [
    ['/affiliate-site', 308, 'the old internal prefix, permanently redirected (see section 4b)'],
    ['/terms', 200, 'the terms page at the address a person types'],
    ['/robots.txt', 200, 'this host’s own robots'],
    ['/sitemap.xml', 200, 'this host’s own sitemap'],
    ['/greasedesk-Logo.png', 200, 'the one brand asset'],
  ]) check(`${what} is served`, (await ask(AFF_HOST, path)).status === want, `${path} → want ${want}`);

  // /public OUTSIDE the prefix is the proof that the boundary is a boundary.
  const outside = ['/favicon-32.png', '/og.png', '/rep-site/og.png'];
  const outsideCodes = [];
  for (const p of outside) outsideCodes.push(`${p}:${(await ask(AFF_HOST, p)).status}`);
  check('a /public file OUTSIDE the prefix is NOT reachable', outsideCodes.every((c) => c.endsWith(':404')), outsideCodes.join(' '));

  for (const [path, what] of [
    ['/pricing', 'the garage marketing site'],
    ['/admin/login', 'the tenant app'],
    ['/superadmin', 'the Engine Room'],
    ['/rep-site', 'the reseller site'],
    ['/rep/login', 'the reseller portal'],
  ]) check(`${what} 404s here`, (await ask(AFF_HOST, path)).status === 404, path);

  // ── 3. AND THE AFFILIATE SITE IS CLOSED EVERYWHERE ELSE ──────────────────────────────────────
  console.log('\n— and this site exists on no other host —');
  for (const [host, label] of [[APEX, 'the apex'], [REP_HOST, 'reps.'], [ER_HOST, 'er.']]) {
    for (const path of ['/affiliate-site', '/api/affiliate-site/waitlist']) {
      check(`${path} 404s on ${label}`, (await ask(host, path)).status === 404);
    }
  }
  check('  …and that probe can reach a live page', (await ask(APEX, '/pricing')).status === 200,
    'otherwise every 404 above is a dead server rather than a closed door');

  // ── 4. THE APEX ENDPOINT THE OBVIOUS COPY WOULD HAVE BROKEN ──────────────────────────────────
  // /api/affiliate/check-code is PUBLIC and lives on the APEX: /register and /pricing call it to
  // turn a ?ref= into the offer line. isAffiliateSite deliberately does not match it.
  console.log('\n— the public ref-code endpoint is untouched on the apex —');
  // A GET, AND 405 IS THE RIGHT ANSWER. The endpoint is POST-only, so 405 is the handler speaking —
  // which is the whole question here: middleware let the request through. 404 would mean the apex had
  // closed it and the referral prefill on /register was broken.
  //
  // NOT A POST, deliberately: a real call spends one of refcode:ip's 60 tokens an hour, and
  // public-pricing-gate spends that window in full on purpose to prove a burst is refused. A clause
  // here that quietly took a token from it would make ITS reds depend on the order the suite ran in.
  const codeOnApex = await ask(APEX, '/api/affiliate/check-code');
  check('check-code is still REACHED on the apex — 405 from the handler, not 404 from middleware',
    codeOnApex.status === 405, `HTTP ${codeOnApex.status} — the referral prefill on /register depends on this`);
  check('  …and it is NOT exposed on the affiliate host', (await ask(AFF_HOST, '/api/affiliate/check-code')).status === 404,
    'one door per surface: this host serves /api/affiliate-site, not /api/affiliate');

  // ── 4b. THE PUBLIC ADDRESSES ARE BARE, AND THE OLD ONES STILL WORK ───────────────────────────
  // /affiliate-site is an internal folder name that was leaking into addresses people type, print
  // on a card and receive in a confirmation email. The bare forms are now the real ones.
  //
  // THE OLD FORMS MUST KEEP WORKING, and that half matters more: a confirmation link lives a
  // fortnight and is single-use, so a 404 would strand an affiliate with a code and no way to prove
  // their address. Both halves are asserted; neither on its own is the claim.
  console.log('\n— the public addresses are bare —');
  const TOK = 'zzgate0000000000000000000000tok';
  const joinBare = await ask(AFF_HOST, '/join');
  // NOT the join FORM: this runs before section 8 toggles joining, and with joining shut the page
  // shows a waiting list instead. What is true either way is that the address is served and that
  // the page names ITSELF by the bare address — a canonical pointing back at /affiliate-site/join
  // would have told crawlers the internal name was the real one, surviving the redirect silently.
  check('/join serves the join page on this host',
    joinBare.status === 200 && canon(joinBare.body) === `${AFFILIATE_SITE_URL}/join`,
    `HTTP ${joinBare.status}, canonical ${canon(joinBare.body)}`);
  const confirmBare = await ask(AFF_HOST, `/confirm-email/${TOK}`);
  check('/confirm-email/<token> is REACHED, not 404ed by middleware',
    confirmBare.status !== 404, `HTTP ${confirmBare.status} — the page decides about a bad token, middleware must not`);
  check('  …and names itself by the bare address, with the token NOT in the canonical',
    canon(confirmBare.body) === `${AFFILIATE_SITE_URL}/confirm-email` && !canon(confirmBare.body).includes(TOK),
    canon(confirmBare.body));

  const oldJoin = await ask(AFF_HOST, '/affiliate-site/join');
  check('the old /affiliate-site/join redirects PERMANENTLY to /join',
    oldJoin.status === 308 && new URL(oldJoin.headers.location, 'http://x').pathname === '/join',
    `HTTP ${oldJoin.status} → ${oldJoin.headers.location}`);
  const oldConfirm = await ask(AFF_HOST, `/affiliate-site/confirm-email/${TOK}`);
  check('  …and so does a confirmation link already sitting in somebody\'s inbox',
    oldConfirm.status === 308 && new URL(oldConfirm.headers.location, 'http://x').pathname === `/confirm-email/${TOK}`,
    `HTTP ${oldConfirm.status} → ${oldConfirm.headers.location}`);
  check('  …carrying the token through unchanged, because it is the credential',
    String(oldConfirm.headers.location ?? '').includes(TOK), oldConfirm.headers.location);
  // 308 AND NOT 301: a 301 may turn a later POST into a GET, which is a bug nobody finds for months.
  check('  …as a 308, which preserves the method', oldConfirm.status === 308, `HTTP ${oldConfirm.status}`);
  const oldWithQuery = await ask(AFF_HOST, '/affiliate-site/join?ref=ZZAL9999');
  check('  …and the query survives the redirect, or a ?ref= is silently dropped',
    String(oldWithQuery.headers.location ?? '').includes('ref=ZZAL9999'), oldWithQuery.headers.location);
  const oldRoot = await ask(AFF_HOST, '/affiliate-site');
  check('  …and the bare prefix lands on the root, not on an empty path',
    oldRoot.status === 308 && new URL(oldRoot.headers.location, 'http://x').pathname === '/',
    `HTTP ${oldRoot.status} → ${oldRoot.headers.location}`);
  // NOT THE API. underPath anchors on a segment boundary; redirecting /api/affiliate-site would
  // break the pages' own fetches, and the symptom would be a form that silently does nothing.
  // A REAL ROUTE, and asserted as REACHED rather than merely "not 308". The first version asked a
  // path that does not exist: 404 is not a redirect either, so the clause passed without ever
  // showing the API prefix survives. /signup answers 405 to a GET, which only its handler can do.
  const apiStill = await ask(AFF_HOST, '/api/affiliate-site/signup');
  check('the API prefix is NOT redirected — the pages fetch it',
    apiStill.status === 405, `HTTP ${apiStill.status} — 405 is the handler answering, so it was reached`);
  // AND A NEW LINK CARRIES THE NEW ADDRESS. A link that redirects works and still looks like a
  // mistake in an email.
  const VER = await import('../lib/affiliate-email-verify.ts');
  const built = VER.verifyLinkUrl(TOK, 'https://affiliates.greasedesk.com');
  check('a newly minted confirmation link uses the bare address',
    built === `https://affiliates.greasedesk.com/confirm-email/${TOK}`, built);

  // ── 5. THE CANONICAL AND THE OG IMAGE ────────────────────────────────────────────────────────
  console.log('\n— the canonical names this host, not the apex —');
  const terms = await ask(AFF_HOST, '/terms');
  check('the root canonicalises to the affiliate host', canon(root.body) === `${AFFILIATE_SITE_URL}/`, canon(root.body));
  check('  …and so does the terms page, at /terms', canon(terms.body) === `${AFFILIATE_SITE_URL}/terms`, canon(terms.body));
  check('  …and NEITHER points at the apex',
    !canon(root.body).startsWith('https://greasedesk.com') && !canon(terms.body).startsWith('https://greasedesk.com'));
  check('the OG image is on this host and is a file this host serves',
    ogImage(root.body) === `${AFFILIATE_SITE_URL}/greasedesk-Logo.png`, ogImage(root.body));

  // ── 6. ROBOTS, EVALUATED RATHER THAN READ ────────────────────────────────────────────────────
  console.log('\n— robots says what it means —');
  const robots = await ask(AFF_HOST, '/robots.txt');
  check('this host serves its OWN robots.txt', robots.status === 200 && robots.body.includes(`Sitemap: ${AFFILIATE_SITE_URL}/sitemap.xml`),
    robots.body.split('\n').filter(Boolean).pop());
  check('  …naming no apex sitemap', !robots.body.includes('greasedesk.com/sitemap.xml') || robots.body.includes('affiliates.greasedesk.com/sitemap.xml'));
  const crawlable = (p) => ROBOTS.robotsDecision(robots.body, p);
  check('  …the public pages are CRAWLABLE', crawlable('/').allowed === true && crawlable('/terms').allowed === true,
    'a clause that a LINE EXISTS proves nothing about what the line does — this evaluates it');
  check('  …and the api is not', crawlable('/api/affiliate-site/waitlist').allowed === false);
  const sitemap = await ask(AFF_HOST, '/sitemap.xml');
  check('the sitemap lists this host’s URLs and not the apex’s',
    sitemap.body.includes(`<loc>${AFFILIATE_SITE_URL}/</loc>`) && !sitemap.body.includes('<loc>https://greasedesk.com'),
    sitemap.body.replace(/\s+/g, ' ').slice(0, 120));

  // ── 7. EVERY FIGURE FOLLOWS THE SETTINGS ─────────────────────────────────────────────────────
  // THE CLAUSE THIS SLICE EXISTS FOR. Not "a price appears" — the page's numbers MOVE when the row
  // moves, and they move to the right numbers. Driven on the singleton because that is the row a
  // public page reads; restored in teardown.
  console.log('\n— every figure on the page comes from the settings row —');
  await prisma.programmeSettings.update({
    where: { id: 'singleton' },
    data: { total_reward_pennies: 12000, instalment_pennies: 3000, affiliate_joining_open: false },
  });
  const atStandard = text((await ask(AFF_HOST, '/')).body);
  check('the standard terms read as £30 a month and £120 a garage',
    atStandard.includes('£30') && atStandard.includes('£120'), 'from total_reward_pennies and instalment_pennies');
  check('  …and the FOUR paid months is arithmetic, not a word in the copy',
    /first 4 paid months/.test(atStandard), 'total ÷ instalment — £120 ÷ £30');

  await prisma.programmeSettings.update({
    where: { id: 'singleton' },
    data: { total_reward_pennies: 20000, instalment_pennies: 5000 },
  });
  const moved = text((await ask(AFF_HOST, '/')).body);
  check('a settings change moves the page on the NEXT REQUEST',
    moved.includes('£50') && moved.includes('£200') && /first 4 paid months/.test(moved),
    'server-rendered, so there is no cache to wait for — £200 ÷ £50 is still four');
  check('  …and the OLD figures are gone, not merely joined by the new ones',
    !moved.includes('£30') && !moved.includes('£120'),
    'a page that printed both would pass an "includes the new number" clause');

  await prisma.programmeSettings.update({
    where: { id: 'singleton' },
    data: { total_reward_pennies: 12000, instalment_pennies: 4000 },
  });
  const three = text((await ask(AFF_HOST, '/')).body);
  check('  …and the COUNT follows too: £120 at £40 is three paid months',
    /first 3 paid months/.test(three) && !/first 4 paid months/.test(three),
    'the number of months is the one figure a reader would most reasonably hard-code');

  // THE GARAGE'S HALF, from the same resolver /pricing and the signup chooser use.
  check('the garage’s offer is stated as months and money',
    /12 months for the price of 8/.test(three) && /£600/.test(three) && /£750/.test(three),
    'publicPlanChoice with referred: true — this page cannot quote an offer a garage would not get');

  // ── 8. THE SWITCH, AND WHAT IT CHANGES ───────────────────────────────────────────────────────
  console.log('\n— the joining switch changes the door and nothing else —');
  const shut = await ask(AFF_HOST, '/');
  check('with joining SHUT the waiting-list form is there',
    /data-testid="waitlist-form"/.test(shut.body) && /data-testid="waitlist-email"/.test(shut.body));
  check('  …and the join button is REPLACED, not merely hidden',
    !/data-testid="join-open"/.test(shut.body), 'absent from the HTML — a hidden button is still a door someone can find');
  check('  …with the owner’s words on it', text(shut.body).includes('Opening soon') && /leave your email/i.test(text(shut.body)));
  check('  …while everything else about the programme is still shown',
    /data-testid="terms-card"/.test(shut.body) && /data-testid="how-steps"/.test(shut.body) && /data-testid="faq"/.test(shut.body)
      && /data-testid="audience-trade"/.test(shut.body) && /data-testid="audience-creator"/.test(shut.body),
    'somebody who reads all this and wants in must not have to come back to find out whether they can');

  await prisma.programmeSettings.update({ where: { id: 'singleton' }, data: { affiliate_joining_open: true } });
  const open = await ask(AFF_HOST, '/');
  check('with joining OPEN the join button is there',
    /data-testid="join-open"/.test(open.body) && /href="\/join"/.test(open.body));
  check('  …and the waiting-list form is gone',
    !/data-testid="waitlist-form"/.test(open.body), 'two doors at once would be two answers to one question');
  // AND THE BUTTON GOES SOMEWHERE. A clause on the href alone would pass against a 404: the page
  // behind it is a stub until the signup slice, and a stub is the point — a live button pointing at
  // nothing is worse than no button.
  // THE BARE ADDRESS (2026-10-31). This used to ask /affiliate-site/join, which now 308s — so the
  // clause would have been measuring the redirect rather than the page behind the button.
  const join = await ask(AFF_HOST, '/join');
  // THE SIGNUP ITSELF LANDED (slice D), so what is behind the button is the real form rather than
  // the stub this clause was written against. It still asks the only question that matters here:
  // the live button does not point at a 404. affiliate-join-gate holds the form's behaviour.
  check('  …and the button it shows does NOT point at a 404',
    join.status === 200 && /data-testid="join-form"/.test(join.body), `HTTP ${join.status}`);
  // NO INTERNAL PATH IN THE RENDERED HTML. The redirect makes an old link WORK; a page that still
  // emits one is a page that shows people the folder name and costs them a hop every click.
  check('  …and no link on these pages still carries the internal /affiliate-site prefix',
    !/href="\/affiliate-site/.test(open.body) && !/href="\/affiliate-site/.test(join.body)
    && !/href="\/affiliate-site/.test(terms.body),
    (`${open.body}${join.body}${terms.body}`.match(/href="\/affiliate-site[^"]*"/) ?? ['none'])[0]);
  check('  …and the page still shows the terms, the steps and the questions',
    /data-testid="terms-card"/.test(open.body) && /data-testid="how-steps"/.test(open.body) && /data-testid="faq"/.test(open.body));

  // ── 9. THE COPY ITSELF ───────────────────────────────────────────────────────────────────────
  // Not a proofread — two rules this codebase holds everywhere, over the RENDERED TEXT.
  console.log('\n— the copy obeys the two standing rules —');
  const copy = text(open.body);
  check('the word "free" is nowhere on the page',
    !/\bfree\b/i.test(copy), 'the sitewide wording rule: dated wording, never "free"');
  check('  …and the discriminator: the trial IS described, in days',
    /\d+ days with nothing to pay/.test(copy), 'otherwise the clause above passes on a page that says nothing at all');
  check('both audiences are addressed by name',
    /motor trade|in and out of garages/i.test(copy) && /videos|content/i.test(copy),
    'one page, two starting points — the owner asked for both');
  // THE AD LABEL (owner, 2026-10-30). Affiliate content is an ad under the CAP Code and has to be
  // obviously identifiable as one. Asserted in BOTH places it must appear, because a rule stated to
  // creators in their own section and then missing from the question they actually click on is a
  // rule we told them once and hid afterwards.
  check('the ad-labelling rule is on the page, with the tag it means',
    /labelled as an ad/i.test(copy) && /#ad/.test(copy), 'UK advertising rules, said where a creator reads');
  check('  …in the creator section AND in the video question',
    (copy.match(/labelled as an ad/gi) ?? []).length >= 2,
    `found ${(copy.match(/labelled as an ad/gi) ?? []).length} — one of the two places would leave the other silent`);

  // ── 10. THE PURE RULES BEHIND IT ─────────────────────────────────────────────────────────────
  console.log('\n— and the rules behind the figures —');
  const f = PUB.rewardFigures({ totalRewardPennies: 12000, instalmentPennies: 3000 });
  check('four paid months out of £120 at £30', f.paidMonths === 4 && f.monthlyApplies === true, JSON.stringify(f));
  const zero = PUB.rewardFigures({ totalRewardPennies: 12000, instalmentPennies: 0 });
  check('  …and a ZERO instalment is a refusal, not a division',
    zero.paidMonths === null && zero.monthlyApplies === false && zero.instalmentLabel === null,
    'refusePlanSetting accepts zero pennies, so this is a state the Engine Room can create');
  check('  …which the sentence says WITHOUT inventing a monthly figure',
    !/month/.test(PUB.rewardSentence(zero)) && PUB.rewardSentence(zero).includes('£120'),
    PUB.rewardSentence(zero));

  // ── THE CAP IS PER GARAGE, NOT PER AFFILIATE (owner, 2026-10-31) ─────────────────────────────
  // It read: "£30 for each of a garage's first 4 paid months — £120 a garage, and £120 is the most
  // one garage can earn." Read aloud that is a LIFETIME CAP on the affiliate, which is the opposite
  // of the offer: £120 is the ceiling per introduced garage and the number of garages is unlimited.
  // "One garage" was doing duty for both the thing counted and the thing earning.
  const live = PUB.rewardSentence(f);
  check('the reward sentence cannot be read as a lifetime cap on the affiliate',
    !/is the most one garage can earn/.test(live) && !/\bmost\b/.test(live), live);
  check('  …it says the per-garage ceiling is a ceiling PER GARAGE',
    /up to £120 for every garage you introduce/.test(live), live);
  check('  …and that the number of garages is not limited',
    /no limit on how many garages/.test(live), live);
  check('  …while still naming the instalment and the number of months',
    /£30/.test(live) && /first 4 paid months/.test(live), live);
  const odd = PUB.rewardFigures({ totalRewardPennies: 12000, instalmentPennies: 5000 });
  check('  …and the count FLOORS: £120 at £50 is two, not two-and-a-bit',
    odd.paidMonths === 2, 'the cap is the cap — nobody is promised a third £50');
  const pence = PUB.rewardFigures({ totalRewardPennies: 12050, instalmentPennies: 3000 });
  check('  …pence show only when there are pence', pence.totalLabel === '£120.50' && pence.instalmentLabel === '£30',
    `${pence.totalLabel} / ${pence.instalmentLabel}`);

  check('the waiting list refuses an address that is not one',
    WAIT.validateWaitlist({ email: 'not-an-email' }).ok === false && WAIT.validateWaitlist({ email: '' }).ok === false);
  check('  …accepts one that is, folded to lower case',
    WAIT.validateWaitlist({ email: ' Sam@Example.Invalid ' }).fields?.email === 'sam@example.invalid',
    'the unique index is case-sensitive, so the fold is what makes one person one place in the queue');
  check('  …takes no answer as NULL rather than as a guess',
    WAIT.validateWaitlist({ email: 'a@b.co' }).fields?.audience === null
      && WAIT.validateWaitlist({ email: 'a@b.co', audience: '' }).fields?.audience === null);
  check('  …and REFUSES an audience it does not recognise',
    WAIT.validateWaitlist({ email: 'a@b.co', audience: 'influencer' }).ok === false,
    'a value turned into NULL would hide the form and this list drifting apart');

  // ── 10b. THE WAITING LIST ACTUALLY STORES ────────────────────────────────────────────────────
  // Everything above is the page. This is the pipe: a person leaves an address on a closed
  // programme's page, and the owner reads it in the Engine Room. Driven against the REAL endpoint
  // and the REAL table, with this gate's own forwarded IP so the limiter budget is nobody else's.
  console.log('\n— the waiting list stores what it is given —');
  await prisma.affiliateWaitlist.deleteMany({ where: { email: { endsWith: MARK } } });
  const post = (payload, { xff = GATE_IP } = {}) =>
    ask(AFF_HOST, '/api/affiliate-site/waitlist', { method: 'POST', body: JSON.stringify(payload), xff });
  const rowFor = (email) => prisma.affiliateWaitlist.findUnique({ where: { email } });

  const SAM = `sam${MARK}`;
  const first = await post({ email: ` SAM${MARK.toUpperCase()} `, audience: 'creator' });
  const samRow = await rowFor(SAM);
  check('an address left on the closed page is STORED', first.status === 200 && !!samRow, `HTTP ${first.status}`);
  check('  …folded to lower case, so one person holds one place in the queue',
    samRow?.email === SAM, `${samRow?.email} — the unique index is case-sensitive; the fold is what makes this true`);
  check('  …with the answer they gave about themselves', samRow?.audience === 'creator', String(samRow?.audience));

  const askedAt = samRow?.created_at;
  const again = await post({ email: SAM, audience: 'trade' });
  const corrected = await rowFor(SAM);
  check('  …and the same person twice is ONE row, not an error',
    again.status === 200 && (await prisma.affiliateWaitlist.count({ where: { email: { endsWith: MARK } } })) === 1,
    `HTTP ${again.status} — there is nothing for them to do about it, and the answer would tell a stranger whether an address is on the list`);
  check('  …their correction is taken', corrected?.audience === 'trade', String(corrected?.audience));
  check('  …and their PLACE IN THE QUEUE is the day they first asked',
    corrected?.created_at?.getTime() === askedAt?.getTime(),
    'upsert, not delete-and-create — a second visit must not send them to the back');
  await post({ email: SAM });
  check('  …while answering nothing the second time does NOT erase what they said',
    (await rowFor(SAM))?.audience === 'trade',
    'null means "they did not say", which is not the same as "they said nothing this time"');

  const noAnswer = `quiet${MARK}`;
  await post({ email: noAnswer });
  check('somebody who does not say which they are is stored as NULL',
    (await rowFor(noAnswer))?.audience === null, 'three states, and this is the third');

  const bad = await post({ email: 'not-an-email' });
  check('a malformed address is refused and stores nothing',
    bad.status === 400 && (await prisma.affiliateWaitlist.count({ where: { email: { endsWith: MARK } } })) === 2,
    `HTTP ${bad.status} — still two rows`);
  const unknownAudience = await post({ email: `x${MARK}`, audience: 'influencer' });
  check('  …and so is an audience the form does not offer',
    unknownAudience.status === 400 && !(await rowFor(`x${MARK}`)),
    'turning it into NULL would hide the form and the table drifting apart');

  const trap = await post({ email: `bot${MARK}`, website: 'http://spam.invalid' });
  check('the honeypot is accepted and dropped',
    trap.status === 200 && !(await rowFor(`bot${MARK}`)),
    'a bot told it failed learns what to change; one told it worked does not');

  const getIt = await ask(AFF_HOST, '/api/affiliate-site/waitlist');
  check('a GET is 405, not a stored blank', getIt.status === 405, `HTTP ${getIt.status}`);

  // THE LIMITER. A public POST that writes a row, so it is the strict limiter: ten an hour per IP.
  // Spent on this gate's own forwarded address and swept in teardown.
  const burst = [];
  for (let i = 0; i < 12; i++) burst.push((await post({ email: `burst${i}${MARK}` })).status);
  check('a burst past the limit is REFUSED',
    burst.includes(429), `${burst.filter((s) => s === 200).length} accepted, ${burst.filter((s) => s === 429).length} refused of 12`);
  check('  …after letting the honest ones through first',
    burst[0] === 200, 'a limiter that refuses the first request is an outage, not a limit');

  // ── 10c. AND THE OWNER CAN READ IT ───────────────────────────────────────────────────────────
  // The other end of the pipe, through the REAL Engine Room screen on the REAL host. A clause on
  // the table alone would prove the write and nothing about whether anyone can see it.
  console.log('\n— and the owner reads it in the Engine Room —');
  const op = await prisma.operator.create({ data: {
    email: OP_EMAIL, name: 'Affiliate site gate', role: 'owner', status: 'active',
    regions: ['GB'], passwordHash: await bcrypt.hash(OP_PASS, 10) }, select: { id: true } });
  browser = await chromium.launch({ channel: 'chrome', args: ER_RESOLVER_ARGS });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 1400 } })).newPage();
  const onLogin = (path) => underPath(path, '/superadmin/login');
  await page.goto(`${erOrigin()}/superadmin/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', OP_EMAIL);
  await page.fill('input[type="password"]', OP_PASS);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !onLogin(u.pathname), { timeout: 60000 }).catch(() => {});
  check('an owner operator is signed in to the Engine Room', !onLogin(new URL(page.url()).pathname), page.url());

  await page.goto(`${erOrigin()}/superadmin/affiliates`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="waitlist-count"]', { timeout: 30000 }).catch(() => {});
  const inDb = await prisma.affiliateWaitlist.count();
  const rows = await page.locator('[data-testid="waitlist-row"]').count();
  check('the waiting-list screen shows EVERY row the table holds',
    rows === inDb && rows > 0, `${rows} rows on the screen, ${inDb} in the table`);
  const countLabel = await page.locator('[data-testid="waitlist-count"]').innerText().catch(() => '');
  check('  …and the count beside the heading is that same number',
    countLabel.replace(/[()]/g, '') === String(inDb), `"${countLabel}" vs ${inDb} — a label claiming WHICH number it is, asserted against the maths`);
  const screen = await page.locator('[data-testid="waitlist-table"]').innerText().catch(() => '');
  check('  …the address a person actually left is on it', screen.includes(SAM), SAM);
  check('  …and "they did not say" reads as a dash, not an empty cell',
    screen.includes('—'), 'an empty cell cannot be told from a rendering fault');
  // THE SWITCH'S STATE IS ON THE SCREEN. Joining is OPEN at this point in the run (section 8 left
  // it so), which is the harder case: the list only grows while it is shut, so a screen that did
  // not say which way the switch was set would invite "why has nobody joined?".
  const stateLine = await page.locator('[data-testid="joining-state"]').innerText().catch(() => '');
  check('  …and the screen says which way the joining switch is set',
    /New affiliates can join/.test(stateLine), stateLine.replace(/\s+/g, ' ').slice(0, 90));

  // AND IT IS OWNER-ONLY. erMinRole falls back to 'support' for an unregistered href, so this is
  // also the clause that proves the nav line exists.
  const { erMinRole } = await import('../lib/operator-roles.ts');
  check('the screen is registered as OWNER-only',
    erMinRole('/superadmin/affiliates') === 'owner',
    'an unregistered href falls back to support, which would open a list of the public’s email addresses');

  // ── 11. THE MIDDLEWARE SOURCE SAYS WHY ───────────────────────────────────────────────────────
  // ONE source clause, and it is about a TRAP rather than about behaviour the probes above cover:
  // the next person to add a portal here will reach for underPath(p, '/api/affiliate'), which is the
  // line that breaks the garage signup. The probes prove today; this is why the comment must stay.
  const mw = readFileSync('/Users/hugh/Developer/greasedesk-core/middleware.ts', 'utf8');
  check('middleware records why /api/affiliate is not closed on the apex',
    /check-code/.test(mw) && /isAffiliateSite/.test(mw),
    'the hazard is invisible from the diff that would cause it');
  check('  …and the affiliate site is matched with underPath, not a hand-written prefix',
    /underPath\(p, '\/affiliate-site'\)/.test(mw), 'anchored-match-gate bans the hand-written form app-wide');

} catch (e) {
  console.log(`\n✗ THREW: ${describeError(e).slice(0, 700)}`);
  out.push('F');
} finally {
  await browser?.close().catch(() => {});
  const put = await restore().catch(() => -1);
  const now = await prisma?.programmeSettings.findUnique({
    where: { id: 'singleton' },
    select: { affiliate_joining_open: true, total_reward_pennies: true, instalment_pennies: true },
  }).catch(() => null);
  check('teardown put the live settings row back exactly as it was',
    put === 1 && !!before && !!now
      && now.affiliate_joining_open === before.affiliate_joining_open
      && now.total_reward_pennies === before.total_reward_pennies
      && now.instalment_pennies === before.instalment_pennies,
    `${JSON.stringify(now)} vs ${JSON.stringify(before)}`);
  console.log(`\n${out.filter((x) => x === 'F').length} failures of ${out.length}`);
  await prisma?.$disconnect();
  process.exit(out.includes('F') ? 1 : 0);
}
