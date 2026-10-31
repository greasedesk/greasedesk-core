/**
 * File: scripts/affiliate-portal-gate.mjs
 * THE AFFILIATE'S OWN PAGE: getting in, what it shows, what it withholds, and who we pay.
 * @gate-requires: server, db
 *
 * Its own gate rather than more clauses in affiliate-join-gate or affiliate-admin-gate, because the
 * subject is different again: that one holds a signup, the other holds the operator's list, and this
 * one holds a SIGNED-IN SURFACE that shows somebody their money and takes their bank details.
 *
 * ── THE FOUR THINGS IT IS REALLY FOR ───────────────────────────────────────────────────────────
 *   1. A rep and an affiliate are the same row with the same credential. The portals must not be
 *      reachable by each other's sessions, and the emailed link must not point at the wrong one — a
 *      URL that 404s is still a string, so nothing complained when that was exactly what happened.
 *   2. The page must WITHHOLD: no sort code, no account number, no pay-run hold reasons. Asserted
 *      against the SERVED HTML, not against the select that produced it.
 *   3. Applying a payee must not decrypt anything. That is what makes "every reveal is audited"
 *      true rather than aspirational, and it is asserted by reading the ciphertext back.
 *   4. The Engine Room and the portal must agree about money, to the penny, from one ledger.
 *
 * ── FIXTURES ───────────────────────────────────────────────────────────────────────────────────
 * Rep rows (one affiliate, one rep) whose email ends @zz-affiliate-portal.invalid, a throwaway
 * Group with a User in it, TenantAffiliateTerms, CommissionEntry rows, RepPayeeRequest rows, two
 * Documents, the audit rows this gate provokes, and its limiter tokens — all swept in a registered
 * teardown. Nothing touches the standing ZZ tenant.
 *
 * ── THE ENCRYPTION KEY IS THIS PROCESS'S OWN ───────────────────────────────────────────────────
 * An ephemeral 32 bytes, set below. The in-process clauses therefore prove the real rules without
 * depending on a shared secret. The SERVER has its own environment, so the one clause that needs it
 * there probes for it and FAILS with the reason rather than going green on a 503.
 */
import './_gate-preflight.mjs';
import './_ts.mjs';
const { gatePrisma, describeError, gateOrigin, affiliateOrigin, repOrigin, serverReady, onTeardown } = await import('./_gate-preflight.mjs');
const http = await import('node:http');
const { randomUUID, randomBytes } = await import('node:crypto');
const { readFileSync } = await import('node:fs');
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');

// SET BEFORE lib/payee-crypto IS FIRST CALLED. The module reads process.env on every call rather
// than caching at import, precisely so a gate can do this without depending on import order.
process.env.PAYEE_ENC_KEY = randomBytes(32).toString('base64');

const AM = await import('../lib/anchored-match.ts');
const CRYPTO = await import('../lib/payee-crypto.ts');
const PAYEE = await import('../lib/payee.ts');
const PADMIN = await import('../lib/payee-admin.ts');
const PORTAL = await import('../lib/party-portal.ts');
const PDATA = await import('../lib/affiliate-portal-data.ts');
const COPY = await import('../lib/affiliate-portal-copy.ts');
const EARN = await import('../lib/affiliate-earnings.ts');
const PUBLIC = await import('../lib/affiliate-public.ts');
const ADMIN = await import('../lib/affiliate-admin.ts');
const TERMS = await import('../lib/affiliate-terms.ts');
const PUB = await import('../lib/content-publish.ts');
const CONTENT = await import('../lib/content.ts');
const RM = await import('../lib/rep-magic-link.ts');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const src = (f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } };

const B = new URL(gateOrigin());
const AFF = affiliateOrigin();
const AFF_HOST = new URL(AFF).hostname;
const REP = repOrigin();
const REP_HOST = new URL(REP).hostname;
const APEX_HOST = B.hostname;
const RESOLVER = [
  '--host-resolver-rules=MAP affiliates.greasedesk.com 127.0.0.1,MAP reps.greasedesk.com 127.0.0.1',
];

const MARK = '@zz-affiliate-portal.invalid';
const PREFIX = `ZZAP${randomUUID().slice(0, 6).toUpperCase()}`;
const GATE_IP = '203.0.113.11';

const ask = (host, path, { method = 'GET', body, cookie } = {}) => new Promise((resolve) => {
  const headers = { Host: `${host}:${B.port}`, 'x-forwarded-for': GATE_IP };
  if (body) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(body); }
  if (cookie) headers.Cookie = cookie;
  const r = http.request({ hostname: B.hostname, port: B.port, path, method, headers }, (res) => {
    let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: b, headers: res.headers }));
  });
  r.on('error', (e) => resolve({ status: 0, body: String(e), headers: {} }));
  if (body) r.write(body);
  r.end();
});

let prisma, browser;
const made = { repIds: [], groupIds: [], docIds: [] };
/**
 * THE SETTING THIS GATE MOVES, AND NOTHING ELSE. Section 10 drops minimum_payout_pennies to 0
 * to prove a settings change cannot reach a published version. It is restored on the happy path
 * AND in the registered teardown — the trial-setting-gate incident was a sweep registered with
 * onTeardown and never called in a finally, which left an operator's own value overwritten.
 * Null means there is nothing to put back.
 */
let minimumRestore = null;

const sweep = async () => {
  if (!prisma) return 0;
  const reps = (await prisma.rep.findMany({ where: { email: { endsWith: MARK } }, select: { id: true } })).map((r) => r.id);
  const ids = [...new Set([...reps, ...made.repIds])];
  if (ids.length) {
    // ORDER MATTERS where there is no cascade. RepPayeeRequest and RepTermsAcceptance are
    // onDelete: Restrict against Rep, so the Rep delete fails while a child exists.
    await prisma.repPayeeRequest.deleteMany({ where: { rep_id: { in: ids } } }).catch(() => {});
    await prisma.repTermsAcceptance.deleteMany({ where: { rep_id: { in: ids } } }).catch(() => {});
    await prisma.repMagicLink.deleteMany({ where: { rep_id: { in: ids } } }).catch(() => {});
    await prisma.commissionEntry.deleteMany({ where: { party_id: { in: ids } } }).catch(() => {});
    await prisma.tenantAffiliateTerms.deleteMany({ where: { affiliate_id: { in: ids } } }).catch(() => {});
    await prisma.tenantAttribution.deleteMany({ where: { party_id: { in: ids } } }).catch(() => {});
    // THE AUDIT ROWS THIS GATE PROVOKES. AuditLog is append-only by standing rule and
    // SuperAdminAudit is its platform sibling — but these rows are about FIXTURE reps that are
    // about to stop existing, and target_rep_id is deliberately NOT a foreign key. Leaving them
    // would be leaving rows naming nobody; the standing rule protects the record of real acts.
    await prisma.superAdminAudit.deleteMany({ where: { target_rep_id: { in: ids } } }).catch(() => {});
    await prisma.superAdminAudit.deleteMany({ where: { actor_rep_id: { in: ids } } }).catch(() => {});
  }
  // AND THE ROWS WRITTEN UNDER THIS GATE'S SYNTHETIC OPERATOR ID. Swept by prefix rather than by
  // target, because a reveal on a rep that has already gone would otherwise leave a row naming an
  // operator that never existed.
  {
    await prisma.superAdminAudit.deleteMany({ where: { operator_user_id: { startsWith: 'ZZAP' } } }).catch(() => {});
  }
  const groups = (await prisma.group.findMany({ where: { group_name: { startsWith: 'ZZAP' } }, select: { id: true } })).map((g) => g.id);
  const gids = [...new Set([...groups, ...made.groupIds])];
  if (gids.length) {
    await prisma.user.deleteMany({ where: { group_id: { in: gids } } }).catch(() => {});
    await prisma.tenantAffiliateTerms.deleteMany({ where: { group_id: { in: gids } } }).catch(() => {});
    await prisma.tenantAttribution.deleteMany({ where: { group_id: { in: gids } } }).catch(() => {});
    await prisma.commissionEntry.deleteMany({ where: { group_id: { in: gids } } }).catch(() => {});
    await prisma.group.deleteMany({ where: { id: { in: gids } } }).catch(() => {});
  }
  if (ids.length) await prisma.rep.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
  await prisma.document.deleteMany({ where: { slug: { in: [PDATA.VIDEO_SLUG, TERMS.AFFILIATE_TERMS_SLUG] }, title: { startsWith: 'ZZAP' } } }).catch(() => {});
  if (made.docIds.length) await prisma.document.deleteMany({ where: { id: { in: made.docIds } } }).catch(() => {});
  // A LEFTOVER DRAFT WOULD BLOCK THE NEXT RUN, not merely linger: there is one draft row per slug
  // and country (the `draft` version sentinel is unique), so a gate that died mid-section would make
  // every later run fail on P2002 at the create. Swept by the sentinel, not only by tracked id.
  await prisma.document.deleteMany({
    where: { slug: TERMS.AFFILIATE_TERMS_SLUG, country_code: 'GB', version: 'draft', title: { startsWith: 'ZZAP' } },
  }).catch(() => {});
  if (minimumRestore !== null) {
    await prisma.programmeSettings.update({ where: { id: 'singleton' }, data: { minimum_payout_pennies: minimumRestore } }).catch(() => {});
    minimumRestore = null;
  }
  await prisma.authRateLimit.deleteMany({ where: { key: { startsWith: `affreq:ip:${GATE_IP}` } } }).catch(() => {});
  return ids.length;
};

try {
  prisma = await gatePrisma();
  onTeardown(sweep);
  await sweep();
  await serverReady();

  // ── 1. THE ADDRESSES, AND WHO CANNOT SEE THEM ────────────────────────────────────────────────
  console.log('\n— the portal has bare addresses on one host and exists nowhere else —');
  const signIn = await ask(AFF_HOST, PORTAL.portalSignInPath('affiliate'));
  check('the sign-in page is served on the affiliate host', signIn.status === 200, `${signIn.status}`);
  const dash = await ask(AFF_HOST, PORTAL.portalHomePath('affiliate'));
  check('  …and the dashboard sends a visitor with no session to sign in',
    dash.status === 307 && AM.urlUnder(String(dash.headers.location ?? ''), PORTAL.portalSignInPath('affiliate')),
    `${dash.status} → ${dash.headers.location}`);
  check('  …to the AFFILIATE sign-in page, not the rep one',
    !AM.urlUnder(String(dash.headers.location ?? ''), '/rep/login'),
    'one guard, two parties: sending an affiliate to /rep/login would send them to a host that 404s it');
  const internal = await ask(AFF_HOST, '/affiliate-portal/dashboard');
  check('  …and the internal folder name is NOT an address', internal.status === 404, `${internal.status}`);

  for (const [host, label] of [[APEX_HOST, 'the apex'], [REP_HOST, 'the rep host']]) {
    const r = await ask(host, PORTAL.portalHomePath('affiliate'));
    check(`  …and the dashboard 404s on ${label}`, r.status === 404, `${r.status}`);
    const a = await ask(host, '/api/affiliate-portal/request-link', { method: 'POST', body: '{}' });
    // 405 HERE WOULD BE A FINDING, not a pass: it means the route was reached. The apex answered
    // exactly that before this slice closed it, and only on the apex, because it is the one host
    // that falls through by design.
    check(`  …and the portal API 404s on ${label} (405 would mean it was reached)`, a.status === 404, `${a.status}`);
  }

  console.log('\n— and the favicon the site never had —');
  for (const icon of ['/favicon-32x32.png', '/apple-touch-icon.png', '/favicon.ico']) {
    const r = await ask(AFF_HOST, icon);
    check(`  ${icon} is served on the affiliate host`, r.status === 200, `${r.status}`);
  }
  check('  …and /public is still otherwise shut', (await ask(AFF_HOST, '/sw.js')).status === 404,
    'an exact-match set, not a prefix — a prefix here would re-open /public');

  // ── 2. THE EMAILED LINK POINTS AT THE PARTY'S OWN DOOR ───────────────────────────────────────
  console.log('\n— the link is built from the PARTY, not from the caller —');
  const affiliate = await prisma.rep.create({
    data: {
      party_type: 'affiliate', email: `aff-${randomUUID().slice(0, 8)}${MARK}`, name: `${PREFIX} Affiliate`,
      ref_code: `${PREFIX}A`, terms_accepted_at: new Date('2026-01-01T00:00:00Z'), status: 'active',
    },
    select: { id: true, email: true, ref_code: true },
  });
  made.repIds.push(affiliate.id);
  const repParty = await prisma.rep.create({
    data: { party_type: 'rep', email: `rep-${randomUUID().slice(0, 8)}${MARK}`, name: `${PREFIX} Rep`, ref_code: `${PREFIX}R`, status: 'active' },
    select: { id: true, email: true },
  });
  made.repIds.push(repParty.id);

  const affLink = await RM.mintRepLink({ repId: affiliate.id, sentTo: affiliate.email, baseUrl: AFF });
  check('an affiliate’s link lands on the affiliate portal',
    AM.urlUnder(affLink.url, '/enter') && !AM.urlUnder(affLink.url, '/rep/enter'), affLink.url);
  const repLink = await RM.mintRepLink({ repId: repParty.id, sentTo: repParty.email, baseUrl: REP });
  check('  …and a rep’s link still lands on the rep portal', AM.urlUnder(repLink.url, '/rep/enter'), repLink.url);
  check('  …and the affiliate link is actually FOLLOWABLE on its host',
    (await ask(AFF_HOST, new URL(affLink.url).pathname)).status === 200,
    'the defect this replaced produced a perfectly well-formed URL that 404d');
  let unknownParty = null;
  try { PORTAL.portalFor('tutor'); } catch (e) { unknownParty = e; }
  check('  …and an unknown party_type FAILS rather than defaulting to the rep path', !!unknownParty,
    'a credential sent to another actor class’s front door is the failure this prevents');

  // ── 3. THE GARAGES, THE LEDGER, AND WHAT THE TWO SURFACES SAY ABOUT IT ───────────────────────
  console.log('\n— one ledger, and the Engine Room and the portal agree to the penny —');
  const garage = await prisma.group.create({
    data: { group_name: `${PREFIX} Garage`, billing_email: `${PREFIX.toLowerCase()}@example.invalid`, status: 'active' },
    select: { id: true },
  });
  made.groupIds.push(garage.id);
  await prisma.user.create({
    data: { name: `${PREFIX} Owner`, email: `owner-${randomUUID().slice(0, 8)}${MARK}`, group_id: garage.id },
  });
  await prisma.tenantAffiliateTerms.create({
    data: {
      group_id: garage.id, affiliate_id: affiliate.id, total_reward_pennies: 12000,
      instalment_pennies: 3000, signed_up_at: new Date('2026-02-01T00:00:00Z'),
    },
  });

  /**
   * ONE ENTRY CARRIES THE PAY-RUN'S PRIVATE COLUMNS, and it has to be a real combination: the
   * database pairs them. CommissionEntry_hold_chk is `(status = 'held') = (held_reason IS NOT NULL)`
   * and hold_reason_chk holds the reason to four values — so "a held_reason with the default status"
   * is not a row that can exist, and a fixture that tried to plant one was refused outright.
   *
   * IT MATTERS THAT THE VALUE IS REAL AND DISTINCTIVE: section 5 asserts the page does not carry
   * 'no_visit_recorded', and a column left null in the fixture could not have leaked, which would
   * have made that clause decoration.
   *
   * The status is irrelevant to the arithmetic — earningsFrom reads kind and created_at — so holding
   * one entry does not move the figures the clauses below assert.
   */
  const mkEntry = (kind, pennies, createdAt, priv = false) => prisma.commissionEntry.create({
    data: {
      group_id: garage.id, party_type: 'affiliate', party_id: affiliate.id, period: '2026-10',
      kind, tier: 'first_12m', share_bp: 10000, amount_pennies: pennies, currency: 'GBP',
      source_ref: `${PREFIX}-${kind}-${randomUUID().slice(0, 8)}`, payment_ref: `${PREFIX}-pay`,
      created_at: createdAt,
      ...(priv ? { status: 'held', held_reason: 'no_visit_recorded', shown_as_visited: false } : {}),
    },
  });
  const matured = new Date(Date.now() - 30 * 86400000);
  const fresh = new Date(Date.now() - 2 * 86400000);
  await mkEntry('accrual', 3000, matured, true);
  await mkEntry('accrual', 3000, fresh);
  await mkEntry('clawback', -1000, matured);

  const data = await PDATA.affiliatePortalData(affiliate.id, prisma);
  check('the portal computes earned net of the reversal', data.earnings.earnedPennies === 5000, String(data.earnings.earnedPennies));
  check('  …payable is only what matured, less the reversal', data.earnings.payablePennies === 2000, String(data.earnings.payablePennies));
  check('  …and held is the rest', data.earnings.heldPennies === 3000, String(data.earnings.heldPennies));
  check('  …with a DATE for what is still held', data.held.length === 1 && /^\d{4}-\d{2}-\d{2}$/.test(data.held[0].payableFrom),
    JSON.stringify(data.held));
  check('  …and "paid" is reported as having NO RECORD, not as zero',
    data.earnings.paidRecorded === false && data.earnings.paidPennies === 0,
    'AffiliatePayout is deferred; "£0.00 paid" would be a claim about a record that does not exist');

  const listed = (await ADMIN.listAffiliates(prisma)).find((a) => a.id === affiliate.id);
  check('the Engine Room row agrees with the portal, to the penny',
    listed.earnedPennies === data.earnings.earnedPennies
    && listed.payablePennies === data.earnings.payablePennies
    && listed.heldPennies === data.earnings.heldPennies,
    `ER ${listed.earnedPennies}/${listed.payablePennies}/${listed.heldPennies} vs portal ${data.earnings.earnedPennies}/${data.earnings.payablePennies}/${data.earnings.heldPennies}`);
  // AND IT IS ONE FUNCTION, not two that happen to agree today. An independent oracle would be
  // asserting that the same code equals itself; this asserts the SHARED chokepoint is the source.
  check('  …because both read lib/affiliate-earnings', /affiliate-earnings/.test(src('lib/affiliate-admin.ts'))
    && /affiliate-earnings/.test(src('lib/affiliate-portal-data.ts')),
    'two copies of the arithmetic is how two screens come to disagree about what we owe somebody');

  check('the garage is listed by name and lifecycle status', data.garages.length === 1
    && data.garages[0].name === `${PREFIX} Garage` && data.garages[0].status === 'Paying', JSON.stringify(data.garages));
  // THE MAP IS EXHAUSTIVE OVER THE ENUM, not over the three words somebody asked for. A missing
  // value would render as "Unknown" on somebody's dashboard.
  const enumValues = ((/^enum TenantStatus \{([\s\S]*?)^\}/m.exec(readFileSync('prisma/schema.prisma', 'utf8')) ?? [])[1] ?? '')
    .split('\n').map((l) => l.trim()).filter((l) => /^[a-z_]+$/.test(l));
  check('  …and every TenantStatus the enum allows has a label',
    enumValues.length >= 4 && enumValues.every((v) => !!PDATA.GARAGE_STATUS_LABEL[v]),
    `${enumValues.join(', ')} → ${enumValues.map((v) => PDATA.GARAGE_STATUS_LABEL[v] ?? 'MISSING').join(', ')}`);

  // Needed by section 4c below, read here while the fixtures are in scope.
  const staffEmailEarly = (await prisma.user.findFirst({ where: { group_id: garage.id }, select: { email: true } })).email;

  // ── 4. SIGNING IN, AND WHAT THE PAGE ACTUALLY SHOWS ──────────────────────────────────────────
  console.log('\n— and a real browser gets in and reads it —');
  browser = await chromium.launch({ channel: 'chrome', args: RESOLVER });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 200)));

  const live = await RM.mintRepLink({ repId: affiliate.id, sentTo: affiliate.email, baseUrl: AFF });
  await page.goto(live.url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="affiliate-enter"]');
  check('the landing page runs without throwing', pageErrors.length === 0,
    pageErrors[0] ?? 'no uncaught error — a server-only import reaching the bundle shows up HERE');
  await page.click('[data-testid="affiliate-enter"]');
  await page.waitForSelector('[data-testid="affiliate-home"]');
  check('  …and the link signs the affiliate in', AM.urlUnder(page.url(), PORTAL.portalHomePath('affiliate')), page.url());
  check('  …with the dashboard running clean too', pageErrors.length === 0, pageErrors[0] ?? 'still no uncaught error');

  const html = await page.content();
  check('the code is on the page', html.includes(affiliate.ref_code));
  check('  …and the link that carries it', html.includes(`ref=${affiliate.ref_code}`));
  const qrSrc = (await page.locator('[data-testid="affiliate-qr"]').getAttribute('src')) ?? '';
  // @anchored-ok: a data-URL SCHEME prefix on an attribute value, not a property key or a path
  const qrIsServerBuilt = /^data:image\/png;base64,/.test(qrSrc);
  check('  …and a QR built on the server',
    (await page.locator('[data-testid="affiliate-qr"]').count()) === 1 && qrIsServerBuilt,
    'a client-rendered QR would make the poster depend on JS for the one thing it exists to carry');
  check('  …the four figures are rendered', ['earn-earned', 'earn-held', 'earn-payable', 'earn-paid']
    .every((t) => html.includes(t)));
  check('  …and "paid" reads as no record rather than £0.00',
    /No payouts yet/.test(await page.locator('[data-testid="earn-paid"]').innerText()),
    await page.locator('[data-testid="earn-paid"]').innerText());
  check('  …the cadence sentence is the owner’s, verbatim',
    (await page.locator('[data-testid="affiliate-cadence"]').innerText()).trim() === COPY.PAYOUT_CADENCE);
  check('  …and the minimum comes from the settings',
    /£\d/.test(await page.locator('[data-testid="affiliate-minimum"]').innerText()),
    await page.locator('[data-testid="affiliate-minimum"]').innerText());
  check('  …the garage is listed with its status', /Paying/.test(await page.locator('[data-testid="affiliate-garages"]').innerText()));
  check('  …four how-it-works steps', (await page.locator('[data-testid="affiliate-how-section"] ol > li').count()) === 4);
  check('  …and the poster is one click away', (await page.locator('[data-testid="affiliate-poster-link"]').count()) === 1);

  // ── 4b. THE POSTER, WHICH IS THE ONE PAGE THAT OWNS A PAPER SIZE ─────────────────────────────
  console.log('\n— and the printable sheet carries the same code and the same offer —');
  const cookiesEarly = await ctx.cookies();
  const sessEarly = cookiesEarly.find((c) => /next-auth\.session-token/.test(c.name));
  const jarEarly = `${sessEarly.name}=${sessEarly.value}`;
  const servedEarly = await ask(AFF_HOST, PORTAL.portalHomePath('affiliate'), { cookie: jarEarly });
  const poster = await ask(AFF_HOST, '/poster', { cookie: jarEarly });
  check('the poster is served to a signed-in affiliate', poster.status === 200, `${poster.status}`);
  check('  …and refused to a visitor with no session',
    (await ask(AFF_HOST, '/poster')).status === 307, 'it carries their code, so it is not public');
  check('  …it carries the code', poster.body.includes(affiliate.ref_code));
  check('  …and the link, so a phone without a camera still has a way in', poster.body.includes(`ref=${affiliate.ref_code}`));
  /**
   * THE CLAIM IS THAT IT IS BIGGER, so that is what is asserted — not that a QR is present, which a
   * 1x1 would satisfy. The first attempt looked for a data URL within 200 characters of the testid
   * and went red on correct code: the `src` attribute comes BEFORE data-testid in the markup, and a
   * 1200px PNG is tens of kilobytes, so that window could never have contained it.
   */
  // @anchored-ok: extracts data-URL PAYLOADS to compare their byte length; not a key or a path
  const biggest = (body) => (body.match(/data:image\/png;base64,[A-Za-z0-9+/=]+/g) ?? [])
    .reduce((n, m) => Math.max(n, m.length), 0);
  check('  …a QR big enough to print, built on the server',
    poster.body.includes('poster-qr') && biggest(poster.body) > 0, `${biggest(poster.body)} base64 characters`);
  check('    …and bigger than the one on the dashboard', biggest(poster.body) > biggest(servedEarly.body),
    `poster ${biggest(poster.body)} vs dashboard ${biggest(servedEarly.body)} — 1200px against 480px`)
  check('  …and it is sized in millimetres for A4, not in pixels',
    /@page\s*\{\s*size:\s*A4/.test(poster.body) && /210mm/.test(poster.body),
    'a poster has to come out of whatever printer is in the office');
  check('  …with the print button hidden from the print itself',
    /@media print[\s\S]{0,120}no-print/.test(poster.body));
  check('  …and the offer line comes from the SAME copy the dashboard shows',
    poster.body.includes(String(data.howItWorks[1].body.split('.')[0])),
    'a poster promising a different offer from the page that produced it is found when a garage quotes it back');

  // ── 4c. THE PAYEE FORM, THROUGH THE REAL ROUTE ───────────────────────────────────────────────
  console.log('\n— and the payee route refuses before it encrypts anything —');
  check('the form is on the dashboard', (await page.locator('[data-testid="payee-form"]').count()) === 1);
  check('  …and says WHY a person checks it',
    /checked by a person/.test(await page.locator('[data-testid="affiliate-payee-section"]').innerText()),
    'an unexplained delay reads as a fault');
  const noSession = await ask(AFF_HOST, '/api/affiliate-portal/payee', { method: 'POST', body: JSON.stringify({ payeeKind: 'self' }) });
  check('  …a post with no session is 404, not 401', noSession.status === 404,
    `${noSession.status} — 401 would confirm the endpoint exists`);
  const badSort = await ask(AFF_HOST, '/api/affiliate-portal/payee', {
    method: 'POST', cookie: jarEarly,
    body: JSON.stringify({ payeeKind: 'self', accountName: 'A Person', sortCode: '200', accountNumber: '12345678' }),
  });
  check('  …a five-digit sort code is refused by the ROUTE, with the sentence',
    badSort.status === 400 && /sort code/i.test(badSort.body), `${badSort.status} ${badSort.body.slice(0, 80)}`);
  const staffPost = await ask(AFF_HOST, '/api/affiliate-portal/payee', {
    method: 'POST', cookie: jarEarly,
    body: JSON.stringify({ payeeKind: 'nominee', accountName: 'A Person', sortCode: '200000', accountNumber: '12345678', nomineeEmail: staffEmailEarly }),
  });
  check('  …and a nominee at a garage they introduced is refused by the route too',
    staffPost.status === 400 && /garage you introduced/.test(staffPost.body),
    `${staffPost.status} ${staffPost.body.slice(0, 80)}`);
  // THE SUCCESS PATH NEEDS THE SERVER'S OWN KEY, which this process cannot set. It is reported
  // asserted on its own terms: a clause that passed on 200-or-503 would be vacuous, and an absent
  // key is reported as an absent key rather than as a defect in the route.
  const good = await ask(AFF_HOST, '/api/affiliate-portal/payee', {
    method: 'POST', cookie: jarEarly,
    body: JSON.stringify({ payeeKind: 'self', accountName: 'Served Payee', sortCode: '200000', accountNumber: '87654321' }),
  });
  /**
   * A MISSING KEY IS A RED, NOT A PRINTED NOTE.
   *
   * While the key was absent this printed a line and carried on, which is a silent skip wearing a
   * circle: the gate reported "0 failures of 143" while the one path that actually stores a bank
   * detail had never been exercised. declineToRun is the project's idiom for an unmet premise, but
   * called from here it exits at once and would discard the hundred clauses that follow — one absent
   * environment variable hiding the whole gate is the worse trade.
   *
   * So it fails, and the message says plainly that this is the environment rather than the code: a
   * red that sends somebody hunting through the route costs an hour for nothing.
   */
  if (good.status === 503) {
    check('the dev server has a usable PAYEE_ENC_KEY', false,
      'the route answered 503, which is it REFUSING to store a bank detail it cannot encrypt — correct '
      + 'behaviour, and it means this environment cannot prove the submit path. Not a defect in the '
      + 'route: put PAYEE_ENC_KEY (base64 of 32 bytes) in .env and RESTART the dev server, which reads '
      + '.env at startup.');
  } else {
    check('  …and a good one is stored, encrypted, as a pending request', good.status === 200
      && (await prisma.repPayeeRequest.count({ where: { rep_id: affiliate.id, status: 'pending', account_last4: '4321' } })) === 1,
      `${good.status} ${good.body.slice(0, 80)}`);
    const stored = await prisma.repPayeeRequest.findFirst({
      where: { rep_id: affiliate.id, account_last4: '4321' }, select: { sort_code_enc: true },
    });
    check('    …with the digits never stored in clear', !!stored && CRYPTO.isPayeeEncrypted(stored.sort_code_enc)
      && !stored.sort_code_enc.includes('200000'), stored?.sort_code_enc.slice(0, 18));
  }

  // ── 5. WHAT THE SERVED HTML MUST NOT CARRY ───────────────────────────────────────────────────
  console.log('\n— and the page withholds what it was never given —');
  /**
   * ── A HARD NAVIGATION, AND THAT IS THE WHOLE REASON THIS CLAUSE WORKS ───────────────────────
   * The HTML read above came after a CLIENT-SIDE router.push from the sign-in page, so it is the
   * rendered DOM and nothing more: the dashboard's props were never serialised into __NEXT_DATA__
   * on that document. A withholding clause read from it can only catch a leak that RENDERS, and a
   * leaked prop that no component displays would sail past it.
   *
   * Measured, not reasoned about: with the private columns selected AND the raw rows passed into
   * the props, this section stayed green through two separate red-proof attempts. The clause could
   * not reach what it claimed to be guarding.
   *
   * So the page is fetched again, properly, and __NEXT_DATA__ comes with it. Both are asserted —
   * the server-rendered document for the props, and the live DOM for what a person can see.
   */
  const served = servedEarly; // fetched in section 4b; one request, two sections
  check('the dashboard is server-rendered for a signed-in affiliate', served.status === 200, `${served.status}`);
  check('  …and its props really are in the document',
    served.body.includes('__NEXT_DATA__') && served.body.includes(affiliate.ref_code),
    'if this is false the clauses below are reading the wrong thing');
  for (const banned of ['held_reason', 'release_override_reason', 'shown_as_visited']) {
    check(`  the pay-run's private assessment is absent from the PROPS: ${banned}`, !served.body.includes(banned),
      'a leaked prop no component renders is invisible to a DOM-only clause');
    check(`    …and from the rendered page: ${banned}`, !html.includes(banned));
  }
  // …AND ONE REAL VALUE, planted on a real held row, so this is not a clause about key names alone.
  check('  …including the planted hold REASON itself, in both places',
    !html.includes('no_visit_recorded') && !served.body.includes('no_visit_recorded'),
    'an affiliate must not read the area manager\u2019s assessment of a rep from their own page');
  check('  …and the dashboard is noindex', /noindex/.test(html));

  // ── 6. THE POSTS CARRY THEIR LABEL STRUCTURALLY ──────────────────────────────────────────────
  console.log('\n— every ready-made post is labelled, and not by somebody remembering —');
  const posts = COPY.socialPosts({ referralLink: 'https://example.invalid/r', monthsGiven: 12, monthsPaid: 8 });
  check('there are three posts', posts.length === 3);
  check('  …and every one STARTS with the label', posts.every((p) => p.text.startsWith(COPY.AD_LABEL)),
    posts.map((p) => p.text.slice(0, 6)).join(' | '));
  check('  …and none of them quotes a price', posts.every((p) => !/£/.test(p.text)),
    'the offer is in months, which the frozen terms guarantee; a pound figure would be the affiliate’s promise');
  check('  …and the label is attached in ONE place',
    (src('lib/affiliate-portal-copy.ts').match(/AD_LABEL/g) ?? []).length >= 2
    && !/#ad/.test(src('lib/affiliate-portal-copy.ts').split('const labelled')[1] ?? ''),
    'a literal #ad inside each post is one edit away from being dropped from one of them');
  check('  …and the page shows them with copy buttons',
    (await page.locator('[data-testid^="affiliate-copy-post-"]').count()) === 3);

  // ── 7. WHO WE MAY BE ASKED TO PAY ────────────────────────────────────────────────────────────
  console.log('\n— the refusals on a proposed payee —');
  const base = { payeeKind: 'self', accountName: 'A Person', sortCode: '20-00-00', accountNumber: '12345678' };
  check('a good proposal is accepted', PAYEE.refusePayee(base) === null, String(PAYEE.refusePayee(base)));
  check('  …a five-digit sort code is refused', !!PAYEE.refusePayee({ ...base, sortCode: '20000' }));
  check('  …a seven-digit account number is refused', !!PAYEE.refusePayee({ ...base, accountNumber: '1234567' }));
  check('  …all zeros is refused', !!PAYEE.refusePayee({ ...base, accountNumber: '00000000' }),
    'a plausible placeholder reaching a pay run is worse than a blank one');
  check('  …an unknown payee kind is refused', !!PAYEE.refusePayee({ ...base, payeeKind: 'the_garage' }));
  check('  …and a nominee with no address is refused', !!PAYEE.refusePayee({ ...base, payeeKind: 'nominee', nomineeEmail: '' }));
  check('  …while the refusal is a sentence for the person typing',
    /sort code/i.test(String(PAYEE.refusePayee({ ...base, sortCode: '1' }))),
    String(PAYEE.refusePayee({ ...base, sortCode: '1' })));

  const staffEmail = (await prisma.user.findFirst({ where: { group_id: garage.id }, select: { email: true } })).email;
  const staffRefusal = await PAYEE.refuseNomineeIsReferredStaff(prisma, { affiliateId: affiliate.id, nomineeEmail: staffEmail });
  check('a nominee who works at a garage they introduced is REFUSED', !!staffRefusal, String(staffRefusal));
  check('  …and the refusal does not name the garage', !/(ZZAP\w* Garage)/.test(String(staffRefusal)),
    'which of their referrals that address belongs to is a question about somebody else’s staff list');
  check('  …a stranger is not refused',
    (await PAYEE.refuseNomineeIsReferredStaff(prisma, { affiliateId: affiliate.id, nomineeEmail: `nobody${MARK}` })) === null);

  // ── 8. PROPOSE, APPLY, REVEAL ────────────────────────────────────────────────────────────────
  console.log('\n— the affiliate proposes, the owner applies, and applying opens nothing —');
  const clean = PAYEE.normalisedPayee({ ...base, accountName: 'Pay Ee' });
  const request = await prisma.repPayeeRequest.create({
    data: {
      rep_id: affiliate.id, payee_kind: clean.payeeKind, account_name: clean.accountName,
      sort_code_enc: CRYPTO.encryptPayee(clean.sortCode),
      account_number_enc: CRYPTO.encryptPayee(clean.accountNumber),
      account_last4: CRYPTO.payeeLast4(clean.accountNumber), status: 'pending',
    },
    select: { id: true, sort_code_enc: true, account_number_enc: true },
  });
  check('the stored sort code is ciphertext', CRYPTO.isPayeeEncrypted(request.sort_code_enc)
    && !request.sort_code_enc.includes(clean.sortCode), request.sort_code_enc.slice(0, 18) + '…');
  check('  …and so is the account number', CRYPTO.isPayeeEncrypted(request.account_number_enc)
    && !request.account_number_enc.includes(clean.accountNumber));

  /**
   * A SYNTHETIC OPERATOR ID, AND NO Operator ROW IS CREATED.
   *
   * Both columns that record who decided — RepPayeeRequest.decided_by and
   * SuperAdminAudit.operator_user_id — are plain String? and deliberately NOT foreign keys, so a
   * marked id is enough to exercise them. It is also strictly safer than the alternative: the gate
   * suite has already cost three minutes of two live operator accounts on production, one of them an
   * owner, because a teardown was registered and never called. A fixture that does not exist cannot
   * be left behind.
   *
   * NOT null, which would exercise the platform-acted sentinel instead of an operator's decision —
   * a different case from the one these clauses are about.
   */
  const operator = { id: `${PREFIX}-operator-${randomUUID().slice(0, 8)}` };
  const applied = await PADMIN.applyPayeeRequest(prisma, { requestId: request.id, operatorUserId: operator.id });
  check('the owner applies it', applied.ok === true, JSON.stringify(applied));
  const afterApply = await prisma.rep.findUnique({
    where: { id: affiliate.id },
    select: { bank_sort_code: true, bank_account_number: true, bank_account_last4: true, bank_account_name: true },
  });
  check('  …and the CIPHERTEXT moved across unopened',
    afterApply.bank_sort_code === request.sort_code_enc && afterApply.bank_account_number === request.account_number_enc,
    'applying must not need the key: that is what keeps the audit log free of reveals nobody made');
  check('  …with the last four in clear beside it', afterApply.bank_account_last4 === '5678', String(afterApply.bank_account_last4));
  check('  …all four columns together', !!afterApply.bank_sort_code && !!afterApply.bank_account_number
    && !!afterApply.bank_account_last4 && !!afterApply.bank_account_name,
    'Rep_bank_chk holds three of them; one writer holds the fourth in step');
  check('  …and no row anywhere carries a last four without the three',
    (await prisma.rep.count({ where: { NOT: { bank_account_last4: null }, bank_sort_code: null } })) === 0,
    'the pairing the CHECK deliberately does not enforce, asserted instead');
  check('  …and applying it twice is refused',
    (await PADMIn_safe(request.id, operator?.id ?? null)).ok === false, 'a second apply would be a second answer');

  const revealed = await PADMIN.revealPayee(prisma, { repId: affiliate.id, operatorUserId: operator.id });
  check('a reveal produces the digits', revealed.ok === true && revealed.value.accountNumber === clean.accountNumber,
    revealed.ok ? 'returned' : revealed.message);
  check('  …formatted for a person reading a bank screen', revealed.ok && revealed.value.sortCode === '20-00-00',
    revealed.ok ? revealed.value.sortCode : '');
  const look = await prisma.superAdminAudit.findFirst({
    where: { target_rep_id: affiliate.id, action: 'rep.bank_viewed' },
    select: { id: true, detail: true, target_ref_snapshot: true },
  });
  check('  …and the LOOK is recorded', !!look, 'the audit question here is who looked, not what changed');
  check('  …without the digits in the audit row',
    !!look && !JSON.stringify(look).includes(clean.accountNumber) && !JSON.stringify(look).includes(clean.sortCode),
    'an audit row is read by somebody looking at something else');

  const noneHeld = await PADMIN.revealPayee(prisma, { repId: repParty.id, operatorUserId: operator.id });
  check('  …and "we hold none" is reported as that, not as a failure to read',
    noneHeld.ok === false && noneHeld.code === 'none_held', JSON.stringify(noneHeld));

  // ── 9. THE VIDEOS ────────────────────────────────────────────────────────────────────────────
  console.log('\n— video slots the owner fills, and an empty one is absent —');
  check('the section is absent when nothing is published', data.videos.length === 0
    && !(await page.locator('[data-testid="affiliate-videos-section"]').count()),
    'an empty frame promises something nobody committed to');
  const doc = await prisma.document.create({
    data: {
      slug: PDATA.VIDEO_SLUG, title: `ZZAP Videos`, type: 'page', country_code: 'GB',
      body: '- [How to share your link](https://example.invalid/one)\n\nsome prose that is not a slot\n- [not a link]\n- [Reading your rewards](https://example.invalid/two)\n',
      version: '2026-10-31', status: 'published', published_at: new Date(),
    },
    select: { id: true },
  });
  made.docIds.push(doc.id);
  const parsed = PDATA.parseVideoList('- [A](https://x.invalid/a)\n- [B](http://x.invalid/b)\n- [bad](javascript:alert(1))\n- nonsense\n');
  check('one line per video, and only a real http(s) link', parsed.length === 2 && parsed[0].title === 'A',
    JSON.stringify(parsed));
  // @anchored-ok: a URL SCHEME in a parsed link, not a property key — the point is that it is REFUSED
  const anyScriptUrl = parsed.some((v) => /javascript:/i.test(v.url));
  check('  …a javascript: url is not a video', !anyScriptUrl);
  const withVideos = await PDATA.affiliatePortalData(affiliate.id, prisma);
  check('  …and the published document fills the slots', withVideos.videos.length === 2
    && withVideos.videos[0].title === 'How to share your link', JSON.stringify(withVideos.videos));
  check('  …prose between them is ignored rather than guessed at',
    !withVideos.videos.some((v) => /prose/.test(v.title)));
  await page.reload({ waitUntil: 'domcontentloaded' });
  check('  …and the section appears on the page once it has something in it',
    (await page.locator('[data-testid="affiliate-videos-section"]').count()) === 1);
  check('  …as titled links, because the renderer passes no iframes',
    !/iframe/i.test(await page.locator('[data-testid="affiliate-videos-section"]').innerHTML()),
    'react-markdown without rehype-raw renders HTML as inert text — widening it for embeds is a decision, not a nicety');

  // ── 10. THE TERMS: BAKED AT PUBLISH, LITERAL FOR EVER AFTER ──────────────────────────────────
  console.log('\n— the terms are a document, and a published version never changes under it —');
  const summary = await ask(AFF_HOST, '/terms');
  check('before anything is published, /terms still answers', summary.status === 200, `${summary.status}`);
  check('  …with the settled summary, which says so', /being finalised/.test(summary.body),
    'no placeholder prose pretending to be final, and no 404 either');

  /**
   * ── THE DRAFT CARRIES PLACEHOLDERS. PUBLISHING IS WHAT RESOLVES THEM ───────────────────────
   * Driven through lib/content-publish::publishDraft — the same function the Engine Room button
   * calls — rather than by writing a published row directly. A clause that inserts the finished
   * article proves the renderer and nothing about the publish.
   *
   * The draft deliberately contains ONE placeholder nothing can resolve, so the refusal is tested
   * before the success is.
   */
  const draftBody = [
    '# ZZAP Affiliate terms',
    '',
    'You earn up to {{totalReward}}, or {{instalment}} for each of {{paidMonths}} paid months.',
    'Held for {{holdDays}} days. {{minimumPayoutSentence}}The first payouts are in December 2026.',
    'A garage gets {{monthsGiven}} for the price of {{monthsPaid}}: {{offerPrice}} instead of {{renewalPrice}}.',
    'Trial: {{trialDays}} days. Us: {{legalName}} ({{companyNumber}}).',
    '',
    'And one nobody can resolve: {{nonsenseFigure}}',
  ].join('\n');
  const draft = await prisma.document.create({
    data: {
      slug: TERMS.AFFILIATE_TERMS_SLUG, title: 'ZZAP Affiliate terms', type: 'legal', country_code: 'GB',
      body: draftBody, version: CONTENT.DRAFT, status: 'draft',
    },
    select: { id: true },
  });
  made.docIds.push(draft.id);

  // READ BEFORE ANYTHING IS PUBLISHED, because the clauses about the FIRST version are about the
  // minimum that was in force when it was baked — not whatever the gate sets later.
  const minStart = (await prisma.programmeSettings.findUnique({ where: { id: 'singleton' }, select: { minimum_payout_pennies: true } })).minimum_payout_pennies;
  const refused = await PUB.publishDraft(prisma, { id: draft.id, effectiveFrom: '2026-10-31' });
  check('a draft with an unresolvable figure is REFUSED, not published',
    refused.ok === false && refused.code === 'unresolved_figure', JSON.stringify(refused).slice(0, 120));
  check('  …and the refusal NAMES the placeholder', !refused.ok && /\{\{nonsenseFigure\}\}/.test(refused.message),
    'an immutable version cannot be corrected afterwards, so the refusal has to be actionable now');
  check('  …and nothing was written', (await prisma.document.findUnique({ where: { id: draft.id }, select: { status: true } })).status === 'draft');

  await prisma.document.update({
    where: { id: draft.id },
    data: { body: draftBody.replace('\nAnd one nobody can resolve: {{nonsenseFigure}}', '') },
  });
  const legalNoDate = await PUB.publishDraft(prisma, { id: draft.id, effectiveFrom: null });
  check('a legal version with no effective date is refused',
    legalNoDate.ok === false && legalNoDate.code === 'needs_effective_from', JSON.stringify(legalNoDate).slice(0, 90));

  const pub1 = await PUB.publishDraft(prisma, { id: draft.id, effectiveFrom: '2026-10-31' });
  check('and then it publishes', pub1.ok === true && pub1.baked === true, JSON.stringify(pub1).slice(0, 120));
  const stored1 = await prisma.document.findUnique({ where: { id: draft.id }, select: { body: true, version: true } });
  check('  …with NO placeholder left in the stored body', !TERMS.hasPlaceholder(stored1.body),
    'the whole point: what is stored is what was agreed to');
  check('  …and the figures actually in it', stored1.body.includes('£120') && stored1.body.includes('£30')
    && stored1.body.includes('14 days') && stored1.body.includes('GreaseDesk Ltd'), stored1.body.split('\n')[2]);
  /**
   * THE FIGURES COME FROM THE SETTINGS, NOT FROM LITERALS. minimum_payout_pennies and the hold are
   * both things the owner can legitimately move, and a clause pinned to £100 or to "14 days" goes
   * red about the code on the day he does — which is the defect property-gate discipline exists to
   * prevent: pin the RULE, not the number.
   */
  const minLabel = PUBLIC.programmeMoney(minStart);
  const holdPhrase = `Held for ${EARN.AFFILIATE_HOLD_DAYS} days.`;
  check('  …including the minimum-payout sentence, while there is a minimum',
    stored1.body.includes(`The minimum payout is ${minLabel};`), stored1.body.split('\n')[3]);
  /**
   * THE JUNCTION WITH THE SENTENCE PRESENT — the half the first version of this gate missed.
   * The spacing clause further down covers the OMITTED case ("Held for 14 days. The first payouts"),
   * and dropping the trailing space from the non-empty value reddened nothing, because that case was
   * never asserted. It is the present case that runs the two sentences together.
   */
  check('    …with a space between it and the sentence that follows',
    /next run\. The first payouts/.test(stored1.body) && !/run\.The first/.test(stored1.body),
    stored1.body.split('\n')[3]);
  check('  …and the hold read from the constant, not typed into the prose',
    stored1.body.includes(holdPhrase), holdPhrase);
  check('  …and one money format throughout, not £120 beside £100.00',
    !/£\d+\.00/.test(stored1.body), 'both were correct and visibly inconsistent until the dry run printed them together');

  const served1 = await ask(AFF_HOST, '/terms');
  check('the page serves the published document, not the summary',
    served1.status === 200 && /ZZAP Affiliate terms/.test(served1.body) && !/being finalised/.test(served1.body));
  /**
   * NAMED PLACEHOLDERS, NOT `{{`. A bare brace test matched the i18n locale bundle every page
   * embeds — "Reminders and offers from {{garage}}" — so it would have gone red on correct code and
   * told whoever read it that the terms page was broken. The term has to be unique to its subject:
   * these are THIS document's placeholders, and nothing else in the app has them.
   */
  const OWN_PLACEHOLDERS = ['{{totalReward}}', '{{minimumPayoutSentence}}', '{{holdDays}}', '{{legalName}}'];
  check('  …rendering the stored text VERBATIM',
    served1.body.includes('£120') && OWN_PLACEHOLDERS.every((ph) => !served1.body.includes(ph)),
    `render-time substitution is gone — ${OWN_PLACEHOLDERS.filter((ph) => served1.body.includes(ph)).join(', ') || 'none of this document\u2019s placeholders survived'}`);

  /**
   * ── THE BOARDED DEFECT, AS A CLAUSE: A SETTINGS CHANGE MUST NOT REACH A PUBLISHED VERSION ──
   * This is what baking was for. Before it, moving minimum_payout_pennies rewrote the text of an
   * already-published version, so the stamp an affiliate accepted no longer identified the words.
   */
  const minBefore = minStart; // read before the first publish; see the note there
  minimumRestore = minBefore;
  await prisma.programmeSettings.update({ where: { id: 'singleton' }, data: { minimum_payout_pennies: 0 } });
  const stored2 = await prisma.document.findUnique({ where: { id: draft.id }, select: { body: true } });
  check('a settings change does NOT change the published version',
    stored2.body === stored1.body && /The minimum payout is £100;/.test(stored2.body),
    'the version stamp an affiliate accepted has to keep identifying the same words');
  const served2 = await ask(AFF_HOST, '/terms');
  check('  …nor what the page serves for it', /The minimum payout is £100;/.test(served2.body),
    'a render-time substitution would have silently dropped the sentence from a published version');

  /**
   * AND A NEW VERSION PICKS THE CHANGE UP — including the OMISSION, which is the owner's rule:
   * a minimum of zero means there is no minimum, and "The minimum payout is £0" reads as a rule.
   */
  const draft2 = await prisma.document.create({
    data: {
      slug: TERMS.AFFILIATE_TERMS_SLUG, title: 'ZZAP Affiliate terms', type: 'legal', country_code: 'GB',
      body: draftBody.replace('\nAnd one nobody can resolve: {{nonsenseFigure}}', ''), version: CONTENT.DRAFT, status: 'draft',
    },
    select: { id: true },
  });
  made.docIds.push(draft2.id);
  const pub2 = await PUB.publishDraft(prisma, { id: draft2.id, effectiveFrom: '2026-11-01' });
  check('a new version, same prose, is NOT refused as a no-op after a settings change',
    pub2.ok === true, JSON.stringify(pub2).slice(0, 140));
  check('  …because the comparison is against the BAKED body, not the draft',
    /refuseIdenticalPublish\(body,/.test(src('lib/content-publish.ts')),
    'comparing the draft would refuse exactly the case a settings change creates');
  const stored3 = await prisma.document.findUnique({ where: { id: draft2.id }, select: { body: true, version: true } });
  check('  …and with no minimum, the SENTENCE IS OMITTED', !/minimum payout/i.test(stored3.body),
    stored3.body.split('\n')[3]);
  check('    …leaving the two sentences correctly spaced',
    stored3.body.includes(`${holdPhrase} The first payouts`),
    'the omitted value carries its own trailing space, so nothing has to collapse whitespace afterwards');
  check('  …and it is a different version from the first', stored3.version !== stored1.version,
    `${stored1.version} then ${stored3.version}`);

  await prisma.programmeSettings.update({ where: { id: 'singleton' }, data: { minimum_payout_pennies: minBefore } });
  minimumRestore = null;

  // ── AND WHAT AN ACCEPTANCE RECORDS ───────────────────────────────────────────────────────────
  const accepted = await TERMS.recordTermsAcceptance(prisma, { repId: affiliate.id, version: stored1.version, documentId: draft.id });
  check('an acceptance records WHICH version', accepted === true
    && (await prisma.repTermsAcceptance.count({ where: { rep_id: affiliate.id, version: stored1.version } })) === 1);
  check('  …and with nothing published, nothing is invented',
    (await TERMS.recordTermsAcceptance(prisma, { repId: repParty.id, version: null })) === false
    && (await prisma.repTermsAcceptance.count({ where: { rep_id: repParty.id } })) === 0,
    'writing today’s date would reference a document that does not exist');
  check('  …and the record is append-only, so a second acceptance does not overwrite the first',
    await (async () => {
      await TERMS.recordTermsAcceptance(prisma, { repId: affiliate.id, version: stored3.version, documentId: draft2.id });
      return (await prisma.repTermsAcceptance.count({ where: { rep_id: affiliate.id } })) === 2;
    })(), 'a terms_version column would have erased what the first acceptance was to');
  check('  …so two affiliates on two versions are distinguishable for ever',
    stored1.version !== stored3.version
    && (await prisma.repTermsAcceptance.count({ where: { rep_id: affiliate.id, version: stored1.version } })) === 1,
    'which is only true because the published bodies are literal');

  // ── THE SOURCE FILE AND THE SCRIPT THAT PUTS IT IN ───────────────────────────────────────────
  const source = src('content/affiliate-terms-v1.md');
  check('the real terms are a file in the repository', source.length > 4000, `${source.length} characters`);
  check('  …carrying placeholders rather than typed figures',
    TERMS.hasPlaceholder(source) && !/£120|£600|£750/.test(source),
    'a figure typed into the prose is one that can disagree with the programme');
  const srcFigures = await TERMS.termsFigures(prisma);
  const srcBaked = TERMS.bakeFigures(source, srcFigures);
  check('  …and every one of them resolves', srcBaked.unfilled.length === 0, srcBaked.unfilled.join(', ') || 'none unresolved');
  check('  …so the real document would publish rather than be refused',
    TERMS.refuseUnbaked(srcBaked.unfilled) === null);
  check('  …and its baked text carries the figures a reader checks',
    srcBaked.body.includes('£120') && srcBaked.body.includes('12 months for the price of 8')
    && srcBaked.body.includes('£600 instead of £750'), 'section 3 and section 4, from settings');

  // ── 11. THE OTHER PARTY'S DOOR IS SHUT, WITH A REAL SESSION ──────────────────────────────────
  console.log('\n— and an affiliate session reaches nothing of the rep’s —');
  /**
   * ── THE COOKIE IS FORCED ACROSS, AND THAT IS THE POINT OF THE CLAUSE ────────────────────────
   * The first version of this drove a browser to reps.greasedesk.com and asserted a 404. It failed,
   * and the code was right: NextAuth's cookies are HOST-ONLY, so the browser never sent the
   * affiliate's session to the rep host at all — what it measured was the rep SIGN-IN page served
   * to a visitor with no session, which is correct behaviour and nothing to do with parties.
   *
   * Host-only cookies are the first line of defence, and rep-auth-gate already asserts it. This
   * clause is about the SECOND line: if that cookie ever did arrive — a Domain attribute added by
   * mistake, a proxy rewriting Host, a future shared-origin decision — the guard itself must still
   * refuse. So the cookie is lifted out of the browser and sent by hand, which is the only way to
   * put the guard under the condition it exists for.
   */
  const cookies = await ctx.cookies();
  const sessionCookie = cookies.find((c) => /next-auth\.session-token/.test(c.name));
  check('the affiliate really has a session cookie to carry', !!sessionCookie,
    sessionCookie ? `${sessionCookie.name} on ${sessionCookie.domain}` : 'no session cookie found');
  check('  …and it is host-only to the affiliate host',
    !!sessionCookie && !String(sessionCookie.domain).startsWith('.'),
    `${sessionCookie?.domain} — a leading dot would send it to every greasedesk.com host`);
  const jar = `${sessionCookie.name}=${sessionCookie.value}`;
  const forced = await ask(REP_HOST, '/rep', { cookie: jar });
  check('  …and even FORCED onto the rep host, the guard 404s it', forced.status === 404,
    `${forced.status} — both parties carry actorClass 'rep', so only party_type tells them apart`);
  check('  …rather than redirecting it to a sign-in page',
    !AM.urlUnder(String(forced.headers.location ?? ''), '/rep/login'),
    '"wrong party" must be indistinguishable from "nothing here", or the refusal names the other portal');
  /**
   * TWO ROUTES, CHOSEN SO THE GUARD IS WHAT ANSWERS. The first attempt asked /api/rep/prospects and
   * got 405: that route checks the METHOD before the guard, so the refusal was "wrong verb" and the
   * clause proved nothing about parties. prospect-matches takes GET and guards after it;
   * invoice-pdf guards before anything else. Between them the guard is reached either way.
   */
  for (const route of ['/api/rep/prospect-matches', '/api/rep/invoice-pdf']) {
    const r = await ask(REP_HOST, route, { cookie: jar });
    check(`  …and ${route} refuses it too`, r.status === 404,
      `${r.status} — 405 here would mean the method check answered, not the guard`);
  }

  // THE SHAPE, not just the outcome. lib/rep-auth cannot be imported in a gate process — it pulls
  // in pages/api/auth/[...nextauth], whose CredentialsProvider call throws under the TS loader — so
  // the guard's shape is read rather than called.
  const authSrc = src('lib/rep-auth.ts');
  check('  …and both directions go through ONE party-aware predicate',
    /requirePartyPage/.test(authSrc) && (authSrc.match(/partyOf/g) ?? []).length >= 3,
    'a one-sided check would leave the other portal open');
  check('  …with named affiliate guards, so a page cannot pass the wrong party by typo',
    /export const requireAffiliatePage/.test(authSrc) && /export const requireAffiliateApi/.test(authSrc));
  check('  …and requireRepPage no longer answers without asking the party',
    /requirePartyPage\(ctx, 'rep'\)/.test(authSrc),
    'it used to classify the session and return, so an affiliate cookie would have passed')

  // ── 12. THE SIGN-IN ENDPOINT ANSWERS THE SAME WAY TO EVERYONE ────────────────────────────────
  console.log('\n— asking for a link tells nobody who is on the programme —');
  const before = await prisma.repMagicLink.count({ where: { rep_id: repParty.id } });
  const askRep = await ask(AFF_HOST, '/api/affiliate-portal/request-link', { method: 'POST', body: JSON.stringify({ email: repParty.email }) });
  check('a REP’s address on the affiliate endpoint gets the same 204', askRep.status === 204, `${askRep.status}`);
  check('  …and mints nothing', (await prisma.repMagicLink.count({ where: { rep_id: repParty.id } })) === before,
    'this is not their door, and a link built here would carry the rep path on the affiliate host');
  const askNobody = await ask(AFF_HOST, '/api/affiliate-portal/request-link', { method: 'POST', body: JSON.stringify({ email: `nobody${MARK}` }) });
  check('  …and an address belonging to nobody gets it too', askNobody.status === 204, `${askNobody.status}`);
  const linkSrc = src('pages/api/affiliate-portal/request-link.ts');
  // A one-line waiver, because the rule is that @anchored-ok must be the LAST comment line directly
  // above the matcher — a second comment line underneath it breaks the attachment, and the gate
  // then reports the waiver as decoration AND the matcher as unwaived. Both, which is how it should
  // read: a waiver that covers nothing is worse than none.
  // @anchored-ok: a limiter KEY PREFIX looked for in SOURCE text, not an object key
  const usesOwnKey = /affreq:ip:/.test(linkSrc);
  // @anchored-ok: the rep's limiter key prefix, in SOURCE text, asserted ABSENT
  const usesRepKey = /repreq:ip:/.test(linkSrc);
  check('  …and it spends its OWN limiter key, not the rep’s', usesOwnKey && !usesRepKey,
    'a shared key means either actor class can lock the other out');

  // ── 13. NO AFFILIATE-FACING ROUTE WRITES THE CREDENTIAL OR A BANK COLUMN ─────────────────────
  console.log('\n— and nothing the affiliate can post writes where the money goes —');
  const portalApis = ['pages/api/affiliate-portal/request-link.ts', 'pages/api/affiliate-portal/payee.ts'];
  const writesBank = portalApis.filter((f) => /bank_sort_code|bank_account_number|bank_account_last4/.test(src(f)));
  check('no portal route writes Rep.bank_*', writesBank.length === 0, writesBank.join(', ') || `${portalApis.length} routes checked`);
  check('  …and the sweep really looked at something', portalApis.every((f) => src(f).length > 0));
  check('  …nor writes the email that IS the credential',
    !portalApis.some((f) => /rep\.update|prisma\.rep\.update/.test(src(f))),
    'an operator changes a rep’s address, in the Engine Room, audited');
  check('  …and the payee route writes only the request table',
    /repPayeeRequest\.create/.test(src('pages/api/affiliate-portal/payee.ts')),
    'a proposal that could be paid would be the hole it exists to close');

  console.log(`\n${out.filter((x) => x === 'F').length} failures of ${out.length}`);
} catch (e) {
  console.error(`\nGATE ERROR: ${describeError(e)}`);
  out.push('F');
} finally {
  if (browser) await browser.close().catch(() => {});
  const swept = await sweep().catch(() => 0);
  console.log(`\n✓ teardown removed ${swept} fixture rep(s)`);
  if (prisma) await prisma.$disconnect().catch(() => {});
}

/** A second apply, wrapped so a throw is a failed clause rather than a dead gate. */
async function PADMIn_safe(requestId, operatorUserId) {
  try { return await PADMIN.applyPayeeRequest(prisma, { requestId, operatorUserId }); } catch (e) { return { ok: false, code: String(e) }; }
}

process.exit(out.includes('F') ? 1 : 0);
