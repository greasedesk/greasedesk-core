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
 * ── THE ENCRYPTION KEY IS THE APPLICATION'S OWN ────────────────────────────────────────────────
 * Read from .env, the same key the dev server holds, because the key now carries a fingerprint
 * registered per environment and a gate holding a different one would test a different
 * configuration. Absent, the premise clause in section 4c goes red and names the environment.
 */
import './_gate-preflight.mjs';
import './_ts.mjs';
const { gatePrisma, describeError, gateOrigin, affiliateOrigin, repOrigin, serverReady, onTeardown } = await import('./_gate-preflight.mjs');
const http = await import('node:http');
const { randomUUID, randomBytes } = await import('node:crypto');
const { readFileSync, readdirSync } = await import('node:fs');
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');

/**
 * ── THIS GATE USES THE REAL KEY FROM .env, NOT AN EPHEMERAL ONE (changed 2026-10-31) ────────────
 * It used to mint its own 32 bytes here, so the payee rules could be proved without depending on a
 * shared secret. That stopped being right the moment the key gained a FINGERPRINT registered per
 * environment: an ephemeral key fingerprints as nothing the register knows, so every payee
 * operation would refuse and the gate would be proving the refusal instead of the feature.
 *
 * More to the point, a gate holding a different key from the application is a gate testing a
 * different configuration. .env is loaded by lib/db (the only loader in this codebase, measured),
 * which gatePrisma imports — so by the time anything here runs, the app's own key is in hand.
 * Without one, the premise clause in section 4c goes red and says so.
 */

const AM = await import('../lib/anchored-match.ts');
const CRYPTO = await import('../lib/payee-crypto.ts');
const PAYEE = await import('../lib/payee.ts');
const PADMIN = await import('../lib/payee-admin.ts');
const PORTAL = await import('../lib/party-portal.ts');
const PDATA = await import('../lib/affiliate-portal-data.ts');
const COPY = await import('../lib/affiliate-portal-copy.ts');
const NAV = await import('../lib/affiliate-portal-nav.ts');
const EARN = await import('../lib/affiliate-earnings.ts');
const PUBLIC = await import('../lib/affiliate-public.ts');
const ADMIN = await import('../lib/affiliate-admin.ts');
const TERMS = await import('../lib/affiliate-terms.ts');
const PUB = await import('../lib/content-publish.ts');
const CONTENT = await import('../lib/content.ts');
const SEED = await import('../lib/content-seed.ts');
const RM = await import('../lib/rep-magic-link.ts');
const TPL = await import('../lib/notification-templates.ts');

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
/** The slug prefix section 10c seeds under — swept by prefix, never the real affiliate-terms slug. */
const SEED_MARK = 'zzapseed';
const PREFIX = `ZZAP${randomUUID().slice(0, 6).toUpperCase()}`;
const GATE_IP = '203.0.113.11';
/**
 * ── THE BROWSER GETS ITS OWN ADDRESS, ONE PER RUN ───────────────────────────────────────────────
 * spendRepLink takes a token from lib/auth-rate-limit's per-IP bucket: 30 rep sign-ins an hour, and
 * clientIp reads x-forwarded-for, which the dev server sets from the socket. So every run of this
 * gate spent two of ONE bucket for 127.0.0.1, and on the sixteenth run in an hour the sign-in simply
 * stopped working — presenting as a 30-second timeout waiting for the dashboard, with no page error
 * and nothing in the log about a limit. It read exactly like a broken page, and I spent three
 * red-proofs blaming a paragraph I had moved.
 *
 * A per-run address in the documentation range isolates each run, the same reason GATE_IP above
 * exists for the request-link clauses. It does NOT weaken the limiter: nothing here claims to test
 * it, and signInLimitNote below names it the moment a sign-in does not complete.
 */
const SIGNIN_IP = `203.0.113.${20 + Math.floor(Math.random() * 200)}`;

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

/**
 * WHY A SIGN-IN MIGHT NOT HAVE COMPLETED — written into the failure, because the symptom names the
 * wrong conclusion. A spent bucket looks identical to a page that will not render, and the first
 * reading of it is always the code you just changed.
 */
const signInLimitNote = async (ip) => {
  try {
    const since = new Date(Date.now() - 60 * 60 * 1000);
    const used = await prisma.authRateLimit.count({ where: { key: `repauth:ip:${ip}`, created_at: { gte: since } } });
    return `rep sign-ins from ${ip} in the last hour: ${used} of 30`
      + (used >= 30 ? ' — THE LIMITER IS SPENT, which is the likelier cause than the page' : '');
  } catch (e) {
    return `could not read the sign-in limiter: ${String(e).slice(0, 80)}`;
  }
};

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
  /**
   * AND THIS RUN'S OWN SIGN-IN BUCKET. The browser carries a per-run address, so these rows are NOT
   * loopback and the runner's own loopback sweep can never reach them — while takeToken prunes only
   * the key it is taking, and a one-shot random key is never taken again. Without this line the
   * isolation that fixed the limiter would quietly leak rows into authRateLimit for ever. The
   * isolation and the cleanup are one decision, not two.
   */
  /**
   * BY PREFIX, NOT BY THIS RUN'S KEY. A run that dies before its finally block leaves rows under an
   * address nothing will ever name again — and 203.0.113.0/24 is the documentation range, used by
   * nothing in this codebase but this gate, so the whole range is ours to clear. Same reasoning as
   * the leftover draft above: the sweep removes what an earlier crashed run left, not only what
   * this one made.
   */
  await prisma.authRateLimit.deleteMany({ where: { key: { startsWith: 'repauth:ip:203.0.113.' } } }).catch(() => {});
  /**
   * AND THE SEEDED FIXTURE DOCUMENTS, WITH THEIR SEED-AUDIT ROWS. The audit row is the guard that
   * makes the seed fire once, so leaving one behind would make the next run's first clause report
   * 'already_seeded' — a gate that passes on its second run and never again. Both go, by prefix,
   * for the reason the draft sweep above goes by prefix: a crashed run leaves its own.
   */
  await prisma.document.deleteMany({ where: { slug: { startsWith: SEED_MARK } } }).catch(() => {});
  await prisma.superAdminAudit.deleteMany({
    where: { action: SEED.SEED_AUDIT_ACTION, target_name_snapshot: { startsWith: SEED_MARK } },
  }).catch(() => {});
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
  const ctx = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': SIGNIN_IP } });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 200)));

  const live = await RM.mintRepLink({ repId: affiliate.id, sentTo: affiliate.email, baseUrl: AFF });
  await page.goto(live.url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="affiliate-enter"]');
  check('the landing page runs without throwing', pageErrors.length === 0,
    pageErrors[0] ?? 'no uncaught error — a server-only import reaching the bundle shows up HERE');
  await page.click('[data-testid="affiliate-enter"]');
  await page.waitForSelector('[data-testid="affiliate-home"]', { timeout: 20000 }).catch(async (e) => {
    throw new Error(`the affiliate never reached the dashboard (${page.url()}) — ${await signInLimitNote(SIGNIN_IP)}; `
      + `page errors: ${JSON.stringify(pageErrors)} — ${String(e).slice(0, 80)}`);
  });
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
  // IN THE MARKUP, which is all `includes` can say: five of the six sections are display:none on
  // arrival, and section 4a is where each one is proved VISIBLE through its own menu item.
  check('  …the four figures are in the markup', ['earn-earned', 'earn-held', 'earn-payable', 'earn-paid']
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

  // ── 4a. THE MENU, AND ONE SECTION AT A TIME ──────────────────────────────────────────────────
  /**
   * EVERY CLAUSE HERE ASKS `isVisible()`, NOT `count()` OR `innerText()`, AND THAT IS THE WHOLE
   * POINT OF THE SECTION.
   *
   * The six sections all live in the DOM and five of them are display:none. The HTML spec says an
   * element that is NOT BEING RENDERED returns its textContent from `innerText` — so every clause
   * above that reads `innerText` kept passing when I hid the thing it was reading, and the first run
   * after the menu landed was 189 green with nothing proved about what a person can see. A count and
   * a string match cannot tell a rendered section from a hidden one; only visibility can.
   *
   * THE CONTENT IS ASSERTED THROUGH THE MENU, not alongside it: click the item, and the element the
   * section exists for has to appear. A menu whose items highlight correctly and show the wrong pane
   * would pass a nav-only check.
   */
  console.log('\n— the menu moves one section at a time, and the logo does not point at the tenant app —');
  const paneOf = (k) => page.locator(`[data-testid="portal-section-${k}"]`);
  const navOf = (k) => page.locator(`[data-testid="portal-nav-${k}"]`);
  /** The element each section EXISTS for — so "the pane is visible" cannot pass over an empty box. */
  const CONTENT_OF = {
    overview: 'affiliate-how-section',
    share: 'affiliate-code',
    posts: 'affiliate-posts-section',
    garages: 'affiliate-garages-section',
    earnings: 'earn-earned',
    'payment-details': 'payee-form',
  };

  check('the rail is on the page with the logo at the top',
    (await page.locator('[data-testid="portal-rail"]').count()) === 1
    && (await page.locator('[data-testid="portal-logo"] img').count()) === 1);
  /**
   * BrandLogo DEFAULTS ITS HREF TO /admin/dashboard, which does not exist on this host. A shell that
   * took the default would have shipped a logo whose only job is to go home and which 404s instead.
   */
  check('  …and the logo goes to the portal, not to the tenant app',
    (await page.locator('[data-testid="portal-logo"] a').getAttribute('href')) === PORTAL.portalHomePath('affiliate'),
    await page.locator('[data-testid="portal-logo"] a').getAttribute('href'));
  // ENUMERATED FROM THE EXPORTED TABLE, never from a list typed here: a seventh section added to the
  // nav and never rendered is exactly the gap a hand-written list cannot see.
  check('  …a menu item and a pane for every section in the table',
    NAV.PORTAL_SECTIONS.length === 6
    && (await Promise.all(NAV.PORTAL_SECTIONS.map(async (sec) => (await navOf(sec.key).count()) === 1
      && (await paneOf(sec.key).count()) === 1 && !!CONTENT_OF[sec.key]))).every(Boolean),
    NAV.PORTAL_SECTIONS.map((x) => x.key).join(', '));
  check('  …and the owner’s menu, in his words',
    ['Overview', 'Share', 'Posts & videos', 'My garages', 'Earnings', 'Payment details']
      .every((l, i) => NAV.PORTAL_SECTIONS[i].label === l),
    NAV.PORTAL_SECTIONS.map((x) => x.label).join(' · '));
  check('  …with Terms and Sign out below them, as links out rather than sections',
    (await page.locator('[data-testid="portal-link-terms"]').count()) === 1
    && (await page.locator('[data-testid="portal-signout"]').count()) === 1
    && NAV.PORTAL_SECTIONS.every((sec) => sec.key !== 'terms'));
  /**
   * ── AND TERMS LEADS INSIDE THE PORTAL, NOT OUT TO THE PUBLIC PAGE (owner, 2026-11-01) ────────
   * It pointed at /terms, so a signed-in affiliate clicking their own menu lost the menu and landed
   * on the page written for somebody deciding whether to join. The ATTRIBUTE is asserted, and so is
   * the fact that it is not the public address — a clause that only checked "it has an href" would
   * have passed on the defect it was written for. Section 10b walks it.
   */
  check('    …and Terms goes to the portal’s own page rather than the public one',
    (await page.locator('[data-testid="portal-link-terms"]').getAttribute('href')) === NAV.PORTAL_TERMS_PATH
    && NAV.PORTAL_TERMS_PATH !== '/terms',
    `${await page.locator('[data-testid="portal-link-terms"]').getAttribute('href')} — the public page is /terms`);

  const visibleKeys = async () => {
    const vis = [];
    for (const sec of NAV.PORTAL_SECTIONS) if (await paneOf(sec.key).isVisible()) vis.push(sec.key);
    return vis;
  };
  check('on arrival exactly one section is showing, and it is the overview',
    JSON.stringify(await visibleKeys()) === JSON.stringify([NAV.PORTAL_DEFAULT_SECTION]),
    (await visibleKeys()).join(', ') || 'NOTHING is visible');

  for (const sec of NAV.PORTAL_SECTIONS) {
    await navOf(sec.key).click();
    await page.waitForFunction(
      (k) => !document.querySelector(`[data-testid="portal-section-${k}"]`).hasAttribute('hidden'),
      sec.key, { timeout: 4000 },
    ).catch(() => {});
    const vis = await visibleKeys();
    const content = page.locator(`[data-testid="${CONTENT_OF[sec.key]}"]`);
    check(`  …“${sec.label}” shows ${CONTENT_OF[sec.key]} and hides the other five`,
      JSON.stringify(vis) === JSON.stringify([sec.key]) && await content.isVisible(),
      `visible: ${vis.join(', ') || 'none'}; ${CONTENT_OF[sec.key]} ${await content.isVisible() ? 'visible' : 'HIDDEN'}`);
    check(`    …the address bar says so, and the item is marked current`,
      new URL(page.url()).hash === `#${sec.key}`
      && (await navOf(sec.key).getAttribute('aria-current')) === 'page',
      `${new URL(page.url()).hash} · aria-current=${await navOf(sec.key).getAttribute('aria-current')}`);
  }

  /**
   * A PASTED ADDRESS, which is the reason the hash is the source of truth rather than a piece of
   * state kept in step with it. A fresh load of /dashboard#earnings must open on Earnings.
   */
  /**
   * ── THE DOCUMENT HAS TO BE LOADED AFRESH, AND THE FIRST VERSION OF THIS WAS NOT ──────────────
   * A `goto` to a URL that differs from the current one only in its FRAGMENT does not reload the
   * document — the browser fires hashchange on the page already open. So this clause arrived at
   * `#earnings` from `#payment-details` and proved the listener a second time, while the thing it
   * claims to test (the hash being read ON ARRIVAL) was never exercised. Deleting the on-mount read
   * left the whole gate green.
   *
   * So: leave the document first. A different PATH is a real navigation, and the hashed address is
   * then a cold load, which is what a pasted link actually is.
   */
  await page.goto(`${AFF}/poster`, { waitUntil: 'domcontentloaded' });
  await page.goto(`${AFF}${PORTAL.portalHomePath('affiliate')}#earnings`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="affiliate-home"]');
  await page.waitForFunction(() => !document.querySelector('[data-testid="portal-section-earnings"]').hasAttribute('hidden'),
    null, { timeout: 4000 }).catch(() => {});
  check('a pasted link opens on the section it names',
    JSON.stringify(await visibleKeys()) === JSON.stringify(['earnings']), (await visibleKeys()).join(', ') || 'none');
  // A STALE OR MANGLED HASH OPENS THE PORTAL rather than a page with every section hidden — the
  // failure mode of a lookup that throws, or of one that returns undefined and renders nothing.
  await page.goto(`${AFF}/poster`, { waitUntil: 'domcontentloaded' }); // a cold load again — see above
  await page.goto(`${AFF}${PORTAL.portalHomePath('affiliate')}#not-a-section`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="affiliate-home"]');
  check('  …and an unrecognised one opens the overview rather than nothing at all',
    JSON.stringify(await visibleKeys()) === JSON.stringify([NAV.PORTAL_DEFAULT_SECTION]),
    (await visibleKeys()).join(', ') || 'NOTHING is visible');
  check('  …which is what sectionFromHash says on its own, for every shape of input',
    ['#earnings', 'earnings', '#EARNINGS', ' #earnings ', '#', '', '#nope', null, undefined]
      .map((h) => NAV.sectionFromHash(h))
      .join(',') === `earnings,earnings,earnings,earnings,${'overview,'.repeat(4)}overview`,
    ['#earnings', 'earnings', '#EARNINGS', ' #earnings ', '#', '', '#nope', null, undefined].map((h) => `${JSON.stringify(h)}→${NAV.sectionFromHash(h)}`).join(' '));

  /**
   * ── ON A PHONE: THE RAIL IS GONE AND THERE IS A WAY TO THE MENU ──────────────────────────────
   * The owner asked for it to collapse, so the clause is that the rail is NOT visible at phone width
   * and that the button is — a "renders at 390px" check would pass with both on screen at once.
   */
  await page.setViewportSize({ width: 390, height: 844 });
  const railVisible = await page.locator('[data-testid="portal-rail"]').isVisible();
  const buttonVisible = await page.locator('[data-testid="portal-menu-button"]').isVisible();
  check('at phone width the rail is gone and a menu button is there', !railVisible && buttonVisible,
    `rail ${railVisible ? 'VISIBLE' : 'hidden'} · button ${buttonVisible ? 'visible' : 'MISSING'}`);
  check('  …and the menu is closed until it is asked for',
    (await page.locator('[data-testid="portal-mobile-nav"]').count()) === 0);
  await page.locator('[data-testid="portal-menu-button"]').click();
  await page.waitForSelector('[data-testid="portal-mobile-nav"]');
  check('  …it opens with the same items', (await page.locator('[data-testid="portal-mobile-nav"] [data-testid^="portal-nav-"]').count()) === 6);
  await page.locator('[data-testid="portal-mobile-nav"] [data-testid="portal-nav-garages"]').click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="portal-section-garages"]').hasAttribute('hidden'),
    null, { timeout: 4000 }).catch(() => {});
  // IT CLOSES ON NAVIGATE. An overlay left open covers the section the person just asked to see,
  // which on a phone is the whole screen — the change would be invisible and read as a dead menu.
  check('  …and choosing one closes it and shows that section',
    (await page.locator('[data-testid="portal-mobile-nav"]').count()) === 0
    && await paneOf('garages').isVisible(),
    `overlay ${(await page.locator('[data-testid="portal-mobile-nav"]').count()) ? 'STILL OPEN' : 'closed'}`);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${AFF}${PORTAL.portalHomePath('affiliate')}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="affiliate-home"]');

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
  check('the form is in the dashboard’s markup', (await page.locator('[data-testid="payee-form"]').count()) === 1,
    'section 4a proves it is VISIBLE when Payment details is chosen — a count cannot say that');
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
    check('the dev server holds the payee key this database expects', false,
      'the route answered 503, which is it REFUSING to store a bank detail it cannot encrypt. Correct '
      + 'behaviour, and it means this environment cannot prove the submit path. TWO CAUSES look the '
      + 'same from here and the likelier one is named first: the server holds a key whose fingerprint '
      + 'is not the one registered for this database (lib/payee-key-check), or it holds no key at all. '
      + 'Either way it is the environment and not the route: fix PAYEE_ENC_KEY in .env and RESTART the '
      + 'dev server, which reads .env only at startup. The server log carries the exact refusal code.');
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

  // ── 4d. THE SORT CODE FIELD, AS SOMEBODY TYPES IT ────────────────────────────────────────────
  /**
   * The owner asked for the field to show 11-03-00 as it is typed and on paste, and to store six
   * digits only. Both halves are asserted, and the second one is asserted ON THE WIRE: the stored
   * value is encrypted, so "it sent the digits" cannot be read back out of the row.
   *
   * THE REQUEST IS INTERCEPTED AND ANSWERED HERE, not allowed through. Submitting for real would
   * supersede the pending RepPayeeRequest that section 4c created and that the Engine Room clauses
   * below still read — a gate's own side effects breaking its later clauses is the shape of defect
   * that cost three red-proofs in this file a day ago.
   */
  console.log('\n— and the sort code groups itself without changing what is sent —');
  check('the rule on its own, over every shape a field can be in',
    [['110300', '', '11-03-00'], ['11 03 00', '', '11-03-00'], ['11-03-00', '', '11-03-00'],
      ['1', '', '1'], ['11', '', '11'], ['110', '', '11-0'],
      ['11030099', '', '11-03-00'], ['abc11x03', '', '11-03'],
      // THE SEPARATOR CASE: deleting the dash takes the digit in FRONT of it, or the field cannot
      // be edited from the right at all — the grouping puts the dash straight back.
      ['11-0300', '11-03-00', '11-00-0'], ['1103-00', '11-03-00', '10-30-0'],
      ['11-0', '11-03', '11-0']]
      .every(([raw, prev, want]) => PAYEE.sortCodeAsTyped(raw, prev) === want),
    [['110300', ''], ['11 03 00', ''], ['110', ''], ['11-0300', '11-03-00']]
      .map(([r, p2]) => `${JSON.stringify(r)}→${PAYEE.sortCodeAsTyped(r, p2)}`).join(' '));
  check('  …and what it produces still normalises to the six digits that are stored',
    PAYEE.normaliseSortCode(PAYEE.sortCodeAsTyped('110300', '')) === '110300'
    && PAYEE.normaliseSortCode(PAYEE.sortCodeAsTyped('11 03 00', '')) === '110300');

  await navOf('payment-details').click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="portal-section-payment-details"]').hasAttribute('hidden'),
    null, { timeout: 4000 }).catch(() => {});
  const sortField = page.locator('[data-testid="payee-sort"]');
  await sortField.fill('');
  // ONE KEY AT A TIME, which is what "as you type" means. fill() would set the whole string in one
  // event and prove the paste path twice over.
  await sortField.pressSequentially('110');
  check('three digits in, the field shows the group it has',
    (await sortField.inputValue()) === '11-0', await sortField.inputValue());
  await sortField.pressSequentially('300');
  check('  …and six show as 11-03-00', (await sortField.inputValue()) === '11-03-00', await sortField.inputValue());
  await sortField.fill('');
  // A PASTE ARRIVES AS ONE EVENT, with whatever separators the person copied.
  await sortField.fill('11 03 00');
  check('a pasted code with spaces settles to the same thing',
    (await sortField.inputValue()) === '11-03-00', await sortField.inputValue());
  await sortField.fill('');
  await sortField.pressSequentially('11030099');
  check('  …and it cannot be made longer than a sort code',
    (await sortField.inputValue()) === '11-03-00', await sortField.inputValue());

  let postedBody = null;
  await page.route('**/api/affiliate-portal/payee', async (route) => {
    postedBody = route.request().postData();
    // ANSWERED AS A SUCCESS so the form behaves as it would, and NOTHING reaches the database.
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, masked: 'ending ••21' }) });
  });
  await page.locator('[data-testid="payee-name"]').fill('A Typed Payee');
  await page.locator('[data-testid="payee-account"]').fill('87654321');
  await page.locator('[data-testid="payee-submit"]').click();
  await page.waitForFunction(() => !!document.querySelector('[data-testid="payee-message"]'), null, { timeout: 6000 }).catch(() => {});
  await page.unroute('**/api/affiliate-portal/payee');
  const posted = (() => { try { return JSON.parse(postedBody ?? '{}'); } catch { return {}; } })();
  check('what the form SENDS is the six digits, with no separators in them',
    posted.sortCode === '110300', `sortCode=${JSON.stringify(posted.sortCode)} (the field showed 11-03-00)`);
  check('  …and the request really was the one the form made',
    posted.accountName === 'A Typed Payee' && posted.accountNumber === '87654321',
    'a null body would have made the clause above pass for the wrong reason');
  // NOTHING WAS WRITTEN — the interception has to be real, or the clauses below read a row this
  // section created rather than the one section 4c made.
  check('  …and the intercepted submit stored nothing',
    (await prisma.repPayeeRequest.count({ where: { rep_id: affiliate.id, account_name: 'A Typed Payee' } })) === 0);
  await page.goto(`${AFF}${PORTAL.portalHomePath('affiliate')}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="affiliate-home"]');

  // ── 4e. WHAT THE AFFILIATE IS TOLD WHILE A REQUEST IS WAITING ────────────────────────────────
  /**
   * The owner's report (2026-11-01): the waiting sentence said "We will pay the account we already
   * hold until then" to EVERYBODY with a request in flight — including somebody who has never given
   * us an account, where it names a thing that does not exist and reads as money sitting somewhere
   * else.
   *
   * THE STATE CANNOT TELL THEM APART, which is why `holdsAccount` is its own fact: the payee state
   * is 'pending' in both cases, and the mask shown while pending is the NEW account's. Both sides
   * are driven here — the fixture affiliate has a pending request from section 4c and NO held
   * details, so the first reading is the one that was wrong.
   */
  console.log('\n— and the waiting sentence only promises an account when we hold one —');
  const pendingOnly = await ask(AFF_HOST, PORTAL.portalHomePath('affiliate'), { cookie: jarEarly });
  const stateText = (body) => (body.match(/data-testid="payee-state"[^>]*>([^<]*)</) ?? [])[1] ?? '';
  check('with a request in flight and nothing on file, it does not promise an account',
    stateText(pendingOnly.body).includes('once they') && !/account we already hold/.test(pendingOnly.body),
    stateText(pendingOnly.body) || 'no payee-state on the page');
  await prisma.rep.update({
    where: { id: affiliate.id },
    data: {
      bank_account_name: 'ZZAP Held Payee', bank_account_last4: '4321',
      // Rep_bank_chk is all three or none. Nothing on this path decrypts them — see the clause
      // below, which reads them back untouched — so a v1-shaped string is what the state needs.
      bank_sort_code: 'v1:zzapiv:zzaptag:zzapsort', bank_account_number: 'v1:zzapiv:zzaptag:zzapacct',
    },
  });
  const pendingWithHeld = await ask(AFF_HOST, PORTAL.portalHomePath('affiliate'), { cookie: jarEarly });
  check('  …and with one on file it says we will pay that until this is checked',
    /account we already hold/.test(pendingWithHeld.body)
    && stateText(pendingWithHeld.body) !== stateText(pendingOnly.body),
    stateText(pendingWithHeld.body));
  check('    …which are two different sentences from the one copy module',
    COPY.PAYEE_COPY.pending !== COPY.PAYEE_COPY.pendingWithHeld
    && /once they/.test(COPY.PAYEE_COPY.pending) && !/already hold/.test(COPY.PAYEE_COPY.pending)
    && /already hold/.test(COPY.PAYEE_COPY.pendingWithHeld),
    'the sentence is chosen by a fact the page is GIVEN, not inferred from a mask');
  /**
   * AND THE AFFILIATE SEES WHOSE ACCOUNT IT IS TOO — already true before this batch, so it is
   * ASSERTED rather than changed. The owner asked for the name beside the digits on both screens;
   * on this one it was there, and a clause is what keeps it there.
   */
  /**
   * THE NAME IS READ FROM THE ROW, not written out here. A literal of my own would be the same
   * string the gate typed into the POST in section 4c, and a clause comparing a page against the
   * value that produced it agrees with itself — the page's precedence (the pending request's name
   * over the held one) is the thing being asserted, so the pending row is the oracle.
   */
  const pendingName = (await prisma.repPayeeRequest.findFirst({
    where: { rep_id: affiliate.id, status: 'pending' },
    orderBy: { requested_at: 'desc' }, select: { account_name: true },
  }))?.account_name ?? null;
  const maskedLine = (pendingWithHeld.body.match(/data-testid="payee-masked"[^>]*>([\s\S]{0,120}?)<\/p>/) ?? [])[1]
    ?.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() ?? '';
  check('the affiliate\u2019s own screen names the account beside the mask',
    !!pendingName && pendingName.length > 3 && maskedLine.includes(pendingName) && /ending/.test(maskedLine),
    `${maskedLine || 'no payee-masked line'} — the row says ${JSON.stringify(pendingName)}`);
  // AND THE DIGITS WERE NEVER OPENED to say any of it: the page reads last4 and the name, both clear.
  const stillSealed = await prisma.rep.findUnique({
    where: { id: affiliate.id }, select: { bank_sort_code: true, bank_account_number: true },
  });
  check('  …without the portal ever decrypting anything',
    stillSealed?.bank_sort_code === 'v1:zzapiv:zzaptag:zzapsort'
    && stillSealed?.bank_account_number === 'v1:zzapiv:zzaptag:zzapacct'
    && (await prisma.superAdminAudit.count({ where: { action: 'rep.payee_revealed', target_rep_id: affiliate.id } })) === 0,
    'an affiliate looking at their own dashboard is not a reveal and must not write one');
  // PUT BACK, because section 4c's clauses are about an affiliate with a PENDING request and no
  // held account, and the sections after this one read the same fixture.
  await prisma.rep.update({
    where: { id: affiliate.id },
    data: { bank_account_name: null, bank_sort_code: null, bank_account_number: null, bank_account_last4: null },
  });

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

  // ── 6b. NOTHING PROMISES WHAT THE TERMS DO NOT ───────────────────────────────────────────────
  /**
   * THE DEFECT THIS SECTION EXISTS FOR (owner, 2026-10-31): step 3 said the hold meant "we are not
   * asking for money back from you later" and step 4 said "nothing is ever taken back from money we
   * have already sent you". Terms 6.5 and 6.6 say a full refund or a chargeback cancels that
   * payment's reward and DEDUCTS it from the next payout if it was already paid; section 7 recovers
   * one earned on a garage the affiliate could not earn on. The public terms summary carried the
   * same reassurance in its own words — "we do not ask for money back".
   *
   * A reassurance that holds in most cases is read as a guarantee on the day it does not, and the
   * person reading it is owed money. So this asks the FUNCTIONS what they return, and then sweeps
   * every rendered surface for the shape of the promise rather than for the three sentences that
   * happened to be written.
   */
  console.log('\n— and nothing in the portal promises what the terms do not —');
  const how = COPY.howItWorks({ holdDays: 14, monthsGiven: 12, monthsPaid: 8 });
  check('the hold is described as catching MOST refunds, not as making us never ask',
    /most refunds/.test(how[2].body) && !/(not|never) ask/i.test(how[2].body), how[2].body);
  check('  …and step 4 says the deduction instead of denying it',
    how[3].body.includes(COPY.REFUND_RULE) && /comes off your next payout/.test(how[3].body), how[3].body);
  check('  …from ONE constant, so the two places it is said cannot drift',
    COPY.REFUND_RULE.length > 40
    && (src('pages/affiliate-portal/dashboard.tsx').match(/REFUND_RULE/g) ?? []).length >= 2
    && !/comes off your next payout/.test(src('pages/affiliate-portal/dashboard.tsx')),
    'the earnings section and step 4 both render it; a second copy is a promise that gets corrected once');
  check('  …and it keeps the distinction the terms make, between a full refund and a partial one',
    /in full/.test(COPY.REFUND_RULE), COPY.REFUND_RULE);

  /**
   * THE SWEEP. Over RENDERED output — the served dashboard (all six sections are in the DOM, so one
   * fetch covers every word of the portal), the poster, and the public terms page. Not over source:
   * a source scan reads the comments that explain the fix as if they were the copy, and the lesson
   * on the board is that a term matching something other than its subject proves nothing.
   */
  const PROMISES = [
    /not asking for money back/i,
    /(?:never|not|don.t|do not) ask(?:ing)?[^.]{0,30}for money back/i,
    /nothing is ever taken back/i,
    /we do not ask for money back/i,
    /yours to keep/i,
    /(?:no|zero) risk\b/i,
    /risk[- ]free/i,
    /guarantee/i,
  ];
  const termsPage = await ask(AFF_HOST, '/terms');
  /**
   * THE PORTAL'S OWN TERMS PAGE IS A FOURTH SURFACE, and it joined this sweep the day it was
   * written. A new page carrying the same settled summary is exactly where the promise would come
   * back — the three the owner found were in three different files.
   */
  const myTermsPage = await ask(AFF_HOST, NAV.PORTAL_TERMS_PATH, { cookie: jarEarly });
  check('the portal’s own terms page is served to the affiliate', myTermsPage.status === 200, `${myTermsPage.status}`);
  const SURFACES = [
    ['the dashboard, every section of it', servedEarly.body],
    ['the printable poster', poster.body],
    ['the public terms page', termsPage.body],
    ['the portal’s own terms page', myTermsPage.body],
  ];
  for (const [what, body] of SURFACES) {
    // THE TEXT, NOT THE MARKUP: a class name or a chunk URL is not something anybody reads, and
    // tag soup joins words that are separate on screen.
    const text = String(body).replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ');
    const hits = PROMISES.filter((re) => re.test(text)).map((re) => String(re));
    check(`  …${what} makes none of the promises`, body.length > 500 && hits.length === 0,
      hits.length ? hits.join(' · ') : `${text.length} characters of rendered text swept`);
  }
  // AND THE SWEEP IS NOT VACUOUS: the same regexes, over the sentence they were written for.
  check('    …and the sweep would catch one if it were there',
    PROMISES.some((re) => re.test('Nothing is ever taken back from money we have already sent you.'))
    && PROMISES.some((re) => re.test('A reversal is set against what you earn next, and we do not ask for money back.')),
    'a filter that matches nothing reports a clean sweep over a population it cannot see');

  check('the deduction is rendered where the money is READ, not only in the steps',
    (await page.locator('[data-testid="affiliate-refund-rule"]').count()) === 1
    && (await paneOf('earnings').locator('[data-testid="affiliate-refund-rule"]').count()) === 1,
    'somebody counting on a payable figure is the person who needs to know it can still move');
  /**
   * THIS CLAUSE USED TO ASSERT "cancelled and recovered", and terms v2 made it wrong (2026-11-01).
   * v1 recovered a reward earned on a garage the affiliate could not earn on in EVERY case; v2
   * section 7 cancels in every case and recovers only where it was earned by fraud or a deliberate
   * breach. The summary was therefore the harsher of the two documents — the mirror image of the
   * reassurance defect this whole section exists for, and just as much a statement about somebody's
   * money that the agreement does not support. The last line is what keeps the fix honest: the
   * unconditional sentence must be GONE, not merely joined by a conditional one.
   */
  check('  …and the public summary states the deduction, and recovers only where the terms do',
    /comes off your next payout/.test(termsPage.body)
    && /cancelled — and recovered as well, if it was earned by fraud or a deliberate breach/.test(termsPage.body)
    && !/cancelled and recovered/.test(termsPage.body),
    'terms 6.5, 6.6 and 7 — v2 recovers on fraud or a deliberate breach, not as a matter of course');
  /**
   * ── ONE SOURCE FOR THE SUMMARY, READ BY BOTH SCREENS (owner, 2026-11-01) ─────────────────────
   * The settled summary used to be a literal array inside the public page. The portal now has its
   * own terms screen, and two statements of one agreement is one of them being out of date — which
   * is precisely how the refund promise came to be wrong in three places at once.
   *
   * ASSERTED FROM BOTH DIRECTIONS: the words are on both RENDERED pages, and neither page FILE
   * contains them — so they cannot have come from anywhere but the shared leaf. The third clause
   * keeps the scan honest: a term that is in no file at all would satisfy the second by itself.
   */
  const SUMMARY_MARK = 'Refunds and chargebacks';
  check('the settled summary has one source, rendered on both terms pages',
    termsPage.body.includes(SUMMARY_MARK) && myTermsPage.body.includes(SUMMARY_MARK),
    `public ${termsPage.body.includes(SUMMARY_MARK) ? 'yes' : 'NO'} · portal ${myTermsPage.body.includes(SUMMARY_MARK) ? 'yes' : 'NO'}`);
  check('  …and neither page carries a copy of it',
    !src('pages/affiliate-site/terms.tsx').includes(SUMMARY_MARK)
    && !src('pages/affiliate-portal/terms.tsx').includes(SUMMARY_MARK),
    'a literal in either file is the second source this consolidation removed');
  check('    …because it lives in the leaf they both read',
    src('lib/affiliate-terms-summary.ts').includes(SUMMARY_MARK)
    && /comes off your next payout/.test(src('lib/affiliate-terms-summary.ts')),
    'a word that is in no file would make the clause above pass over nothing');

  // ── 6c. WHERE AN AFFILIATE MAY PROMOTE US, SAID WHEREVER WE SEND THEM OUT ──────────────
  /**
   * TERMS v2, 8.3 (solicitor-approved, 2026-11-01). Version 1 allowed email and text to anybody the
   * affiliate could lawfully contact under PECR, which for a trade audience is most garages in the
   * country. Version 2 forbids electronic marketing outright — to a person or a business alike — and
   * 8.7 makes a breach grounds for immediate termination with an indemnity for what it costs us.
   *
   * THE PORTAL WAS RECOMMENDING THE BANNED CHANNEL. One of the three ready-made posts was a cold
   * message to a garage ("Thought of you —"), pre-written, with a Copy button under it; step 1 of
   * how-it-works opened "Anywhere you like — a message, a post…"; and the file's own comment called
   * the message "how most of these introductions will really happen". A rule that ends the agreement
   * cannot live only in the agreement when the product is handing people the opposite.
   *
   * ASKED OF THE RENDERED SURFACES. The sentence is one constant, so a clause reading it out of the
   * file it lives in would be agreeing with itself; these fetch the dashboard, the public page and
   * the welcome email and look for it where somebody would read it.
   */
  console.log('\n— and where they may promote us is said on every surface that sends them out —');
  const CH = COPY.PROMOTION_CHANNELS;
  /** Filled by the single-source clause below and read again by section 10's rename clause. */
  let channelSources = [];
  check('the channel rule says the permitted channels AND the ban AND the reply',
    /public channels/i.test(CH) && /in person/i.test(CH)
    && /do not send marketing emails or texts/i.test(CH) && /including businesses/i.test(CH)
    && /reply to someone who asks/i.test(CH),
    'a rule that only forbids leaves somebody to guess at the rest; and without the reply carve-out '
    + 'it reads as "never mention it to a customer who asks", which is not what 8.3 says');
  check('  …and it is said in ONE file, so five surfaces cannot come to say five things',
    (() => {
      const mark = 'Do not send marketing emails or texts';
      const roots = ['lib', 'pages', 'components'];
      const hits = [];
      const walk = (d) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const f = `${d}/${e.name}`;
          if (e.isDirectory()) walk(f);
          else if (/\.tsx?$/.test(e.name) && src(f).includes(mark)) hits.push(f);
        }
      };
      for (const r of roots) walk(r);
      channelSources = hits;
      return hits.length === 1 && hits[0] === 'lib/affiliate-portal-copy.ts';
    })(),
    channelSources.join(' · '));
  check('  …no ready-made post is a message nobody asked for',
    posts.every((p) => !/thought of you|message to a garage|drop (?:them|him|her) a|text them|email them/i.test(`${p.title} ${p.text}`)),
    posts.map((p) => p.title).join(' | '));
  check('    …and the third one is a REPLY, said in its own title',
    posts[2].id === 'reply' && /reply/i.test(posts[2].title) && /asks/i.test(posts[2].title),
    `${posts[2].id} · ${posts[2].title} — a post whose title does not say it answers a question is a post somebody sends cold`);
  check('  …and step 1 of how-it-works carries the rule instead of "anywhere you like"',
    how[0].body.includes(CH) && !/anywhere you like/i.test(how[0].body), how[0].body);
  check('  …and the dashboard renders it beside the Copy buttons',
    servedEarly.body.includes(CH)
    && (await page.locator('[data-testid="affiliate-posts-channels"]').count()) === 1,
    'the screen where somebody copies a post is the screen where they pick a destination');
  const publicPage = await ask(AFF_HOST, '/');
  check('  …and the public page says it twice: in the creator section and in the questions',
    publicPage.status === 200 && (publicPage.body.split(CH).length - 1) >= 2,
    `${publicPage.status} · ${publicPage.body.split(CH).length - 1} occurrences — a rule met only after signing up is one we sprang on them`);
  check('  …and the welcome email, which is where they are handed the code and told to go',
    TPL.NOTIFICATION_TEMPLATES.affiliate_welcome.email({
      refCode: 'ZZTEST00', referralLink: 'https://example.invalid/r', monthsGiven: 12, monthsPaid: 8,
      link: 'https://example.invalid/v', expiryDays: 14,
    }).html.includes(CH),
    'it stated the labelling rule and stopped, which was the whole of section 8 that mattered under v1');
  check('  …and the settled summary, which is the terms until the owner publishes',
    termsPage.body.includes(CH) && myTermsPage.body.includes(CH),
    `public ${termsPage.body.includes(CH) ? 'yes' : 'NO'} · portal ${myTermsPage.body.includes(CH) ? 'yes' : 'NO'}`);

  /**
   * AND A SWEEP FOR THE INVITATION ITSELF. Narrow on purpose: these are the shapes that WERE wrong,
   * and a guard naming what it knows about catches only what somebody thought of. The clauses above
   * are the ones that generalise — they say the rule REACHES every surface rather than that one
   * wording is absent from it. This is the cheap second net, not the proof.
   */
  const INVITES = [
    /anywhere you like/i,
    /thought of you/i,
    /\b(?:text|message|email|whatsapp|dm)\s+(?:them|a garage|garages|the garage)\b/i,
    /\byour (?:mailing )?list\b/i,
    /\bbulk (?:email|text|message)/i,
  ];
  for (const [what, body] of [...SURFACES, ['the public page', publicPage.body]]) {
    const text = String(body).replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ');
    const hits = INVITES.filter((re) => re.test(text)).map((re) => String(re));
    check(`  …${what} invites nobody to email or text a garage`, body.length > 500 && hits.length === 0,
      hits.length ? hits.join(' · ') : `${text.length} characters swept`);
  }
  check('    …and the sweep would catch the post we used to ship',
    INVITES.some((re) => re.test('#ad Thought of you — GreaseDesk is garage software'))
    && INVITES.some((re) => re.test('Anywhere you like — a message, a post, a printed card on the counter.')),
    'a filter that matches nothing reports a clean sweep over a population it cannot see');

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
  const source = src('content/affiliate-terms.md');
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

  /**
   * ── AND IT IS VERSION 2, THE ONE THE SOLICITOR APPROVED (2026-11-01) ──────────────────
   * Eight clauses v2 added or rewrote, each asserted by the sentence that carries it, plus the v1
   * wording that had to GO: "No spam" permitted email and text to anybody lawfully contactable under
   * PECR, and a file holding both would publish a document that contradicts itself.
   */
  check('the draft is version 2: electronic marketing is banned outright',
    source.includes('**Public channels and in person only.**')
    && source.includes('whether a person or a business')
    && !/No spam/i.test(source) && !/PECR/.test(source),
    'v1 allowed lawful B2B email; a file carrying both rules publishes a document at odds with itself');
  const V2 = [
    ['1.3 — no quotas, and we do not direct the method', 'There are no minimum introductions, quotas or targets'],
    ['6.2 — a closing balance is paid whatever its size', 'any balance you are owed is paid in full in the next payout run'],
    ['6.5 — a paid reward is deducted, never demanded back', 'We will not ask you to repay it'],
    ['7 — recovery only on fraud or a deliberate breach', 'Where it was earned through fraud or a deliberate breach of this section'],
    ['8.7 — the indemnity for an unlabelled ad or a text', 'cover any fines, costs or losses we reasonably incur'],
    ['9.4 — and it is grounds to end the agreement at once', 'electronic marketing in breach of 8.3'],
    ['10.2 — a change applies forwards only', 'A change applies only from the date it takes effect'],
    ['11.4 — the liability carve-outs the law requires', 'death or personal injury caused by negligence'],
  ];
  for (const [what, sentence] of V2) {
    check(`  …${what}`, source.includes(sentence), sentence);
  }
  /**
   * AND THE NUMBER 8.3 POINTS AT 8.3. Two clauses of v2 cite it by number, so an item inserted
   * anywhere above it silently re-aims both at the wrong rule — in a document that is IMMUTABLE once
   * published. This is the one clause here that is about structure rather than wording, and it is the
   * one that can go red from an edit nobody thought was risky.
   */
  const s8 = (source.split('\n## 8.')[1] ?? '').split('\n## ')[0];
  const items8 = s8.split('\n').filter((l) => /^\d+\. /.test(l));
  check('  …and 8.3 IS the third item of section 8, which 8.7 and 9.4 both cite by number',
    items8.length === 7 && /^3\. \*\*Public channels and in person only\.\*\*/.test(items8[2]),
    `${items8.length} items · third reads “${(items8[2] ?? '').slice(0, 48)}…”`);
  /**
   * AND THE TWO READERS OF THE FILE NAME A FILE THAT IS THERE.
   *
   * This clause first swept the readers for the retired name and went red on itself: the gate's own
   * source contains `affiliate-terms-v1` — as the regex literal doing the searching. The term was
   * not unique to its subject, which is the board's own lesson, and the version below is the better
   * clause anyway: it asserts the two writers AGREE on a path that RESOLVES, rather than that one
   * retired string is absent from four files.
   */
  /**
   * THE PATH IS READ OFF THE `SOURCE` CONST, NOT THE FIRST ONE IN THE FILE. The loose version of
   * this matched the script's HEADER COMMENT — "PUBLISH THE AFFILIATE TERMS from content/…" — which
   * sits four lines above the code, so a red-proof that pointed the real const at a file that does
   * not exist passed cleanly. The clause was asserting the documentation.
   *
   * `scriptMentions` is what closes it from the other side: every content/*.md path in that file
   * must be the SAME path, so the header and the const cannot drift apart either.
   */
  const scriptSrc = src('scripts/publish-affiliate-terms.mjs');
  const scriptPath = (/SOURCE = `\$\{ROOT\}\/(content\/[a-z0-9-]+\.md)`/.exec(scriptSrc) ?? [])[1] ?? '';
  const scriptMentions = [...new Set(scriptSrc.match(/content\/[a-z0-9-]+\.md/g) ?? [])];
  const registered = SEED.SEEDABLE_DRAFTS.find((d) => d.slug === TERMS.AFFILIATE_TERMS_SLUG);
  check('  …and the publish script and the seed registry name ONE file, which is there',
    scriptPath !== '' && scriptPath === registered?.file && src(scriptPath).length > 4000
    && scriptMentions.length === 1,
    `const ${scriptPath || '(none)'} · registry ${registered?.file ?? '(none)'} · named as `
    + `${scriptMentions.join(', ') || '(nowhere)'} · ${src(scriptPath).length} characters`
    + ' — a registry naming a file that is not there reports no_file and shows an empty Content screen');

  // ── 10b. THE PORTAL'S OWN TERMS PAGE, AND WHAT *THEY* ACCEPTED ───────────────────────────────
  /**
   * Here rather than beside the menu clauses, because it needs what section 10 has just built: two
   * PUBLISHED versions of the real slug, with different bodies. "It shows the version they accepted
   * rather than the newest one" cannot be asserted where only one version exists.
   *
   * THE THREE STATES ARE DRIVEN, not reasoned about. The middle one is every affiliate who joined
   * before publication, and the third is a record we do not have — three sentences, because the
   * actions they ask for are different.
   */
  console.log('\n— and the agreement opens inside the portal, saying what THEY accepted —');
  const anonTerms = await ask(AFF_HOST, NAV.PORTAL_TERMS_PATH);
  check('the portal’s terms page is refused to a visitor with no session', anonTerms.status === 307,
    `${anonTerms.status} — it carries a date against a person, which the public page cannot know`);
  check('  …and it 404s on the apex and on the rep host, like every other portal page',
    (await ask(APEX_HOST, NAV.PORTAL_TERMS_PATH)).status === 404
    && (await ask(REP_HOST, NAV.PORTAL_TERMS_PATH)).status === 404,
    'the bare address is rewritten on ONE host; nothing rewrites it anywhere else');

  /**
   * STATE (a): THEY ACCEPTED THE FIRST VERSION, AND A SECOND IS NOW PUBLISHED.
   * The two acceptance rows section 10 appended are replaced by exactly ONE with a known date, so
   * "the latest acceptance" is a fact and not a race between two rows written milliseconds apart.
   */
  await prisma.repTermsAcceptance.deleteMany({ where: { rep_id: affiliate.id } });
  await prisma.repTermsAcceptance.create({
    // A DATE THAT IS NOT THE VERSION STAMP. Version 1 is stamped from its effective date
    // (2026-10-31), so accepting ON that day would make "it names the date" pass on the string the
    // version clause already matched — one value standing in for two facts.
    data: { rep_id: affiliate.id, version: stored1.version, document_id: draft.id, accepted_at: new Date('2026-10-20T09:15:00Z') },
  });
  const tA = await ask(AFF_HOST, NAV.PORTAL_TERMS_PATH, { cookie: jarEarly });
  check('it names the version they accepted, and the day',
    tA.status === 200 && tA.body.includes(stored1.version) && tA.body.includes('2026-10-20')
    && stored1.version !== '2026-10-20',
    `${tA.status} · version ${stored1.version} accepted 2026-10-20`);
  /**
   * AND IT SHOWS THAT VERSION'S WORDS. The two published bodies differ in ONE sentence — version 1
   * carries the minimum-payout sentence and version 2 omits it, because the setting moved between
   * them — so that sentence is the only honest discriminator. The version stamp PublicDocument
   * prints is asserted beside it: a page showing version 1's stamp over version 2's body would
   * satisfy either clause alone.
   */
  check('  …and renders THAT version, not whatever is published today',
    tA.body.includes(`>${stored1.version}<`) && /The minimum payout is £100;/.test(tA.body),
    'the sentence is in version 1 and absent from version 2 — see section 10');
  check('  …and tells them a newer one exists rather than quietly swapping it in',
    /data-testid="portal-terms-newer"/.test(tA.body) && tA.body.includes(stored3.version),
    `the current published version is ${stored3.version}`);
  check('  …with no settled summary on the page, because there is a document',
    !/data-testid="portal-terms-summary"/.test(tA.body) && /data-testid="portal-terms-document"/.test(tA.body));

  /**
   * STATE (b): A DATE AND NO VERSION — accepted the summary, before anything was published. This is
   * the state the owner's own affiliate row is in, which is why it is written for rather than
   * treated as a gap.
   */
  await prisma.repTermsAcceptance.deleteMany({ where: { rep_id: affiliate.id } });
  const tB = await ask(AFF_HOST, NAV.PORTAL_TERMS_PATH, { cookie: jarEarly });
  check('an affiliate who accepted before publication is told so, in those words',
    tB.status === 200 && /carried no version number then/.test(tB.body),
    'inventing a stamp would reference words that never existed under that name');
  check('  …and is shown the summary they actually accepted',
    /data-testid="portal-terms-summary"/.test(tB.body) && !/data-testid="portal-terms-document"/.test(tB.body),
    'the published document is not what they agreed to');
  check('  …with the date from the rep row, which is the only record there is',
    tB.body.includes('2026-01-01'), 'Rep.terms_accepted_at — the fixture signed up on that day');

  /** STATE (c): NEITHER. Said plainly, with a way to put it right, and never filled in with today. */
  const acceptedAtWas = (await prisma.rep.findUnique({ where: { id: affiliate.id }, select: { terms_accepted_at: true } })).terms_accepted_at;
  await prisma.rep.update({ where: { id: affiliate.id }, data: { terms_accepted_at: null } });
  const tC = await ask(AFF_HOST, NAV.PORTAL_TERMS_PATH, { cookie: jarEarly });
  /**
   * THE FIRST VERSION OF THIS SWEPT THE WHOLE PAGE FOR TODAY'S DATE and went red on correct code:
   * version 2 was published with an effective date of today, so the "a newer version exists" notice
   * names it legitimately. The claim is about the ACCEPTANCE SENTENCE, so that is what is asserted —
   * a term has to be unique to its subject.
   */
  check('with no record at all it says so, and does not invent an acceptance',
    /no record of when you accepted/.test(tC.body) && !/You accepted/.test(tC.body),
    'today’s date in that sentence would be a claim about somebody’s agreement that nobody made');
  await prisma.rep.update({ where: { id: affiliate.id }, data: { terms_accepted_at: acceptedAtWas } });

  /**
   * AND THE WAY IN IS THE MENU ITEM, walked. The clause in section 4a asserts where it POINTS; this
   * one asserts that following it keeps you in the portal, with the rail, with the item marked —
   * and that it is a PAGE rather than a seventh pane, which is what the nav table says it is.
   */
  await page.goto(`${AFF}${PORTAL.portalHomePath('affiliate')}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="affiliate-home"]');
  await page.locator('[data-testid="portal-link-terms"]').click();
  // CAUGHT, so a menu item pointing somewhere else is a RED rather than a timeout that kills the
  // run and takes the forty clauses after it. The red-proof of this clause did exactly that.
  await page.waitForSelector('[data-testid="portal-terms-heading"]', { timeout: 15000 }).catch(() => {});
  check('clicking Terms in the menu stays inside the portal, with the menu',
    (await page.locator('[data-testid="portal-terms-heading"]').count()) === 1
    && new URL(page.url()).pathname === NAV.PORTAL_TERMS_PATH
    && await page.locator('[data-testid="portal-rail"]').isVisible()
    && (await page.locator('[data-testid="portal-link-terms"]').getAttribute('aria-current')) === 'page',
    `${new URL(page.url()).pathname} · aria-current=${await page.locator('[data-testid="portal-link-terms"]').getAttribute('aria-current')}`);
  check('  …and it is a page of its own rather than a seventh section of the dashboard',
    (await page.locator('[data-testid="portal-section-overview"]').count()) === 0
    && (await page.locator('[data-testid="portal-terms-accepted"]').isVisible()),
    'the dashboard’s panes are not here, and the acceptance line is');
  /**
   * ── AND THE MENU WORKS FROM THE TERMS PAGE, WHICH IS THE BUG THIS SECTION GREW BY ────────────
   * Shipped broken on 2026-11-01 and found by the owner on the live site: the shell rendered a bare
   * `#key` wherever it was mounted, so from /my-terms every section item pointed at
   * /my-terms#earnings — a page with no panes and no hashchange listener. Six menu items that
   * looked alive and did nothing.
   *
   * THE CLAUSES THAT MISSED IT ALL STARTED ON THE DASHBOARD. Section 4a walks every item with the
   * dashboard already open, where a bare hash is correct; 10b walked INTO the terms page and
   * stopped there. Nothing walked OUT. So this starts on /my-terms, returning to it before each
   * click, and asserts the landing: the dashboard, that section visible, and only that one.
   */
  console.log('\n— and from the terms page the menu goes back to the dashboard, not nowhere —');
  await page.goto(`${AFF}${NAV.PORTAL_TERMS_PATH}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="portal-terms-heading"]');
  const offHrefs = await Promise.all(NAV.PORTAL_SECTIONS.map((sec) => navOf(sec.key).getAttribute('href')));
  check('every section item carries the dashboard’s path while standing off it',
    offHrefs.every((h, i) => h === `${PORTAL.portalHomePath('affiliate')}#${NAV.PORTAL_SECTIONS[i].key}`),
    offHrefs.join(' '));
  for (const sec of NAV.PORTAL_SECTIONS) {
    // BACK TO THE TERMS PAGE FIRST, every time: the clause is about leaving it, and after the first
    // click the menu is being read from the dashboard, where a bare hash would work.
    if (new URL(page.url()).pathname !== NAV.PORTAL_TERMS_PATH) {
      await page.goto(`${AFF}${NAV.PORTAL_TERMS_PATH}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-testid="portal-terms-heading"]');
    }
    await navOf(sec.key).click();
    await page.waitForSelector('[data-testid="affiliate-home"]', { timeout: 15000 }).catch(() => {});
    await page.waitForFunction(
      (k) => !document.querySelector(`[data-testid="portal-section-${k}"]`)?.hasAttribute('hidden'),
      sec.key, { timeout: 6000 },
    ).catch(() => {});
    const landedOnDashboard = new URL(page.url()).pathname === PORTAL.portalHomePath('affiliate');
    const vis = landedOnDashboard ? await visibleKeys() : [];
    check(`  …“${sec.label}” lands on the dashboard showing ${sec.key}, and nothing else`,
      landedOnDashboard && JSON.stringify(vis) === JSON.stringify([sec.key])
      && new URL(page.url()).hash === `#${sec.key}`,
      `${new URL(page.url()).pathname}${new URL(page.url()).hash} · visible: ${vis.join(', ') || 'none'}`);
  }
  /**
   * AND THE RULE ON ITS OWN, over both sides of it. Bare ON the dashboard matters as much as
   * absolute off it: making every item absolute would also have fixed the bug, and would re-pay
   * affiliatePortalData's whole chain to move between panes of a page that is already open.
   */
  check('the rule itself: bare on the dashboard, the dashboard’s path anywhere else',
    NAV.PORTAL_SECTIONS.every((sec) => NAV.sectionHref(sec.key, 'overview') === `#${sec.key}`)
    && NAV.PORTAL_SECTIONS.every((sec) => NAV.sectionHref(sec.key, 'earnings') === `#${sec.key}`)
    && NAV.PORTAL_SECTIONS.every((sec) => NAV.sectionHref(sec.key, 'terms')
      === `${PORTAL.portalHomePath('affiliate')}#${sec.key}`),
    `from a section: ${NAV.sectionHref('earnings', 'overview')} · from Terms: ${NAV.sectionHref('earnings', 'terms')}`);
  check('  …and "where you are" is read from the section table rather than guessed at',
    NAV.isSectionKey('earnings') && !NAV.isSectionKey('terms') && !NAV.isSectionKey('')
    && NAV.PORTAL_LINKS.every((l) => !NAV.isSectionKey(l.key)),
    'a link key that tested as a section would make the menu bare on the Terms page again');

  await page.goto(`${AFF}${PORTAL.portalHomePath('affiliate')}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="affiliate-home"]');
  check('  …and the dashboard’s footer points at it rather than at the public page',
    (await page.locator('[data-testid="affiliate-terms-footer-link"]').getAttribute('href')) === NAV.PORTAL_TERMS_PATH
    && (await page.locator('[data-testid="affiliate-terms-accepted"]').count()) === 0,
    'the acceptance line moved to the page that answers it in all three states');

  // ── 10c. A DOCUMENT WHOSE FIRST DRAFT SHIPS IN THE REPOSITORY ────────────────────────────────
  /**
   * The owner asked for his v1 terms text to be in Engine Room → Content as an UNPUBLISHED draft,
   * on production, so he can see and edit it there — with publishing still a separate step after
   * the solicitor.
   *
   * DRIVEN WITH A FIXTURE SLUG AND AN INJECTED READER, not against the real affiliate-terms row:
   * section 10 above is still using that slug, and a seed firing into it mid-gate would be this
   * gate's own side effects breaking its own later clauses. The injected reader is also how the
   * 'no file' outcome is reached without deleting a file from the repository.
   *
   * THE REAL REGISTRY IS ASSERTED SEPARATELY, from disk, at the end — the mechanism being right is
   * no use if the path it is pointed at does not exist in production.
   */
  console.log('\n— and a document whose first draft ships in the repository arrives once, as a draft —');
  const seedSlug = `${SEED_MARK}-${randomUUID().slice(0, 8)}`;
  const seedReg = [{ slug: seedSlug, country: 'GB', type: 'legal', file: 'fixture.md', fallbackTitle: 'A FALLBACK NAME' }];
  const SEED_BODY = '# A Seeded Document\n\nIt still says {{totalReward}}, because a draft holds placeholders.\n';
  const seedRows = () => prisma.document.findMany({ where: { slug: seedSlug }, orderBy: { created_at: 'asc' } });

  const first = await SEED.seedContentDrafts(prisma, () => SEED_BODY, seedReg);
  const afterFirst = await seedRows();
  check('the first look puts the draft in', first[0]?.result === 'seeded' && afterFirst.length === 1,
    `${first[0]?.result} · ${afterFirst.length} row(s)`);
  check('  …as a DRAFT, unpublished, with no date on it',
    afterFirst[0]?.status === 'draft' && afterFirst[0]?.version === CONTENT.DRAFT
    && afterFirst[0]?.published_at === null && afterFirst[0]?.effective_from === null,
    `${afterFirst[0]?.status}/${afterFirst[0]?.version} published_at=${afterFirst[0]?.published_at}`);
  check('  …named from the file’s own heading rather than the fallback',
    afterFirst[0]?.title === 'A Seeded Document',
    `${afterFirst[0]?.title} — the fallback is "${seedReg[0].fallbackTitle}"`);
  check('  …holding the placeholders, because publishing is what bakes them',
    TERMS.hasPlaceholder(afterFirst[0]?.body ?? ''),
    'baking it now would mean the owner’s next edit started from substituted text');
  check('  …and attributed to nobody, because no operator did it',
    afterFirst[0]?.created_by === null,
    'a sentinel actor id would be a lie in the one table whose job is saying who did what');
  const seedAudit = await prisma.superAdminAudit.findMany({
    where: { action: SEED.SEED_AUDIT_ACTION, target_name_snapshot: SEED.seedTarget(seedSlug, 'GB') },
  });
  check('  …with an audit row whose actor is the platform',
    seedAudit.length === 1 && seedAudit[0].operator_user_id === null && seedAudit[0].actor_rep_id === null,
    `${seedAudit.length} row(s)`);

  const second = await SEED.seedContentDrafts(prisma, () => SEED_BODY, seedReg);
  check('the second look does nothing at all',
    second[0]?.result === 'exists' && (await seedRows()).length === 1, `${second[0]?.result}`);

  /**
   * ── AND A DISCARD STAYS DISCARDED, which is the guard the row count cannot provide ───────────
   * Deleting the draft is what the Engine Room's own "discard" does. Without the audit guard the
   * seed would put it straight back on the next page load, for ever — the owner would be unable to
   * get rid of a document we decided to give him.
   */
  await prisma.document.deleteMany({ where: { slug: seedSlug } });
  const third = await SEED.seedContentDrafts(prisma, () => SEED_BODY, seedReg);
  check('a discarded draft is NOT seeded again',
    third[0]?.result === 'already_seeded' && (await seedRows()).length === 0,
    `${third[0]?.result} · ${(await seedRows()).length} row(s) — the audit row outlives its subject`);

  /** AN ALREADY-PUBLISHED DOCUMENT IS LEFT ALONE, and is a different outcome from having been seeded. */
  const otherSlug = `${SEED_MARK}-${randomUUID().slice(0, 8)}`;
  await prisma.document.create({
    data: {
      slug: otherSlug, title: 'Published already', type: 'legal', country_code: 'GB',
      body: 'Live words.', version: '2026-01-01', status: 'published', published_at: new Date(), effective_from: new Date(),
    },
  });
  const onPublished = await SEED.seedContentDrafts(prisma, () => SEED_BODY, [{ ...seedReg[0], slug: otherSlug }]);
  check('a document that already has a published version is left alone',
    onPublished[0]?.result === 'exists'
    && (await prisma.document.count({ where: { slug: otherSlug } })) === 1,
    `${onPublished[0]?.result} — seeding a draft beside it would be the editor’s job, not ours`);

  /** NO FILE IS AN OUTCOME, NOT A THROW: this runs inside the page that LISTS documents. */
  const missingSlug = `${SEED_MARK}-${randomUUID().slice(0, 8)}`;
  const onMissing = await SEED.seedContentDrafts(prisma, () => null, [{ ...seedReg[0], slug: missingSlug }]);
  check('a missing file is reported and writes nothing — not a draft, not an audit row',
    onMissing[0]?.result === 'no_file'
    && (await prisma.document.count({ where: { slug: missingSlug } })) === 0
    && (await prisma.superAdminAudit.count({ where: { action: SEED.SEED_AUDIT_ACTION, target_name_snapshot: SEED.seedTarget(missingSlug, 'GB') } })) === 0,
    `${onMissing[0]?.result} — an audit row here would stop the real file ever being seeded`);
  const noHeadingSlug = `${SEED_MARK}-${randomUUID().slice(0, 8)}`;
  await SEED.seedContentDrafts(prisma, () => 'No heading in this one.', [{ ...seedReg[0], slug: noHeadingSlug }]);
  check('  …and a file with no heading takes the fallback name rather than an empty title',
    (await prisma.document.findFirst({ where: { slug: noHeadingSlug }, select: { title: true } }))?.title === 'A FALLBACK NAME');

  /**
   * ── THE REAL REGISTRY: THE RIGHT SLUG, AND A FILE THAT IS ACTUALLY THERE ─────────────────────
   * The mechanism above is proved with a fixture. This is the part that is wrong in production if
   * it is wrong: the slug the public page and the signup's acceptance row resolve, and a path that
   * exists on disk and gives the document its name.
   */
  const realEntry = SEED.SEEDABLE_DRAFTS.find((d) => d.slug === TERMS.AFFILIATE_TERMS_SLUG);
  check('the registry seeds the affiliate terms, as a GB legal document',
    !!realEntry && realEntry.type === 'legal' && realEntry.country === 'GB',
    SEED.SEEDABLE_DRAFTS.map((d) => `${d.slug}/${d.country}`).join(', '));
  const realFile = src(realEntry?.file ?? '');
  check('  …from a file that is in the repository, at that exact path',
    realFile.length > 4000, `${realEntry?.file} — ${realFile.length} characters`);
  /**
   * ── AGAINST THE FILE'S FIRST LINE, NOT AGAINST THE REGISTRY'S FALLBACK ───────────────────────
   * This read `title !== fallbackTitle` and went red: the file's heading and the fallback I had
   * written are the same words, so one string was standing in for two different facts and the
   * clause could not tell "the heading won" from "the fallback was used". The oracle is now the
   * file's own first line, parsed a different way from the function under test.
   */
  const realHeading = realFile.split('\n')[0].replace(/^#\s*/, '').trim();
  check('  …whose own heading is what the draft would be called',
    realHeading.length > 5 && SEED.titleFromMarkdown(realFile, 'A FALLBACK NOBODY WOULD WANT') === realHeading,
    `${realHeading} — read from the file, not from the registry`);
  /**
   * ── AND THE REAL ENTRY, DRIVEN THROUGH THE REAL FILE ─────────────────────────────────────────
   * Everything above proves the mechanism with an injected reader. This runs the REGISTERED entry —
   * its own `file`, read off the disk — so the path, the parse and the shape of the row are proved
   * together. Only the SLUG is a fixture one: the real slug is taken by section 10's documents, and
   * one draft per slug means seeding into it would make this gate's own later clauses fail.
   */
  const realSlugged = `${SEED_MARK}-${randomUUID().slice(0, 8)}`;
  const viaRealFile = await SEED.seedContentDrafts(prisma, (rel) => src(rel) || null, [{ ...realEntry, slug: realSlugged }]);
  const realDraft = await prisma.document.findFirst({ where: { slug: realSlugged } });
  check('the registered file itself produces a draft, titled from its own heading',
    viaRealFile[0]?.result === 'seeded' && realDraft?.title === realHeading
    && realDraft?.status === 'draft' && realDraft?.version === CONTENT.DRAFT,
    `${viaRealFile[0]?.result} · ${JSON.stringify(realDraft?.title)}`);
  check('  …carrying the whole document, unbaked, ready to be edited and then published',
    (realDraft?.body?.length ?? 0) === realFile.length && TERMS.hasPlaceholder(realDraft?.body ?? ''),
    `${realDraft?.body?.length} characters of ${realFile.length}, placeholders intact`);

  /**
   * AND THE TWO THINGS THAT ARE ONLY WRONG IN PRODUCTION. The Content screen has to CALL it, and
   * the file has to be traced into the serverless function — an untraced file is simply absent
   * there, the seed reports 'no_file' for ever, and nothing fails anywhere a gate can see it.
   * Asserted by reading the source, which is the only way to assert a build-time include.
   */
  check('  …the Content screen is what calls it',
    /seedContentDrafts\(/.test(src('pages/api/superadmin/content.ts')),
    'the draft appears when the owner opens Engine Room → Content, which is where he asked to see it');
  check('  …and content/** is traced into the deployed function',
    /outputFileTracingIncludes/.test(src('next.config.js')) && /'\.\/content\/\*\*'/.test(src('next.config.js')),
    'the tracer cannot see a path built from process.cwd() at runtime — the locale files learnt this first');

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
  // ── 12b. THE WAY OUT ─────────────────────────────────────────────────────────────────────────
  /**
   * SIGN OUT IS PROVED BY SIGNING OUT, not by a control existing and not by reading the source for
   * `signOut(`. The portal is reached by an emailed link, so somebody who opens it on a borrowed
   * phone has no other way to end the session — a button that renders and does nothing is the
   * failure that matters, and it looks identical to one that works.
   *
   * IN ITS OWN CONTEXT, with its own link, because this destroys the session: the rest of the gate
   * is still using the cookie from the first one.
   */
  console.log('\n— and the way out actually lets go —');
  const outCtx = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': SIGNIN_IP } });
  const outPage = await outCtx.newPage();
  const outLink = await RM.mintRepLink({ repId: affiliate.id, sentTo: affiliate.email, baseUrl: AFF });
  await outPage.goto(outLink.url, { waitUntil: 'domcontentloaded' });
  await outPage.waitForSelector('[data-testid="affiliate-enter"]');
  await outPage.click('[data-testid="affiliate-enter"]');
  await outPage.waitForSelector('[data-testid="affiliate-home"]', { timeout: 20000 }).catch(async (e) => {
    throw new Error(`the second sign-in never landed (${outPage.url()}) — ${await signInLimitNote(SIGNIN_IP)} — ${String(e).slice(0, 80)}`);
  });
  const hadSession = (await outCtx.cookies()).some((c) => /next-auth\.session-token/.test(c.name));
  check('a second sign-in gets its own session', hadSession);
  await outPage.locator('[data-testid="portal-signout"]').click();
  await outPage.waitForURL((u) => AM.urlUnder(String(u), PORTAL.portalSignInPath('affiliate')), { timeout: 10000 })
    .catch(() => {});
  check('  …and Sign out lands on the portal’s own sign-in page',
    AM.urlUnder(outPage.url(), PORTAL.portalSignInPath('affiliate')), outPage.url());
  const stillThere = (await outCtx.cookies()).filter((c) => /next-auth\.session-token/.test(c.name) && c.value);
  check('  …with the session cookie gone, not just the page changed',
    stillThere.length === 0, stillThere.map((c) => `${c.name} still set`).join(', ') || 'no session cookie remains');
  // THE REAL TEST OF A SIGN-OUT: the page it was protecting no longer opens for that browser.
  await outPage.goto(`${AFF}${PORTAL.portalHomePath('affiliate')}`, { waitUntil: 'domcontentloaded' });
  check('  …and the dashboard no longer opens in that browser',
    !AM.urlUnder(outPage.url(), PORTAL.portalHomePath('affiliate'))
    || (await outPage.locator('[data-testid="affiliate-home"]').count()) === 0, outPage.url());
  await outCtx.close();

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

  // ── 14. THE KEY MUST BELONG TO THE DATABASE IT IS POINTED AT ─────────────────────────────────
  console.log('\n— a key that is not this database’s is refused, on every side —');
  const KC = await import('../lib/payee-key-check.ts');
  const myKey = process.env.PAYEE_ENC_KEY;
  const myFp = CRYPTO.payeeKeyFingerprint();
  const otherKey = randomBytes(32).toString('base64');
  const otherFp = CRYPTO.fingerprintOf(otherKey);

  check('a fingerprint is 16 hex', /^[0-9a-f]{16}$/.test(myFp), myFp);
  check('  …stable for the same key', CRYPTO.fingerprintOf(myKey) === myFp);
  check('  …and different for a different key', otherFp !== myFp, `${myFp} vs ${otherFp}`);
  // NOT A PROOF OF ONE-WAYNESS — that rests on HMAC-SHA256 — but it would catch the obvious
  // disaster of a "fingerprint" that embedded the key, which is the mistake worth a clause.
  check('  …and carries no part of the key', !myFp.includes(myKey.slice(0, 8)) && !myKey.includes(myFp),
    'a prefix of a base64 key is a prefix of a key');
  let shortKey = null;
  try { CRYPTO.fingerprintOf(Buffer.from('short').toString('base64')); } catch (e) { shortKey = e; }
  check('  …and a key of the wrong length cannot be fingerprinted at all', !!shortKey,
    'a fingerprint of the wrong thing would be registered as if it were right');

  check('the key in use is the one registered for this environment',
    KC.refusePayeeKey('test', myFp) === null, `${myFp} is registered for test`);
  /**
   * ── BOTH ENVIRONMENTS ARE REGISTERED NOW, AND THE INTERESTING CLAUSE IS THAT THEY DIFFER ──────
   * Registering the same key for both would match everywhere and check nothing — the one mistake a
   * fingerprint cannot catch on its own, and the likeliest one, because the gate fingerprint is the
   * one already in front of you when you edit that file.
   */
  const reg = KC.PAYEE_KEY_FINGERPRINTS;
  check('both environments have a registered fingerprint',
    /^[0-9a-f]{16}$/.test(reg.test ?? '') && /^[0-9a-f]{16}$/.test(reg.production ?? ''),
    `test ${reg.test} · production ${reg.production}`);
  check('  …and they are DIFFERENT keys', reg.test !== reg.production,
    'the same key registered for both would satisfy every check and verify nothing');
  check('  …so the gate key does not satisfy production', KC.refusePayeeKey('production', reg.test)?.code === 'fingerprint_mismatch',
    'this is the exact hazard: a tool holding the gate key, pointed at production');
  check('  …nor the production key this database', KC.refusePayeeKey('test', reg.production ?? '')?.code === 'fingerprint_mismatch',
    'and the reverse, which is how a production key would reach a gate run');
  // THE UNREGISTERED BRANCH, through an INJECTED register rather than by relying on a null in the
  // real one — it is registered now, and a clause that needed it to stay null would have gone red
  // the moment the owner did the thing the message asked for.
  const unregistered = KC.refusePayeeKey('production', myFp, { test: reg.test, production: null });
  check('an UNREGISTERED environment still refuses', unregistered?.code === 'fingerprint_unregistered');
  check('  …naming where to record it', /PAYEE_KEY_FINGERPRINTS/.test(unregistered?.message ?? ''));
  check('  …an unknown marker refuses rather than guessing',
    KC.refusePayeeKey(null, myFp)?.code === 'environment_unknown');
  check('  …no key at all is its OWN refusal, not a mismatch',
    KC.refusePayeeKey('test', null)?.code === 'no_key',
    '"you have the wrong key" and "you have no key" need different things done about them');
  const mismatch = KC.refusePayeeKey('test', otherFp);
  check('  …and the wrong key is a MISMATCH', mismatch?.code === 'fingerprint_mismatch');
  check('    …printing both fingerprints, because neither is a secret',
    (mismatch?.message ?? '').includes(otherFp) && (mismatch?.message ?? '').includes(myFp), mismatch?.message?.slice(0, 90));
  check('    …and saying nothing was touched', /NOTHING has been read or written/i.test(mismatch?.message ?? ''));

  // ── THE REVEAL SIDE, WITH THE WRONG KEY IN HAND ──────────────────────────────────────────────
  // Driven in-process: lib/payee-crypto reads process.env on every call, so the key can be swapped
  // without a restart. Restored immediately — every clause after this one needs the real one.
  const auditBefore = await prisma.superAdminAudit.count({ where: { target_rep_id: affiliate.id, action: 'rep.bank_viewed' } });
  process.env.PAYEE_ENC_KEY = otherKey;
  const revealWrong = await PADMIN.revealPayee(prisma, { repId: affiliate.id, operatorUserId: operator.id });
  process.env.PAYEE_ENC_KEY = myKey;
  check('a reveal with the wrong key is REFUSED', revealWrong.ok === false && revealWrong.code === 'fingerprint_mismatch',
    JSON.stringify(revealWrong).slice(0, 110));
  check('  …before the audit row is written, so no "somebody looked" is recorded for a look that could not happen',
    (await prisma.superAdminAudit.count({ where: { target_rep_id: affiliate.id, action: 'rep.bank_viewed' } })) === auditBefore,
    'the guard sits above the audit write on purpose');
  check('  …and it does NOT report the row as damaged',
    !/damaged|will not decrypt/i.test(revealWrong.message ?? ''),
    'the decrypt would have thrown PayeeCipherError and blamed the data; this names the environment');
  check('  …while the right key still reveals',
    (await PADMIN.revealPayee(prisma, { repId: affiliate.id, operatorUserId: operator.id })).ok === true);
  /**
   * AND IF THE GUARD IS EVER BYPASSED, IT STILL REFUSES RATHER THAN THROWING. Found by a red-proof
   * that removed the guard: the decrypt threw out of revealPayee and killed the caller, which in the
   * Engine Room is a 500 on a button press. Asserted here as a SHAPE, because the only way to reach
   * it is to break the guard first.
   */
  const adminSrc = src('lib/payee-admin.ts');
  check('  …and a decrypt that somehow still fails is a refusal, not a throw',
    /catch \(e\)/.test(adminSrc) && /PayeeCipherError/.test(adminSrc) && /'undecryptable'/.test(adminSrc),
    'an operator pressing a button should never be shown a stack trace about a sort code');

  // ── THE ROUTE SIDE ───────────────────────────────────────────────────────────────────────────
  // The SERVER holds its own environment, so a wrong key there needs a restart — proved separately
  // as a red-proof. What is asserted here is that the route consults the guard BEFORE it encrypts,
  // which is the ordering a later edit could quietly lose.
  const routeSrc = src('pages/api/affiliate-portal/payee.ts');
  check('the payee route consults the key guard', /payeeKeyRefusal/.test(routeSrc));
  /**
   * THE CALL, NOT THE IMPORT. The first version compared indexOf('payeeKeyRefusal'), which finds the
   * IMPORT LINE at the top of the file — so it measured the import's position and could never go
   * red. A red-proof that genuinely moved the guard below the encrypt left it green. One name, two
   * subjects: the term has to be unique to the thing being asserted.
   */
  const guardAt = routeSrc.indexOf('await payeeKeyRefusal(prisma)');
  const encryptAt = routeSrc.indexOf('encryptPayee(clean.sortCode)');
  check('  …before it encrypts anything', guardAt > 0 && encryptAt > 0 && guardAt < encryptAt,
    `guard at ${guardAt}, first encrypt at ${encryptAt} — checking after the encrypt is checking after the damage`);
  check('  …and the reveal path consults it too', /payeeKeyRefusal/.test(src('lib/payee-admin.ts')));
  check('  …and so does the one-off script', /payeeKeyRefusal/.test(src('scripts/encrypt-rep-bank.mjs')));

  // ── AND THE SCRIPT SIDE, DRIVEN FOR REAL AGAINST A PLANTED PLAINTEXT ROW ─────────────────────
  // The only way to reach the script's key check is to give it work: a Rep holding bank details in
  // clear. Rep_bank_chk is all-three-or-none, so all three are planted.
  const plain = await prisma.rep.create({
    data: {
      party_type: 'affiliate', email: `plain-${randomUUID().slice(0, 8)}${MARK}`, name: `${PREFIX} Plaintext`,
      ref_code: `${PREFIX}P`, status: 'active',
      bank_account_name: 'Plain Text', bank_sort_code: '309999', bank_account_number: '55555555',
    },
    select: { id: true },
  });
  made.repIds.push(plain.id);

  /**
   * THE CHILD'S STDOUT GOES TO A FILE, NOT A PIPE. _gate-preflight refuses a piped stdout, and the
   * honest way past that is a file — not GATE_ALLOW_PIPE, which is the flag that let the nightly
   * backup report nothing for nineteen nights.
   */
  const { openSync, readFileSync: readF, closeSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const runScript = (keyValue, args = ['--write']) => {
    const logPath = `/tmp/zzap-enc-${randomUUID().slice(0, 8)}.log`;
    const fd = openSync(logPath, 'w');
    let status = 0;
    try {
      execFileSync('node', ['scripts/encrypt-rep-bank.mjs', ...args], {
        cwd: `${process.cwd()}`, stdio: ['ignore', fd, fd],
        env: { ...process.env, PAYEE_ENC_KEY: keyValue },
      });
    } catch (e) { status = e.status ?? -1; }
    closeSync(fd);
    return { status, out: readF(logPath, 'utf8') };
  };

  const wrongRun = runScript(otherKey);
  check('the script REFUSES to write with a key that is not this database’s', wrongRun.status === 2,
    `exit ${wrongRun.status}`);
  check('  …naming the mismatch', /fingerprint_mismatch/.test(wrongRun.out), (wrongRun.out.match(/REFUSED.*/) ?? [''])[0].slice(0, 100));
  check('  …and saying nothing was written', /NOTHING HAS BEEN WRITTEN/.test(wrongRun.out));
  const afterWrong = await prisma.rep.findUnique({ where: { id: plain.id }, select: { bank_sort_code: true } });
  check('  …and the row really is untouched', afterWrong.bank_sort_code === '309999',
    'the clause that matters: a refusal that had already rewritten a row would be a refusal too late');
  check('  …and it printed no digits', !wrongRun.out.includes('309999') && !wrongRun.out.includes('55555555'),
    'a log file on a laptop is exactly where a sort code should not end up');

  const dryRun = runScript('', []);
  check('the DRY RUN needs no key at all', dryRun.status === 0 && /DRY RUN/.test(dryRun.out),
    `exit ${dryRun.status} — counting is the question you ask first, and it decides whether a key is needed`);
  check('  …and reports the row as needing work without touching it', /1 row\(s\) would change/.test(dryRun.out)
    && (await prisma.rep.findUnique({ where: { id: plain.id }, select: { bank_sort_code: true } })).bank_sort_code === '309999',
    (dryRun.out.match(/\d+ row\(s\) would change/) ?? [''])[0]);
  check('  …and names the target and the marker it is pointed at',
    /target\s+\w+/.test(dryRun.out) && /marker\s+test/.test(dryRun.out),
    'migrate-apply prints the endpoint; this used to print nothing and could not say which database it had');

  const rightRun = runScript(myKey);
  check('the script encrypts with the RIGHT key', rightRun.status === 0 && /1 written/.test(rightRun.out),
    (rightRun.out.match(/\d+ written.*/) ?? [''])[0]);
  const afterRight = await prisma.rep.findUnique({
    where: { id: plain.id }, select: { bank_sort_code: true, bank_account_number: true, bank_account_last4: true },
  });
  check('  …to v1: ciphertext, with the plaintext gone', CRYPTO.isPayeeEncrypted(afterRight.bank_sort_code)
    && afterRight.bank_sort_code !== '309999' && CRYPTO.isPayeeEncrypted(afterRight.bank_account_number));
  check('  …filling the last four in the same write', afterRight.bank_account_last4 === '5555', String(afterRight.bank_account_last4));
  check('  …and it reads back with that key', CRYPTO.decryptPayee(afterRight.bank_sort_code) === '309999',
    'round-tripped through the real script, not through this process');
  /**
   * IDEMPOTENCE, AS THE CLAIM ACTUALLY IS: nothing written, and the ciphertext BYTE-IDENTICAL.
   * The first version of this pinned "0 written · 1 already done" and went red for a true reason —
   * by this point the affiliate's own row is encrypted too, so the already-done count is 2. Pinning
   * a count that legitimately moves is the defect property-gate discipline exists to stop; the
   * durable claim is that a second run does not re-encrypt, which a fresh IV would reveal.
   */
  const cipherBefore = afterRight.bank_sort_code;
  const secondRun = runScript(myKey);
  check('  …and running it again writes nothing', secondRun.status === 0 && /0 written/.test(secondRun.out),
    (secondRun.out.match(/\d+ written.*/) ?? [''])[0]);
  check('    …leaving the ciphertext byte-identical, so it was skipped and not re-encrypted',
    (await prisma.rep.findUnique({ where: { id: plain.id }, select: { bank_sort_code: true } })).bank_sort_code === cipherBefore,
    'a re-encrypt would produce a different IV and the same plaintext — silently churning rows');

  check('and production refuses without --yes-production — asserted on the source, since this is not production',
    /--yes-production was not passed/.test(src('scripts/encrypt-rep-bank.mjs'))
    && /process\.stdin\.isTTY/.test(src('scripts/encrypt-rep-bank.mjs')),
    'the TTY requirement is what stops this running from CI or from an agent');

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
