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
const { gatePrisma, describeError, gateOrigin, affiliateOrigin, repOrigin, erOrigin, serverReady, onTeardown } = await import('./_gate-preflight.mjs');
const { readFileSync } = await import('node:fs');
const http = await import('node:http');
const { AFFILIATE_SITE_URL } = await import('../lib/company-info.ts');
const { underPath } = await import('../lib/anchored-match.ts');
const ROBOTS = await import('../lib/robots-rules.ts');
const PUB = await import('../lib/affiliate-public.ts');
const WAIT = await import('../lib/affiliate-waitlist.ts');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const B = new URL(gateOrigin());
const AFF_HOST = new URL(affiliateOrigin()).hostname;
const REP_HOST = new URL(repOrigin()).hostname;
const ER_HOST = new URL(erOrigin()).hostname;
const APEX = B.hostname;

/** One request, one Host header, no redirect following — a redirect is the answer, not a detour. */
const ask = (host, path, { method = 'GET', body } = {}) => new Promise((resolve) => {
  const headers = { Host: `${host}:${B.port}` };
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

let prisma;
/** What the singleton held before this gate touched it — restored in teardown, whatever happens. */
let before = null;
const restore = async () => {
  if (!prisma || !before) return 0;
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
    ['/affiliate-site', 200, 'the page at its own path'],
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
    /data-testid="join-open"/.test(open.body) && /href="\/affiliate-site\/join"/.test(open.body));
  check('  …and the waiting-list form is gone',
    !/data-testid="waitlist-form"/.test(open.body), 'two doors at once would be two answers to one question');
  // AND THE BUTTON GOES SOMEWHERE. A clause on the href alone would pass against a 404: the page
  // behind it is a stub until the signup slice, and a stub is the point — a live button pointing at
  // nothing is worse than no button.
  const join = await ask(AFF_HOST, '/affiliate-site/join');
  check('  …and the button it shows does NOT point at a 404',
    join.status === 200 && /data-testid="join-stub"/.test(join.body), `HTTP ${join.status}`);
  check('  …and the page still shows the terms, the steps and the questions',
    /data-testid="terms-card"/.test(open.body) && /data-testid="how-steps"/.test(open.body) && /data-testid="faq"/.test(open.body));

  // ── 9. THE COPY ITSELF ───────────────────────────────────────────────────────────────────────
  // Not a proofread — two rules this codebase holds everywhere, over the RENDERED TEXT.
  console.log('\n— the copy obeys the two standing rules —');
  const page = text(open.body);
  check('the word "free" is nowhere on the page',
    !/\bfree\b/i.test(page), 'the sitewide wording rule: dated wording, never "free"');
  check('  …and the discriminator: the trial IS described, in days',
    /\d+ days with nothing to pay/.test(page), 'otherwise the clause above passes on a page that says nothing at all');
  check('both audiences are addressed by name',
    /motor trade|in and out of garages/i.test(page) && /videos|content/i.test(page),
    'one page, two starting points — the owner asked for both');

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
