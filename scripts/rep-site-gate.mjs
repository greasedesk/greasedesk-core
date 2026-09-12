/**
 * File: scripts/rep-site-gate.mjs
 * THE PUBLIC RESELLER SITE: its own host, its own boundary, its own SEO — and the portal untouched.
 * @gate-requires: server, db
 *
 * reps.greasedesk.com used to be the rep portal and nothing else: '/' rewrote to /rep, which sent a
 * visitor with no session to /rep/login, so the bare domain WAS the sign-in page. It is now a public,
 * indexable marketing site, and a signed-in reseller still gets the portal.
 *
 * ── WHAT THIS GATE IS REALLY FOR ────────────────────────────────────────────────────────────────
 * Two things that are easy to get wrong and silent when wrong:
 *   1. THE BOUNDARY. One named prefix, /rep-site, is the whole allow-list addition (owner's choice
 *      over an exact-match list that grows a line per image — "a boundary nobody notices widening").
 *      So the clause that matters is not "the prefix works", it is "NOTHING OUTSIDE IT IS REACHABLE",
 *      and /public is the thing to prove that against.
 *   2. THE CANONICAL. A second public host whose pages canonicalise to the apex tells a crawler the
 *      whole site duplicates URLs that 404 on it. Nothing in a page's appearance shows that.
 *
 * ── WHY THE HAPPY-PATH POST IS NOT DRIVEN LIVE ──────────────────────────────────────────────────
 * RESEND_API_KEY is configured on this machine, so a successful POST would email the owner EVERY RUN.
 * So the live probes are the ones that cannot send — GET is 405, a bad payload is 400 before the send,
 * the honeypot returns 200 having sent and stored nothing — and the success path is covered three
 * other ways: interestOutcome proved on all four combinations, the handler's structure read from
 * source (two independent trys, the send before the store, email_delivered taken from its result),
 * and the store's own constraints exercised against the real table. Said out loud because "the form
 * works" is not what is proved here.
 */
import './_gate-preflight.mjs';
import './_ts.mjs';
const { gatePrisma, describeError, gateOrigin, repOrigin, erOrigin } = await import('./_gate-preflight.mjs');
const { readFileSync } = await import('node:fs');
const { randomUUID } = await import('node:crypto');
const http = await import('node:http');
const RULES = await import('../lib/reseller-interest.ts');
const { RETENTION_MONTHS } = await import('../lib/prospects.ts');
const { REP_SITE_URL } = await import('../lib/company-info.ts');
const { underPath } = await import('../lib/anchored-match.ts');
const ROBOTS = await import('../lib/robots-rules.ts');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const src = (f) => readFileSync(f, 'utf8');
const code = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const B = new URL(gateOrigin());
const REP_HOST = new URL(repOrigin()).hostname;
const APEX = B.hostname;

/** One request, one host header, no redirect following — a redirect is the answer, not a detour. */
const ask = (host, path, { method = 'GET', cookie, body, form } = {}) => new Promise((resolve) => {
  const headers = { Host: `${host}:${B.port}` };
  if (cookie) headers.cookie = cookie;
  if (body) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(body); }
  if (form) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; headers['Content-Length'] = Buffer.byteLength(form); }
  const r = http.request({ hostname: B.hostname, port: B.port, path, method, headers }, (res) => {
    let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: b, headers: res.headers }));
  });
  r.on('error', (e) => resolve({ status: 0, body: String(e), headers: {} }));
  if (body) r.write(body);
  if (form) r.write(form);
  r.end();
});

const prisma = await gatePrisma();
const made = { enquiries: [], reps: [] };
const MARK = '@rep-site-gate.invalid';
await prisma.resellerEnquiry.deleteMany({ where: { email: { endsWith: MARK } } });

try {
  // ── 1. THE ROOT: PUBLIC TO A VISITOR, THE PORTAL TO A RESELLER ───────────────────────────────
  console.log('\n— the root serves the public site, and a signed-in reseller still gets the portal —');
  const root = await ask(REP_HOST, '/');
  check('the bare domain answers 200', root.status === 200, `HTTP ${root.status}`);
  check('  …with the public page, not the sign-in page', /data-testid="interest-submit"/.test(root.body) && !/data-testid="rep-request"/.test(root.body),
    'it used to rewrite to /rep, which redirected to /rep/login — the bare domain WAS the sign-in page');
  check('  …and it is indexable: no noindex on it', !/name="robots" content="noindex"/.test(root.body),
    'the whole point of the host change');

  // A REAL SESSION, reached the way a reseller reaches one: mint a magic link and spend it over HTTP.
  const M = await import('../lib/rep-magic-link.ts');
  const rep = await prisma.rep.create({
    data: { email: `rep-site-gate-${randomUUID().slice(0, 8)}${MARK}`, name: 'Rep Site Gate', ref_code: `RSG${randomUUID().slice(0, 8)}` },
    select: { id: true, email: true },
  });
  made.reps.push(rep.id);
  const minted = await M.mintRepLink({ repId: rep.id, sentTo: rep.email, baseUrl: repOrigin() });
  const token = minted.url.split('/').pop();
  /**
   * SIGN IN THE WAY THE PAGE DOES. /rep/enter/[token] calls signIn('rep') CLIENT-SIDE, so fetching it
   * sets no cookie at all — the first version of this clause read that 200 as a failure to sign in,
   * when it was a failure to ASK. The credentials callback is what mints the session; cookies are
   * carried back WHOLE, because over HTTPS next-auth prefixes them (__Secure-) and a regex that
   * matched the bare name once sent a cookie nobody recognised.
   */
  const jar = new Map();
  const keep = (r) => { for (const c of r.headers['set-cookie'] ?? []) { const kv = c.split(';')[0]; const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); } };
  const cookies = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const csrfRes = await ask(REP_HOST, '/api/auth/csrf');
  keep(csrfRes);
  const csrfToken = JSON.parse(csrfRes.body || '{}').csrfToken;
  const cb = await ask(REP_HOST, '/api/auth/callback/rep', {
    method: 'POST', cookie: cookies(),
    form: new URLSearchParams({ token, csrfToken, json: 'true' }).toString(),
  });
  keep(cb);
  const session = [...jar.keys()].some((k) => k.endsWith('next-auth.session-token')) ? cookies() : '';
  check('a reseller can still sign in on this host', !!session, session ? 'session cookie held' : `no session cookie (csrf ${csrfRes.status}, callback ${cb.status})`);
  const asRep = await ask(REP_HOST, '/', { cookie: session });
  check('  …and the ROOT sends them to the portal, not the marketing page', asRep.status === 307 || asRep.status === 302,
    `HTTP ${asRep.status} → ${asRep.headers.location ?? '—'}`);
  // underPath, NOT includes('/rep'): '/rep-site' contains that string, so the first version of this
  // clause would have passed on a redirect to the marketing page — the exact failure the helper exists
  // for, written by hand in a gate about this host. anchored-match-gate caught it.
  check('  …at /rep, the portal, and not at /rep-site', underPath(asRep.headers.location ?? '', '/rep'),
    asRep.headers.location ?? 'no Location');

  console.log('\n— and the portal itself is exactly as it was —');
  const repNoSession = await ask(REP_HOST, '/rep');
  check('/rep with no session still redirects to sign-in', (repNoSession.status === 307 || repNoSession.status === 302) && underPath(repNoSession.headers.location ?? '', '/rep/login'),
    `HTTP ${repNoSession.status} → ${repNoSession.headers.location ?? '—'}`);
  const login = await ask(REP_HOST, '/rep/login');
  check('/rep/login still serves the sign-in page', login.status === 200 && /data-testid="rep-request"/.test(login.body));
  check('  …and both portal pages keep their noindex', /name="robots" content="noindex"/.test(login.body)
    && /name="robots" content="noindex"/.test((await ask(REP_HOST, '/rep', { cookie: session })).body),
    'one host, an indexable front and a private portal — the tags are what separate them');

  // ── 2. THE BOUNDARY: ONE NAMED PREFIX, AND NOTHING OUTSIDE IT ────────────────────────────────
  console.log('\n— one named prefix is the whole boundary —');
  for (const [what, path, want] of [
    ['the public page', '/rep-site', 200],
    ['its terms, at the address a person types', '/terms', 200],
    ['an asset inside the prefix', '/rep-site/og.png', 200],
    ['the interest endpoint', '/api/rep-site/interest', 405],          // reachable; POST-only
    ['the brand asset (exact match, pre-existing)', '/greasedesk-Logo.png', 200],
  ]) check(`${what} is served`, (await ask(REP_HOST, path)).status === want, `${path} → want ${want}`);

  const movedTerms = await ask(REP_HOST, '/rep-site/terms');
  check('the address terms SHIPPED at redirects, permanently, rather than 404ing', movedTerms.status === 308 && (movedTerms.headers.location ?? '').endsWith('/terms'),
    `HTTP ${movedTerms.status} → ${movedTerms.headers.location ?? '—'} — it was live and crawlable, however briefly`);
  check('  …and /terms is not a 404 on this host, which is what production returned', (await ask(REP_HOST, '/terms')).status === 200,
    'the page existed at /rep-site/terms and the obvious URL returned 404; no clause could review that choice, and the resolves clauses below catch the family');

  const outside = ['/android-chrome-512x512.png', '/robots.txt.bak', '/favicon-32x32.png'];
  const outsideCodes = [];
  for (const p of outside) outsideCodes.push(`${p}:${(await ask(REP_HOST, p)).status}`);
  check('a /public file OUTSIDE the prefix is NOT reachable', outsideCodes.every((c) => c.endsWith(':404')), outsideCodes.join(' '));
  for (const [what, path] of [['the marketing site', '/pricing'], ['the tenant app', '/admin/login'], ['the Engine Room', '/superadmin/login'], ['a tenant api', '/api/reports/vat-summary']])
    check(`${what} 404s here`, (await ask(REP_HOST, path)).status === 404, path);

  console.log('\n— and the reseller site is closed on every other host —');
  for (const [host, label] of [[APEX, 'the apex'], [new URL(erOrigin()).hostname, 'er.']])
    for (const path of ['/rep-site', '/rep-site/terms', '/api/rep-site/interest'])
      check(`${path} 404s on ${label}`, (await ask(host, path)).status === 404);
  // NOT VACUOUS: the same probe must find a 200 somewhere, or every clause above passes on a dead server.
  check('  …and that probe can reach a live page', (await ask(APEX, '/pricing')).status === 200,
    'the apex marketing site still serves — otherwise the 404s above prove nothing');

  // ── 3. SEO: A SECOND HOST CANONICALISES TO ITSELF ────────────────────────────────────────────
  console.log('\n— a second public host canonicalises to itself —');
  const terms = await ask(REP_HOST, '/terms');   // the address it is served at, not the file's path
  const canon = (b) => (/<link rel="canonical" href="([^"]+)"/.exec(b) ?? [])[1] ?? '(none)';
  check('the root canonicalises to the reseller host', canon(root.body) === `${REP_SITE_URL}/`, canon(root.body));
  check('  …and so does the terms page, at /terms', canon(terms.body) === `${REP_SITE_URL}/terms`, canon(terms.body));
  check('  …and NEITHER points at the apex', !canon(root.body).startsWith('https://greasedesk.com') && !canon(terms.body).startsWith('https://greasedesk.com'),
    'a canonical to the apex tells a crawler this site duplicates URLs that 404 on it');
  const og = (/property="og:image" content="([^"]+)"/.exec(root.body) ?? [])[1] ?? '(none)';
  check('the OG image is on this host and inside the prefix', og === `${REP_SITE_URL}/rep-site/og.png`, og);

  const robots = await ask(REP_HOST, '/robots.txt');
  check('this host serves its OWN robots.txt', robots.status === 200 && robots.body.includes(`Sitemap: ${REP_SITE_URL}/sitemap.xml`), robots.body.split('\n').filter(Boolean).pop());
  check('  …naming no apex sitemap', !robots.body.includes('greasedesk.com/sitemap.xml') || robots.body.includes('reps.greasedesk.com/sitemap.xml'),
    'a static file cannot vary by Host; served here the apex one would point crawlers at URLs that 404');
  /**
   * ── WHAT THE DIRECTIVES DO, NOT WHETHER A LINE IS PRESENT ─────────────────────────────────────
   * This clause used to be `/^Disallow: \/rep$/m.test(robots.body)` and it passed while the file was
   * wrong: robots.txt matching is prefix-based, so `Disallow: /rep` forbade /rep-site/terms too — the
   * page the sitemap was advertising. The regex was anchored; the directive was not. Its waiver even
   * said so, about the wrong object.
   *
   * So the paths are evaluated against the real directives with lib/robots-rules (RFC 9309), whose
   * own matcher is proved on the prefix case below before it is trusted here.
   */
  const crawlable = (p) => ROBOTS.robotsDecision(robots.body, p);
  check('  …and the PORTAL is disallowed', crawlable('/rep').allowed === false && crawlable('/rep/login').allowed === false,
    `/rep → ${crawlable('/rep').rule ?? 'no rule'}`);
  check('  …while the public pages are CRAWLABLE — the bug this clause missed', crawlable('/terms').allowed === true && crawlable('/').allowed === true && crawlable('/rep-site/og.png').allowed === true,
    `/terms → ${crawlable('/terms').rule ?? 'no rule'} · /rep-site/og.png → ${crawlable('/rep-site/og.png').rule ?? 'no rule'}`);
  check('  …and the api is disallowed', crawlable('/api/rep-site/interest').allowed === false);
  // THE MATCHER ITSELF, proved on the case that caused the defect, before it is believed above.
  // @anchored-ok: this string IS a robots.txt FIXTURE DOCUMENT — the exact file production served — passed to the matcher as data; it matches nothing
  const PREFIX_BUG = 'User-agent: *\nAllow: /\nDisallow: /rep\n';
  check('the matcher reproduces the original defect on the ORIGINAL file', ROBOTS.robotsDecision(PREFIX_BUG, '/rep-site/terms').allowed === false,
    'prefix matching, RFC 9309 §2.2.2 — `Disallow: /rep` really did forbid /rep-site/terms');
  check('  …and the longer Allow is what fixes it', ROBOTS.robotsDecision(`${PREFIX_BUG}Allow: /rep-site/\n`, '/rep-site/terms').allowed === true
    && ROBOTS.robotsDecision(`${PREFIX_BUG}Allow: /rep-site/\n`, '/rep/login').allowed === false,
    'longest match wins, a tie goes to allow');
  check('  …an unmatched path is allowed', ROBOTS.robotsDecision(PREFIX_BUG, '/anything').allowed === true);
  check('  …an empty Disallow is not a rule', ROBOTS.robotsDecision('User-agent: *\nDisallow:\n', '/rep').allowed === true,
    '"Disallow:" with no value means disallow NOTHING');
  check('  …and $ anchors, while a bare prefix does not', ROBOTS.patternMatches('/rep$', '/rep') && !ROBOTS.patternMatches('/rep$', '/rep-site')
    && ROBOTS.patternMatches('/rep', '/rep-site'),
    'the asymmetry the original clause read past');
  const sitemap = await ask(REP_HOST, '/sitemap.xml');
  const locs = [...sitemap.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  check('this host serves its OWN sitemap', sitemap.status === 200 && locs.length === 2, `${locs.length} url(s): ${locs.join(' ')}`);
  check('  …every url on its own origin', locs.every((l) => l.startsWith(REP_SITE_URL)), locs.join(' '));
  // THE PATHS, PARSED AND ANCHORED. A regex over the whole URL string matched '/rep-site' too, so this
  // clause could only ever have passed — the sitemap's two entries are the root and a /rep-site path.
  const sitemapPaths = locs.map((l) => l.slice(REP_SITE_URL.length) || '/');
  check('  …and the portal is not in it', !sitemapPaths.some((p) => underPath(p, '/rep')), sitemapPaths.join(' '));

  /**
   * ── EVERY URL THIS SITE PUBLISHES ACTUALLY RESOLVES ───────────────────────────────────────────
   * The clause that would have caught the /terms 404. No clause can review a URL CHOICE — the page
   * was reachable at the path I picked, and the gate proved that path — but a site that advertises a
   * URL in its sitemap, or links one in its own chrome, and then 404s it is a class of defect a
   * mechanism can close completely. Both directions are checked because they fail differently: a
   * sitemap entry fails for crawlers and nobody sees it; a chrome link fails for the person holding
   * the phone.
   */
  console.log('\n— every url this site publishes resolves on this host —');
  const resolved = [];
  for (const loc of locs) {
    const p = loc.slice(REP_SITE_URL.length) || '/';
    resolved.push(`${p}:${(await ask(REP_HOST, p)).status}`);
  }
  check('every url in the sitemap answers 200', resolved.every((r) => r.endsWith(':200')), resolved.join(' '));
  const chromeHrefs = [...src('components/rep-site/RepSiteChrome.tsx').matchAll(/href="(\/[^"#]*)"/g)].map((m) => m[1]);
  const chromeResolved = [];
  for (const href of [...new Set(chromeHrefs)]) chromeResolved.push(`${href}:${(await ask(REP_HOST, href)).status}`);
  check('every internal link in the chrome answers on this host', chromeHrefs.length >= 3 && chromeResolved.every((r) => /:(200|30[78])$/.test(r)),
    chromeResolved.join(' ') || 'no hrefs found — the scan must find the links before it can clear them');
  // NOT VACUOUS: the probe must be able to see a 404, or "everything resolves" is a blind pass.
  check('  …and that probe can still see a 404', (await ask(REP_HOST, '/terms-that-does-not-exist')).status === 404);

  console.log('\n— the apex keeps its own, and hands /reseller over permanently —');
  const apexRobots = await ask(APEX, '/robots.txt');
  check('the apex robots.txt is untouched', apexRobots.status === 200 && apexRobots.body.includes('Sitemap: https://greasedesk.com/sitemap.xml'),
    'it was deliberately NOT turned into a host-aware route — that would put live garage SEO at risk to add a second site');
  const apexSitemap = await ask(APEX, '/sitemap.xml');
  // PARSED, not substring-matched: the question is whether a <loc> IS the old page, and a body search
  // would also trip on the word appearing in a comment or a neighbouring path.
  const apexLocs = [...apexSitemap.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  check('  …and its sitemap no longer advertises /reseller', apexSitemap.status === 200 && apexLocs.length > 0
    && !apexLocs.some((l) => underPath(new URL(l).pathname, '/reseller')),
    `${apexLocs.length} apex urls — a sitemap that lists a redirect invites a crawler to keep asking`);
  const moved = await ask(APEX, '/reseller');
  check('/reseller is a PERMANENT redirect to the reseller host', (moved.status === 308 || moved.status === 301) && (moved.headers.location ?? '').startsWith(REP_SITE_URL),
    `HTTP ${moved.status} → ${moved.headers.location ?? '—'} (Next emits 308 for permanent: true)`);
  check('  …and permanent is the point', moved.status !== 302 && moved.status !== 307, `HTTP ${moved.status} — a temporary redirect passes no ranking to the new home`);
  // THE REDIRECT IS UNCONDITIONAL, so what keeps it on the apex is middleware running FIRST. Measured,
  // not assumed — and this is the clause that makes dropping `has: host` safe.
  for (const [host, label] of [[REP_HOST, 'reps.'], [new URL(erOrigin()).hostname, 'er.']])
    check(`  …and /reseller still 404s on ${label}, so middleware wins the order`, (await ask(host, '/reseller')).status === 404,
      'the redirect is unconditional; this is what stops it firing anywhere but the apex');

  // ── 4. THE COOKIE BANNER REACHES THE PUBLIC SITE AND NOT THE PORTAL ──────────────────────────
  console.log('\n— the banner is for visitors, not for a signed-in reseller —');
  check('the public root carries the consent banner', /data-testid="consent-banner"/.test(root.body),
    'a public marketing site on its own host; the consent cookie is host-only, so an apex choice does not carry here');
  check('  …and the sign-in page does NOT', !/data-testid="consent-banner"/.test(login.body),
    'the /admin case: session cookies only');
  check('  …nor the portal', !/data-testid="consent-banner"/.test((await ask(REP_HOST, '/rep', { cookie: session })).body));
  const app = code(src('pages/_app.tsx'));
  check('and it is underPath, not a prefix, that keeps them apart', /underPath\(router\.pathname, '\/rep'\)/.test(app) && !/startsWith\('\/rep'\)/.test(app),
    "startsWith('/rep') would have taken /rep-site with it");

  // ── 5. THE STORE, AND THE TWO FAILURES THAT MUST NOT TAKE EACH OTHER DOWN ────────────────────
  console.log('\n— stored and emailed are independent —');
  const o = (stored, emailed) => RULES.interestOutcome({ stored, emailed }, '0330 555 3333');
  check('stored and emailed → the person is thanked', o(true, true).ok && o(true, true).status === 200);
  check('stored but NOT emailed → still thanked, because for them it is true', o(true, false).ok,
    'the enquiry is here; email_delivered=false is the flag to look at, not a failure to show a person');
  check('emailed but NOT stored → still thanked, because somebody was told', o(false, true).ok);
  check('NEITHER → the only error, and it says what to do instead', !o(false, false).ok && o(false, false).status === 502 && /call us on 0330 555 3333/.test(o(false, false).message),
    'silence here is the old defect: the enquiry vanished and the person was told it worked');

  const handler = code(src('pages/api/rep-site/interest.ts'));
  check('the handler catches the send and the store SEPARATELY', (handler.match(/} catch \(e\) \{/g) ?? []).length >= 2,
    'one try around both is one failure losing the other');
  check('  …sends first, then records what happened', handler.indexOf('sendEmail(') < handler.indexOf('resellerEnquiry.create'),
    'email_delivered is a fact about the send; writing the row first means a column that lies until corrected');
  // @anchored-ok: one literal assignment read out of the handler's source, not a property looked up by name
  const FROM_SEND_RESULT = /email_delivered: emailed/;
  check('  …writing email_delivered from the send result, not a constant', FROM_SEND_RESULT.test(handler),
    'a hardcoded true makes the column say the notification arrived when nobody was told');
  check('  …and the answer comes from the shared rule', /interestOutcome\(\{ stored, emailed \}/.test(handler));

  console.log('\n— the endpoint is wired, proved only by probes that cannot send —');
  check('GET is refused', (await ask(REP_HOST, '/api/rep-site/interest')).status === 405);
  const bad = await ask(REP_HOST, '/api/rep-site/interest', { method: 'POST', body: JSON.stringify({ name: '', email: 'x' }) });
  check('a bad payload is 400, BEFORE anything is sent or stored', bad.status === 400 && /name/i.test(bad.body), bad.body.slice(0, 80));
  const honey = await ask(REP_HOST, '/api/rep-site/interest', { method: 'POST', body: JSON.stringify({ name: 'Bot', email: `bot${MARK}`, website: 'http://spam' }) });
  check('the honeypot answers 200 and records NOTHING', honey.status === 200 && (await prisma.resellerEnquiry.count({ where: { email: { endsWith: MARK } } })) === 0,
    'a silent success for a bot, and no row to clean up');

  console.log('\n— validation names the field —');
  check('a missing name is refused', RULES.validateInterest({ email: 'a@b.co' }).message === 'Please enter your name.');
  check('a bad email is refused', /valid email/.test(RULES.validateInterest({ name: 'A', email: 'nope' }).message));
  check('an over-long field SAYS WHICH', /area is too long/.test(RULES.validateInterest({ name: 'A', email: 'a@b.co', area: 'x'.repeat(RULES.LIMITS.area + 1) }).message),
    '"one of the fields is too long" made the person hunt for it');
  check('  …and a good payload passes', RULES.validateInterest({ name: 'A', email: 'a@b.co', area: 'West Midlands' }).ok === true);

  // ── 6. RETENTION, ON ONE CLOCK ───────────────────────────────────────────────────────────────
  console.log('\n— the same retention period as a prospect, not a second copy of it —');
  const now = new Date('2026-09-12T00:00:00Z');
  const older = new Date(now); older.setUTCMonth(older.getUTCMonth() - RETENTION_MONTHS - 1);
  const newer = new Date(now); newer.setUTCMonth(newer.getUTCMonth() - RETENTION_MONTHS + 1);
  check(`an enquiry older than ${RETENTION_MONTHS} months is past retention`, RULES.interestPastRetention(older, now, RETENTION_MONTHS));
  check('  …and a newer one is not', !RULES.interestPastRetention(newer, now, RETENTION_MONTHS));
  check('the period comes from lib/prospects, not a literal here', /RETENTION_MONTHS/.test(code(src('scripts/rep-site-gate.mjs'))) && !/24/.test(code(src('lib/reseller-interest.ts'))),
    'two copies of a retention period drift, and the one nobody updates is the one that keeps data too long');

  console.log('\n— and the database holds the strip pair and its vocabulary —');
  const row = await prisma.resellerEnquiry.create({
    data: { name: 'Gate', email: `row${MARK}`, email_delivered: true }, select: { id: true },
  });
  made.enquiries.push(row.id);
  check('an enquiry stores, with nothing stripped', !!row.id);
  // SAVEPOINT PER PROBE: a caught violation poisons the transaction, so each breach gets its own.
  const breaks = async (sql) => {
    try { await prisma.$transaction(async (tx) => { await tx.$executeRawUnsafe('SAVEPOINT p'); await tx.$executeRawUnsafe(sql); }); return false; }
    catch { return true; }
  };
  check('stripped_at without a reason is REFUSED', await breaks(`UPDATE "ResellerEnquiry" SET "personal_stripped_at" = now() WHERE id = '${row.id}'`),
    'an absence must never be ambiguous — ResellerEnquiry_strip_pair_chk');
  check('a reason without a date is REFUSED', await breaks(`UPDATE "ResellerEnquiry" SET "personal_stripped_reason" = 'retention' WHERE id = '${row.id}'`));
  check('a reason outside the vocabulary is REFUSED', await breaks(`UPDATE "ResellerEnquiry" SET "personal_stripped_at" = now(), "personal_stripped_reason" = 'because' WHERE id = '${row.id}'`),
    'lib/prospects::STRIP_REASONS, enforced in the database so a typo cannot be stored');
  // THE POSITIVE CASE, in the same run: the pair together, with a real reason, is accepted.
  await prisma.$executeRawUnsafe(`UPDATE "ResellerEnquiry" SET "personal_stripped_at" = now(), "personal_stripped_reason" = 'retention', "email" = NULL, "message" = NULL WHERE id = '${row.id}'`);
  const stripped = await prisma.resellerEnquiry.findUnique({ where: { id: row.id }, select: { email: true, personal_stripped_at: true, personal_stripped_reason: true } });
  check('  …and the pair together, with the person removed, is accepted', stripped.email === null && !!stripped.personal_stripped_at && stripped.personal_stripped_reason === 'retention',
    'the enquiry row stays; the person does not — the same shape as a prospect');
} catch (e) {
  check('gate run completed', false, describeError(e));
} finally {
  try {
    if (made.enquiries.length) await prisma.resellerEnquiry.deleteMany({ where: { id: { in: made.enquiries } } });
    await prisma.resellerEnquiry.deleteMany({ where: { email: { endsWith: MARK } } });
    if (made.reps.length) { await prisma.repMagicLink.deleteMany({ where: { rep_id: { in: made.reps } } }); await prisma.rep.deleteMany({ where: { id: { in: made.reps } } }); }
    check('teardown removed every fixture', (await prisma.resellerEnquiry.count({ where: { email: { endsWith: MARK } } })) === 0
      && (await prisma.rep.count({ where: { id: { in: made.reps } } })) === 0);
  } catch (e) { check('teardown completed', false, describeError(e)); }
  await prisma.$disconnect();
}
console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
process.exit(out.includes('F') ? 1 : 0);
