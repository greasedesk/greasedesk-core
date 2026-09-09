/**
 * File: scripts/rep-auth-gate.mjs
 * A REP HAS NO PASSWORD, AND THE LINK THAT SIGNS THEM IN BURNS.
 * @gate-requires: server, db
 *
 * ── WHAT WAS RETRACTED, AND WHY THIS GATE IS THE RECORD OF IT ───────────────────────────────────
 * Layer 1 shipped a rep identity with a passwordHash and a credentials provider, mirroring Operator.
 * On 2026-09-09 that was reversed: a rep signs in with a single-use magic link sent to the address
 * that IS their credential, and Rep.passwordHash was DROPPED rather than left nullable — a sentinel
 * is a check that outlives the flow it guarded.
 *
 * A retraction leaves no artefact behind unless somebody writes one. This gate is that artefact: it
 * asserts the absence, so the next person who notices Operator has a password and Rep does not gets
 * a reason rather than a gap.
 *
 * ── THE SPEND IS A POST, NOT A PAGE LOAD, AND THAT IS A SECURITY DECISION ───────────────────────
 * Corporate mail scanners FOLLOW LINKS. If the token were consumed by GET, a scanner would burn it
 * somewhere between our sender and the rep's inbox, and the rep would click a dead credential every
 * single time. So /rep/enter/[token] renders a button and the token is spent on the POST behind it.
 * The gate drives the button rather than the URL, because driving the URL would prove the wrong thing.
 *
 * ── AND THE REP SESSION IS PROVED AGAINST /admin/*, NOT ASSUMED ─────────────────────────────────
 * The session cookie is host-only to reps.greasedesk.com, so it never reaches the tenant app at all.
 * That is the isolation working — and it is NOT what this gate tests, because a boundary that has
 * never been pushed is a boundary nobody has measured. The cookie is lifted out of the rep context
 * and planted on the apex host by hand. What that proves is the second layer: even holding a valid
 * rep session, the tenant guards refuse, because a rep has no group_id and no User row.
 *
 * Fixtures: one throwaway Rep, removed by its OWN id. Never TMBS, never ZZ — a rep belongs to no
 * tenant, so there is no tenant to scope to and the fixture is its own scope.
 */
import './_gate-preflight.mjs';
const { gatePrisma, serverReady, describeError, gateOrigin, repOrigin, REP_RESOLVER_ARGS } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');
const { readFileSync, readdirSync, existsSync } = await import('node:fs');
const { randomUUID } = await import('node:crypto');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };

const prisma = await gatePrisma();
const R = await import('../lib/rep-magic-link.ts').catch((e) => ({ __err: describeError(e) }));
const APEX = gateOrigin();
const REP = repOrigin();
const src = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
/** CODE ONLY — a comment explaining what was removed is not the thing being removed. */
const code = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

let repId = null, browser = null;
try {
  await serverReady();

  // ── 1. NO PASSWORD PATH REMAINS ───────────────────────────────────────────────────────────────
  console.log('\n— a rep has no password, anywhere —');
  const authSrc = src('pages/api/auth/[...nextauth].ts');
  const repProvider = (authSrc.match(/id:\s*'rep'[\s\S]*?\n    \}\),/) ?? [])[0] ?? '';
  check('the rep provider exists', repProvider.length > 0);
  check('  …and asks for no password', repProvider.length > 0 && !/password/i.test(repProvider),
    'a credentials provider with a password field is a password login whatever the column says');
  check('  …and never calls bcrypt', repProvider.length > 0 && !/bcrypt/.test(repProvider));
  check('the password sign-in page is gone', !existsSync('pages/rep/login-password.tsx')
    && !/signIn\('rep',[^)]*password/.test(code(src('pages/rep/login.tsx'))),
    'the page survives as the LINK REQUEST form; what went is the password it used to post');
  const schema = readFileSync('prisma/schema.prisma', 'utf8');
  const repModel = (/^model Rep \{([\s\S]*?)^\}/m.exec(schema) ?? [])[1] ?? '';
  check('the column is gone from the model', !/^\s*passwordHash/m.test(repModel));
  check('  …and from the database', await (async () => {
    const r = await prisma.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'Rep' AND column_name IN ('passwordHash','invite_token_hash','invite_token_expires','invite_token_used_at')`);
    return r[0].n === 0;
  })(), 'the schema file is a claim about the database, not the database');
  // EVERY rep-shaped source file, walked rather than guessed at. A ban that only looks where the
  // author remembered to look is a ban on the author's memory.
  const repRefs = [...readdirSync('.', { recursive: true, withFileTypes: true })]
    .filter((d) => d.isFile() && /\.tsx?$/.test(d.name))
    .map((d) => `${(d.parentPath ?? d.path).replace(/^\.\//, '')}/${d.name}`)
    .filter((f) => !f.includes('node_modules') && !f.includes('.next'))
    .filter((f) => /rep/i.test(f) && /passwordHash|invite_token/.test(code(src(f))));
  check('  …and nothing rep-shaped still references either', repRefs.length === 0, repRefs.join(', ') || 'no live reference');

  // ── 2. THE LINK BURNS ─────────────────────────────────────────────────────────────────────────
  console.log('\n— the link is the credential, and it is spent once —');
  check('lib/rep-magic-link loads', !R.__err, R.__err ?? '');
  if (R.__err) throw new Error(R.__err);
  const rep = await prisma.rep.create({
    data: { email: `rep-auth-gate-${randomUUID()}@greasedesk.invalid`, name: 'Rep Auth Gate',
      ref_code: `RAG${randomUUID().slice(0, 8)}` },
    select: { id: true, email: true },
  });
  repId = rep.id;

  const minted = await R.mintRepLink({ repId: rep.id, sentTo: rep.email, baseUrl: REP });
  check('the mint returns a raw token and a url on the rep host', !!minted.rawToken && minted.url.startsWith(REP));
  const stored = await prisma.repMagicLink.findFirst({ where: { rep_id: rep.id }, select: { token_hash: true, consumed_at: true, sent_to: true } });
  check('  …and stores only the HASH', stored.token_hash !== minted.rawToken && /^[0-9a-f]{64}$/.test(stored.token_hash),
    'a database reader must not be able to sign in as anybody');
  check('  …and records where it went', stored.sent_to === rep.email,
    'Rep.email can be changed by an operator; this is the answer to "who could have signed in?"');
  check('  …unspent', stored.consumed_at === null);

  const first = await R.spendRepLink(minted.rawToken, { ip: '::1' });
  check('the first spend succeeds', first.ok === true && first.repId === rep.id, JSON.stringify(first));
  const replay = await R.spendRepLink(minted.rawToken, { ip: '::1' });
  check('  …and the replay is REFUSED', replay.ok === false && replay.reason === 'consumed', JSON.stringify(replay));

  const expired = await R.mintRepLink({ repId: rep.id, sentTo: rep.email, baseUrl: REP });
  await prisma.repMagicLink.updateMany({ where: { token_hash: (await import('../lib/tokens.ts')).hashToken(expired.rawToken) },
    data: { expires_at: new Date(Date.now() - 60_000) } });
  check('an expired link is refused', (await R.spendRepLink(expired.rawToken, { ip: '::1' })).reason === 'expired');

  const revoked = await R.mintRepLink({ repId: rep.id, sentTo: rep.email, baseUrl: REP });
  await R.revokeRepLinks(rep.id, 'email_changed');
  check('a revoked link is refused', (await R.spendRepLink(revoked.rawToken, { ip: '::1' })).reason === 'revoked');
  check('an unknown token is refused', (await R.spendRepLink('0'.repeat(16), { ip: '::1' })).reason === 'not_found');

  // THE MECHANISM, not just the outcome. A read-then-write would pass every behavioural clause
  // above on a quiet machine and lose the race on a busy one.
  const libSrc = src('lib/rep-magic-link.ts');
  check('the spend is a conditional update, count-checked', /updateMany\(/.test(libSrc) && /count\s*===\s*1|count\s*!==\s*1/.test(libSrc));
  // THE REGION THAT MATTERS is from the function's first line to the updateMany that claims the
  // row. Reads AFTER the claim are fine and there are two — one to find the rep, one to name the
  // refusal — so scanning the whole body would flag the correct implementation.
  const spendBody = (libSrc.split('export async function spendRepLink')[1] ?? '').split('\nexport ')[0];
  check('  …with no read before the claim', !/findFirst|findUnique/.test(spendBody.split('updateMany(')[0]),
    'a read before the update is the window two replays both fall through');
  check('  …and it does not spend the CUSTOMER limiter', /repauth:ip:/.test(code(libSrc)) && !/magic:ip:/.test(code(libSrc)),
    'a shared key means a busy rep locks a customer out of their own invoice, and the reverse');

  // ── 3. THE SESSION IS SHORT, AND ONLY THE REP'S IS ────────────────────────────────────────────
  console.log('\n— twenty-four hours, for reps and nobody else —');
  // ── PROVED ON THE PURE RULE, AND THE CALLBACK IS PROVED TO ASK IT ────────────────────────────
  // authOptions cannot be imported here: next-auth/providers/credentials resolves to a namespace
  // rather than a callable under the gate's TypeScript loader, so `CredentialsProvider is not a
  // function` at module load. That is a harness limit, not a finding — and rather than stand
  // NextAuth up to test one comparison, the comparison is a pure function that this proves
  // directly, plus a source assertion that the callback asks it and asks nobody else.
  //
  // WHAT THIS DOES NOT PROVE: that a 25-hour-old cookie is refused end to end. Nothing here can
  // age a signed cookie, and saying so is better than a clause that reads as if it did.
  check('the rep session window is 24 hours', R.REP_SESSION_HOURS === 24, String(R.REP_SESSION_HOURS));
  const aged = (h) => Date.now() - h * 3600_000;
  check('a one-hour-old session is live', R.repSessionExpired(aged(1)) === false);
  check('a 23-hour-old session is still live', R.repSessionExpired(aged(23)) === false, 'the boundary, from the inside');
  check('a 25-hour-old session is expired', R.repSessionExpired(aged(25)) === true,
    'a borrowed handset must not still hold somebody else’s commission tomorrow');
  check('  …and a session with no stamp is expired', R.repSessionExpired(undefined) === true && R.repSessionExpired(0) === true,
    'fails closed: a token minted before the floor existed is not evidence of a recent sign-in');
  const jwtSrc = (authSrc.split('async jwt(')[1] ?? '').split('\n    },')[0];
  check('the jwt callback asks the rule rather than repeating it',
    /repSessionExpired\(token\.authAt\)/.test(jwtSrc) && !/REP_SESSION_HOURS\s*\*/.test(jwtSrc),
    'one comparison, in one place — a second copy is a second thing to be right about');
  check('  …only for reps', /tokenClass === 'rep'/.test(jwtSrc) && jwtSrc.indexOf("tokenClass === 'rep'") < jwtSrc.indexOf('repSessionExpired'),
    'the 90-day platform ruling stands for tenants and operators');

  // ── 4. A REP REACHES NO TENANT OR OPERATOR SURFACE ────────────────────────────────────────────
  console.log('\n— and reaches nothing that is not theirs —');
  browser = await chromium.launch({ channel: 'chrome', args: [...REP_RESOLVER_ARGS, '--host-resolver-rules=MAP reps.greasedesk.com 127.0.0.1'] });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  // ── THE PAGE MUST RENDER WITHOUT THROWING, AND THAT IS A STATED REQUIREMENT ─────────────────
  // It was enforced by accident before this line existed: pages/rep/enter/[token] pulled lib/db
  // into its bundle, PrismaClient threw on load, and Next's DEV ERROR OVERLAY intercepted the
  // click — so the gate failed with a click timeout. That protection is a dev-mode side effect and
  // dev mode does not exist in production, where the same page renders, the button is visible and
  // enabled, and pressing it does NOTHING. Relying on the overlay would mean the day it stops
  // intercepting, the click lands, this gate goes green and every rep is locked out.
  //
  // The precedent is costs-gate, which is the only other place in the suite that listens for this.
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 200)));
  const live = await R.mintRepLink({ repId: rep.id, sentTo: rep.email, baseUrl: REP });
  await page.goto(live.url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="rep-enter"]');
  check('the sign-in page runs without throwing', pageErrors.length === 0,
    pageErrors[0] ?? 'no uncaught error — the leak showed up here as "PrismaClient is unable to run in this browser environment"');
  await page.click('[data-testid="rep-enter"]');
  await page.waitForSelector('[data-testid="rep-home"]');
  check('the link signs the rep in', page.url().replace(/\/$/, '').endsWith('/rep'), page.url());
  check('  …and the portal it lands on runs without throwing either', pageErrors.length === 0,
    pageErrors[0] ?? 'still no uncaught error after the navigation');

  // ── AND THE BARE DOMAIN, WITH A SESSION, IS THE PORTAL ───────────────────────────────────────
  // The other half of the front door. rep-host-gate proves a visitor with no session lands on the
  // sign-in page; this proves the same URL serves the portal once they have one. Both halves,
  // because a root that always showed the sign-in page would pass the other clause and be just as
  // wrong — it would send a signed-in rep back to sign in again.
  await page.goto(`${REP}/`, { waitUntil: 'domcontentloaded' });
  check('the bare root serves the PORTAL to a signed-in rep',
    await page.locator('[data-testid="rep-home"]').count() === 1,
    `${page.url()} — the session decides which page the root serves, not whether it serves one`);
  check('  …without bouncing them to sign in again', !/\/rep\/login/.test(page.url()), page.url());

  // ── AND ITS 404 OFFERS A DOOR A REP CAN USE ──────────────────────────────────────────────────
  // The destination is chosen in a useEffect from window.location, so only a browser runs it — the
  // served HTML carries the default. Driven here, with a session, because after the sign-in
  // redirect a SIGNED-OUT visitor can no longer reach a 404 on this host at all.
  await page.goto(`${REP}/rep/runs/does-not-exist`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="not-found"]');
  const doorHref = await page.locator('[data-testid="not-found"] a').first().getAttribute('href');
  check('the 404 sends a rep to the rep portal, not a tenant dashboard', doorHref === '/',
    `${doorHref} — "Back to dashboard" is a dead end on a host where every tenant route 404s`);
  check('  …and offers no tenant support link', await page.locator('[data-testid="not-found"] a[href="/admin/support"]').count() === 0,
    'it does not exist on this host — middleware 404s it — so offering it is a second dead end');

  const cookies = await ctx.cookies();
  const session = cookies.find((c) => /next-auth\.session-token/.test(c.name));
  check('  …and the session cookie is host-only to the rep host', !!session && session.domain.replace(/^\./, '') === 'reps.greasedesk.com',
    session ? `${session.name} on ${session.domain}` : 'no session cookie');

  // THE COOKIE IS PLANTED ON THE APEX BY HAND. The browser would never send it there — that is the
  // isolation, and it is exactly why the guard underneath has never been exercised.
  await ctx.addCookies([{ ...session, domain: 'localhost', path: '/' }]);
  const apexPage = await ctx.newPage();
  const admin = await apexPage.goto(`${APEX}/admin/dashboard`, { waitUntil: 'domcontentloaded' });
  check('a REAL rep session is refused by the tenant app', admin.status() !== 200 || /\/admin\/login/.test(apexPage.url()),
    `${admin.status()} ${apexPage.url()} — no group_id, no User row: the tenant guards fail closed`);
  const er = await apexPage.goto(`${APEX}/superadmin/tenants`, { waitUntil: 'domcontentloaded' });
  check('  …and by the Engine Room, at the middleware', er.status() === 404, String(er.status()));

  // ── 5. AND CANNOT REWRITE ITS OWN CREDENTIAL ──────────────────────────────────────────────────
  console.log('\n— a rep changes neither their email nor their bank details —');
  const repApis = existsSync('pages/api/rep')
    ? readdirSync('pages/api/rep', { recursive: true }).filter((f) => /\.ts$/.test(String(f))).map((f) => `pages/api/rep/${f}`)
    : [];
  // ANCHORED AS A PROPERTY KEY, NOT A SUBSTRING. Bare /email/ also matches contact_email — the
  // address a rep publishes ON THEIR INVOICE, which they absolutely may edit — so the first version
  // of this flagged the profile route for doing exactly what it is for. The credential is the
  // column literally named 'email', and the discriminator is the underscore in front of the other.
  // Same trap as /RepVisit/ matching RepVisitAnswer; that is now nine instances in this suite.
  const FORBIDDEN_KEYS = /(^|[^_\w])(email|bank_account_name|bank_sort_code|bank_account_number)\s*:/;
  const writes = repApis.filter((f) => /rep\.update|repUpdate/.test(code(src(f))) && FORBIDDEN_KEYS.test(code(src(f))));
  check('no rep-facing route writes either', writes.length === 0, writes.join(', ') || `${repApis.length} rep routes, none writing the credential`);
  check('  …and the sweep really looked at something', repApis.length >= 1, `${repApis.length} routes under pages/api/rep`);
  // THE SCAN BITES. A negative assertion passes on a blank page, and this one now excludes a
  // legitimate near-miss — so both halves are proved on constructed sources rather than trusted.
  const bites = (s) => /(^|[^_\w])(email|bank_account_name|bank_sort_code|bank_account_number)\s*:/.test(s);
  check('  …and it FLAGS a route that would write the credential', bites('prisma.rep.update({ data: { email: x } })'));
  check('  …while contact_email is not the credential', !bites('prisma.rep.update({ data: { contact_email: x } })'),
    'the address on their invoice is theirs to change; the one they sign in with is not');
  check('  …and a sort code is still caught', bites('data: { bank_sort_code: x }'));
} catch (e) {
  check('run completed', false, describeError(e));
} finally {
  try { await browser?.close(); } catch {}
  // BY THE FIXTURE'S OWN ID. Links cascade from the rep, so the rep is the only thing to remove.
  if (repId) {
    try { const n = await prisma.repMagicLink.deleteMany({ where: { rep_id: repId } });
      await prisma.rep.delete({ where: { id: repId } });
      console.log(`\n✓ teardown removed the fixture rep and ${n.count} link(s)`);
    } catch (e) { console.log('\n✗ TEARDOWN FAILED:', describeError(e)); out.push('F'); }
  }
  await prisma.$disconnect();
}

console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
process.exit(out.includes('F') ? 1 : 0);
