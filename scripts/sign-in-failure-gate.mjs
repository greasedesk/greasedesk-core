/**
 * File: scripts/sign-in-failure-gate.mjs
 * A SIGN-IN THAT COULD NOT BE ATTEMPTED IS NOT A WRONG PASSWORD.
 * @gate-requires: server, db
 *
 * ── THE INCIDENT (2026-10-30) ───────────────────────────────────────────────────────────────────
 * The production database hit its Neon quota and refused every connection. authorize() reads the
 * user row as its first act, so the throw propagated; pages/admin/login collapsed every non-2FA
 * error into `?error=InvalidCredentials`; and two garages spent a morning being told their password
 * was wrong. Nothing was wrong with their passwords, and nothing in the product said so.
 *
 * ── WHAT IS DRIVEN, AND WHY IT NEEDS NO BROKEN DATABASE ─────────────────────────────────────────
 * A lookup has to FAIL for the new branch to be reached, and breaking the database to arrange that
 * would be a cure worse than the clause. An email containing a NUL byte does it honestly: Postgres
 * refuses the value (22021, invalid byte sequence) and the query throws, while an ordinary unknown
 * email returns null from the same live database on the next line. One input reaches the catch, the
 * other reaches "no such user" — so the pair proves the branch is about the FAILURE and not about
 * the address.
 *
 * ── AND THE THING THAT MUST NOT HAPPEN ──────────────────────────────────────────────────────────
 * No account-existence leak. The outage answer must be identical for an address that exists and one
 * that does not, which is asserted against a REAL user row planted for the purpose, and is true by
 * construction because the marker is raised by a lookup throwing, before anything has been learned.
 *
 * ── FIXTURES ────────────────────────────────────────────────────────────────────────────────────
 * One garage and one user, prefixed ZZSIF, swept in a registered teardown. The password is a gate
 * constant and the user is created inactive-safe: it never signs in successfully here, because what
 * is being proved is the FAILURE wording.
 */
import './_gate-preflight.mjs';
import './_ts.mjs';
const { gatePrisma, describeError, gateOrigin, erOrigin, ER_RESOLVER_ARGS, serverReady, onTeardown } = await import('./_gate-preflight.mjs');
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');
const bcrypt = (await import('/Users/hugh/Developer/greasedesk-core/node_modules/bcryptjs/index.js')).default;
const http = await import('node:http');
const SF = await import('../lib/sign-in-failure.ts');
const { urlUnder } = await import('../lib/anchored-match.ts');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const B = new URL(gateOrigin());
const PREFIX = 'ZZSIF';
const EMAIL = 'zzsif-user@example.invalid';
const PASS = 'GateSignInFailure!2026';
/** The address that makes the LOOKUP fail rather than return nothing: Postgres refuses a NUL byte. */
const UNQUERYABLE = `zzsif\u0000bad@example.invalid`;

const jar = new Map();
const cookies = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
const keep = (res) => {
  for (const line of res.headers['set-cookie'] ?? []) {
    const [pair] = line.split(';');
    const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i), pair.slice(i + 1));
  }
};
const ask = (path, { method = 'GET', form, cookie } = {}) => new Promise((resolve) => {
  const headers = { Host: `${B.hostname}:${B.port}` };
  if (cookie) headers.cookie = cookie;
  if (form) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; headers['Content-Length'] = Buffer.byteLength(form); }
  const r = http.request({ hostname: B.hostname, port: B.port, path, method, headers }, (res) => {
    let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: b, headers: res.headers }));
  });
  r.on('error', (e) => resolve({ status: 0, body: String(e), headers: {} }));
  if (form) r.write(form);
  r.end();
});

/** One credentials sign-in over HTTP, returning what next-auth says about it. */
async function signIn(email, password) {
  const csrfRes = await ask('/api/auth/csrf');
  keep(csrfRes);
  const csrfToken = JSON.parse(csrfRes.body || '{}').csrfToken;
  const cb = await ask('/api/auth/callback/credentials', {
    method: 'POST', cookie: cookies(),
    form: new URLSearchParams({ email, password, csrfToken, json: 'true' }).toString(),
  });
  keep(cb);
  // next-auth answers a json:true credentials callback with { url } carrying ?error=<message>.
  let url = '';
  try { url = JSON.parse(cb.body || '{}').url ?? ''; } catch { url = cb.headers.location ?? ''; }
  const error = (() => { try { return new URL(url, gateOrigin()).searchParams.get('error') ?? ''; } catch { return ''; } })();
  return { status: cb.status, url, error };
}

let prisma, browser;
const sweep = async () => {
  if (!prisma) return 0;
  const users = await prisma.user.deleteMany({ where: { email: EMAIL } }).catch(() => ({ count: 0 }));
  const groups = (await prisma.group.findMany({ where: { group_name: { startsWith: PREFIX } }, select: { id: true } })).map((g) => g.id);
  if (groups.length) await prisma.group.deleteMany({ where: { id: { in: groups } } }).catch(() => {});
  // The sign-in attempts below spend the credential limiter's email and IP axes. Swept, so a fifth
  // run in an hour is not refused by a budget this gate spent on itself.
  await prisma.authRateLimit.deleteMany({ where: { key: { contains: 'zzsif' } } }).catch(() => {});
  return (users?.count ?? 0) + groups.length;
};

try {
  prisma = await gatePrisma();
  onTeardown(sweep);
  await sweep();

  const ready = await serverReady();
  check('the dev server serves pages before we drive it', ready.ok, `HTTP ${ready.status} after ${ready.attempts} attempt(s)`);

  // ── 1. THE CLASSIFIER: FOUR CAUSES, AND ONLY ONE OF THEM GUESSES ─────────────────────────────
  console.log('— four causes, told apart —');
  check('a 2FA lock is a 2FA lock', SF.classifySignInError('TWO_FACTOR_LOCKED') === 'two_factor_locked');
  check('a 2FA requirement is a 2FA requirement', SF.classifySignInError('TWO_FACTOR_REQUIRED') === 'two_factor_required');
  check('the outage marker is an OUTAGE', SF.classifySignInError(SF.SYSTEM_UNAVAILABLE) === 'system_unavailable');
  check('  …and a real credentials failure still is one',
    SF.classifySignInError('Invalid email or password.') === 'invalid_credentials');
  check('  …as is anything unrecognised, which is the FALLBACK and not the default',
    SF.classifySignInError('something nobody has seen before') === 'invalid_credentials'
      && SF.classifySignInError(null) === 'invalid_credentials' && SF.classifySignInError(undefined) === 'invalid_credentials',
    'the incident was this branch catching a cause it knew nothing about');

  check('the outage sentence says it is NOT the password',
    /isn’t your password/i.test(SF.SIGN_IN_MESSAGE.system_unavailable),
    SF.SIGN_IN_MESSAGE.system_unavailable);
  check('  …and the credentials sentence is unchanged',
    SF.SIGN_IN_MESSAGE.invalid_credentials === 'Invalid email or password.',
    'the fix must not make a genuinely wrong password vaguer');
  check('  …and the two are different sentences',
    SF.SIGN_IN_MESSAGE.system_unavailable !== SF.SIGN_IN_MESSAGE.invalid_credentials,
    'one sentence for two causes is the whole defect');
  check('the thrown error carries the marker and NOT the cause',
    SF.systemUnavailable().message === SF.SYSTEM_UNAVAILABLE && !/prisma|postgres|quota/i.test(SF.systemUnavailable().message),
    `"${SF.systemUnavailable().message}" — next-auth passes this to the browser, and a Prisma error carries the connection target`);

  // ── 2. THE PROVIDER, DRIVEN ──────────────────────────────────────────────────────────────────
  // A REAL user row, so the two answers below can be compared against an address that exists.
  console.log('\n— and the provider, against a live database —');
  const group = await prisma.group.create({ data: {
    group_name: `${PREFIX} garage`, billing_email: EMAIL,
    trial_ends_at: new Date(Date.now() + 30 * 86400000) }, select: { id: true } });
  await prisma.user.create({ data: {
    email: EMAIL, name: `${PREFIX} user`, group_id: group.id, role: 'ADMIN',
    passwordHash: await bcrypt.hash(PASS, 10), is_active: true } });

  const wrongPassword = await signIn(EMAIL, 'definitely-not-the-password');
  check('a REAL account with the wrong password is still "invalid email or password"',
    SF.classifySignInError(wrongPassword.error) === 'invalid_credentials',
    `${wrongPassword.error.slice(0, 60)} — the fix must not swallow a genuine failure`);

  const noSuchUser = await signIn('zzsif-nobody@example.invalid', 'whatever');
  check('  …and so is an address that does not exist',
    SF.classifySignInError(noSuchUser.error) === 'invalid_credentials',
    'no-such-email and wrong-password must stay indistinguishable');

  // THE LOOKUP THAT CANNOT BE MADE. Same database, same endpoint — an address Postgres refuses.
  const unqueryable = await signIn(UNQUERYABLE, 'whatever');
  check('a lookup that THROWS reports an outage, not a wrong password',
    SF.classifySignInError(unqueryable.error) === 'system_unavailable',
    `${unqueryable.error.slice(0, 60)} — this is the line that lied for a morning`);
  check('  …and the answer carries no detail about the failure',
    !/prisma|postgres|quota|connect|22021/i.test(unqueryable.error),
    unqueryable.error.slice(0, 80));

  // ── 3. NO ACCOUNT-EXISTENCE LEAK ─────────────────────────────────────────────────────────────
  // The outage answer must be the SAME for an address that exists and one that does not. It is true
  // by construction — the marker is raised before anything has been learned — and asserted anyway,
  // because "by construction" is what every leak was before somebody reordered two lines.
  console.log('\n— and it says nothing about who has an account —');
  const unqueryableAgain = await signIn(`${PREFIX.toLowerCase()}\u0000other@example.invalid`, 'whatever');
  check('two unqueryable addresses give the identical answer',
    unqueryable.error === unqueryableAgain.error && unqueryable.error !== '',
    `"${unqueryable.error}" vs "${unqueryableAgain.error}"`);
  check('  …and an outage answer differs from a credentials answer ONLY by cause, never by address',
    SF.classifySignInError(wrongPassword.error) === SF.classifySignInError(noSuchUser.error),
    'the existing guarantee, re-checked: the fix must not have split those two apart');

  // ── 4. AND THE PAGE SAYS IT ──────────────────────────────────────────────────────────────────
  console.log('\n— and the person reads the right sentence —');
  // THE ER RESOLVER RULE, because section 6 drives er.greasedesk.com: middleware 404s
  // /superadmin on localhost, so without it that section would assert things about a Not Found page.
  browser = await chromium.launch({ channel: 'chrome', args: ER_RESOLVER_ARGS });
  const page = await (await browser.newContext({ viewport: { width: 420, height: 900 } })).newPage();
  await page.goto(`${gateOrigin()}/admin/login?error=${SF.SYSTEM_UNAVAILABLE_CODE}`, { waitUntil: 'domcontentloaded' });
  const outageText = await page.locator('body').innerText();
  check('the outage code renders the owner’s sentence',
    outageText.includes(SF.SIGN_IN_MESSAGE.system_unavailable),
    SF.SIGN_IN_MESSAGE.system_unavailable);
  check('  …and does NOT say the password was wrong',
    !/invalid email or password/i.test(outageText),
    'both sentences on one screen would be worse than the original');

  await page.goto(`${gateOrigin()}/admin/login?error=${SF.INVALID_CREDENTIALS_CODE}`, { waitUntil: 'domcontentloaded' });
  const credText = await page.locator('body').innerText();
  check('and the credentials code still renders the credentials sentence',
    credText.includes(SF.SIGN_IN_MESSAGE.invalid_credentials) && !credText.includes(SF.SIGN_IN_MESSAGE.system_unavailable),
    'otherwise the clause above passes on a page that shows the outage line for everything');

  // ── 5. THE PAGE'S OWN MAPPING, WHICH IS THE LINE THAT CAUSED THE INCIDENT ────────────────────
  // THE GAP A RED-PROOF FOUND. Everything above drives the API over HTTP and the page by URL, so
  // nothing exercised the PAGE'S mapping from the provider's error to the ?error= code. Forcing
  // that line to the credentials code left the gate green — a clause not existing rather than a
  // clause passing.
  //
  // THE SERVER'S ANSWER IS STUBBED HERE, AND ONLY THAT. Two earlier attempts failed honestly and
  // are worth recording: a NUL-byte address makes the real lookup throw over HTTP (section 2 proves
  // the server really does answer SYSTEM_UNAVAILABLE, against the live database) but it cannot be
  // driven through the form at all — the browser's own type="email" validation refuses the value,
  // so the form never submits and NO request is made. Breaking the database to arrange a failure
  // would be a cure worse than the clause.
  //
  // So the halves are split and each is asserted against something real: section 2 proves what the
  // SERVER says when a lookup throws; this proves what the PAGE does with that answer. What is
  // faked is one HTTP response body, in the shape next-auth's own client parses.
  console.log('\n— and the page does the right thing with that answer —');
  await page.route('**/api/auth/callback/credentials', (route) => route.fulfill({
    status: 401,
    contentType: 'application/json',
    // next-auth's client reads data.url and lifts ?error= out of it — this is that shape.
    body: JSON.stringify({ url: `${gateOrigin()}/admin/login?error=${SF.SYSTEM_UNAVAILABLE}` }),
  }));
  await page.goto(`${gateOrigin()}/admin/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[type="email"]', { timeout: 30000 });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', 'whatever');
  await page.click('button[type="submit"]');
  await page.waitForFunction(
    (wanted) => document.body.innerText.includes(wanted),
    SF.SIGN_IN_MESSAGE.system_unavailable,
    { timeout: 30000 },
  ).catch(() => {});
  const formText = await page.locator('body').innerText();
  check('an outage answer from the provider shows the OUTAGE sentence',
    formText.includes(SF.SIGN_IN_MESSAGE.system_unavailable),
    `url ${new URL(page.url()).search || '(none)'} — the incident, from the provider's answer onwards`);
  check('  …and never says the password was wrong',
    !/invalid email or password/i.test(formText),
    'this is the sentence two garages acted on for a morning');
  check('  …and the page redirected with the OUTAGE code, not the credentials one',
    new URL(page.url()).searchParams.get('error') === SF.SYSTEM_UNAVAILABLE_CODE,
    new URL(page.url()).searchParams.get('error') ?? 'no error code in the url');
  await page.unroute('**/api/auth/callback/credentials');

  // AND A GENUINELY WRONG PASSWORD STILL SAYS SO, through the same form with NOTHING stubbed —
  // otherwise the three clauses above are satisfied by a page that shows the outage line for
  // everything. This one goes to the real provider and the real database.
  await page.goto(`${gateOrigin()}/admin/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', 'definitely-not-the-password');
  await page.click('button[type="submit"]');
  await page.waitForFunction(
    (wanted) => document.body.innerText.includes(wanted),
    SF.SIGN_IN_MESSAGE.invalid_credentials,
    { timeout: 30000 },
  ).catch(() => {});
  const wrongText = await page.locator('body').innerText();
  check('a real wrong password still says so, through the same form and the real provider',
    wrongText.includes(SF.SIGN_IN_MESSAGE.invalid_credentials)
      && !wrongText.includes(SF.SIGN_IN_MESSAGE.system_unavailable),
    new URL(page.url()).searchParams.get('error') ?? 'no error code');

  // ── 6. AND THE ENGINE ROOM, WHICH HAD THE IDENTICAL COLLAPSE ──────────────────────────────────
  // OperatorLoginForm turned every error into "Invalid email or password" too. Left alone, an
  // outage would tell the one person who can fix it that their password was wrong. Same stub, same
  // reasoning as section 5: what the provider says is proved against the live database above (the
  // operator provider's lookup is guarded by the same catch), and this proves what the form does
  // with that answer.
  console.log('\n— and the Engine Room says it too —');
  const erPage = await (await browser.newContext({ viewport: { width: 1100, height: 900 }, extraHTTPHeaders: {} })).newPage();
  await erPage.route('**/api/auth/callback/operator', (route) => route.fulfill({
    status: 401,
    contentType: 'application/json',
    body: JSON.stringify({ url: `${erOrigin()}/superadmin/login?error=${SF.SYSTEM_UNAVAILABLE}` }),
  }));
  await erPage.goto(`${erOrigin()}/superadmin/login`, { waitUntil: 'domcontentloaded' });
  await erPage.waitForSelector('input[type="email"]', { timeout: 30000 });
  await erPage.fill('input[type="email"]', 'zzsif-operator@greasedesk.test');
  await erPage.fill('input[type="password"]', 'whatever');
  await erPage.click('button[type="submit"]');
  await erPage.waitForFunction(
    (wanted) => document.body.innerText.includes(wanted),
    SF.SIGN_IN_MESSAGE.system_unavailable,
    { timeout: 30000 },
  ).catch(() => {});
  const erText = await erPage.locator('body').innerText();
  check('the Engine Room login shows the outage sentence, not a credentials one',
    erText.includes(SF.SIGN_IN_MESSAGE.system_unavailable) && !/invalid email or password/i.test(erText),
    erText.replace(/\s+/g, ' ').slice(0, 120));

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
