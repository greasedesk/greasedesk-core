/**
 * File: scripts/rep-host-gate.mjs
 * THE REP PORTAL LIVES AT ONE HOST, AND NOWHERE ELSE.
 * @gate-requires: server
 *
 * ── WHY THIS IS ITS OWN STEP, AND ITS OWN GATE ──────────────────────────────────────────────────
 * middleware.ts runs on EVERY request. This codebase has broken every page twice from a change of
 * that reach, so the host routing lands alone, ahead of the schema, the auth retraction and the
 * invoice — with nothing else in the commit to argue about when something goes dark.
 *
 * reps.greasedesk.com joins er.greasedesk.com as a second isolated origin: its own cookie jar (the
 * session cookies are host-only by default — see the guardrail in pages/api/auth/[...nextauth].ts),
 * and one door. A rep signs in there and reaches nothing else; a tenant or an operator reaches the
 * rep portal from nowhere at all.
 *
 * ── HOW A REFUSAL IS TOLD APART FROM A GUARD ────────────────────────────────────────────────────
 * /rep 404s TWICE for different reasons, and asserting the status alone cannot tell them apart:
 * middleware returns `new NextResponse('Not Found', {status: 404})` — plain text, no markup —
 * while requireRepPage returns `notFound: true` and Next renders the 404 PAGE, an HTML document.
 * So `blocked` here means the MIDDLEWARE refused, proved by the body, and `reached` means the
 * request got past it to whatever the application decided. Without that split every clause below
 * would pass on a middleware that blocked everything, including the one host meant to work.
 *
 * This is deliberately NOT an assertion about rendered copy (see the standing rule: never assert
 * text from SSR HTML). `Not Found` is the middleware's own literal response body, and the presence
 * of a doctype is structure. Neither is page copy.
 *
 * ── THE SUBSTRING TRAP, WHICH IS NOT HYPOTHETICAL ───────────────────────────────────────────────
 * `pathname.startsWith('/api/rep')` also matches `/api/reports/vat-summary`, which exists and is a
 * tenant VAT return. `startsWith('/rep')` would match nothing today, but `/admin/settings/rep`
 * exists one directory up and is the kind of path that grows a sibling. Both are asserted below by
 * DRIVING them, not by reading the matcher — a matcher can be read as correct and still be wrong
 * about the one path nobody listed.
 *
 * NO FIXTURES, NO DATABASE, NO BROWSER. Requests carry an explicit Host header via node:http —
 * `Host` is a forbidden header name in fetch and undici strips it silently, which is how the
 * runner's own identity probe failed against GreaseDesk itself before it moved off fetch.
 */
import './_gate-preflight.mjs';
const { serverReady, describeError, gateOrigin, repOrigin, erOrigin } = await import('./_gate-preflight.mjs');
const http = await import('node:http');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };

const APEX = new URL(gateOrigin());
const REP_HOST = new URL(repOrigin()).hostname;
const ER_HOST = new URL(erOrigin()).hostname;

/** One request, with the Host the middleware will actually branch on. */
const ask = (host, path) => new Promise((resolve, reject) => {
  const req = http.request({
    hostname: APEX.hostname, port: APEX.port, path, method: 'GET',
    headers: { Host: host }, timeout: 15000,
  }, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { if (body.length < 2048) body += c; });
    res.on('end', () => resolve({ status: res.statusCode, body }));
  });
  req.on('timeout', () => { req.destroy(); reject(new Error(`timeout on ${host}${path}`)); });
  req.on('error', reject);
  req.end();
});

/** The middleware refused: its own literal body, which no page produces. */
const blocked = (r) => r.status === 404 && r.body.trim() === 'Not Found';
/** The request got PAST the middleware — whatever the application then decided. */
const reached = (r) => !blocked(r);

try {
  await serverReady();

  // ── 1. THE REP HOST IS THE REP PORTAL ─────────────────────────────────────────────────────────
  console.log('\n— reps.greasedesk.com serves the rep portal —');
  const repOnRep = await ask(REP_HOST, '/rep');
  check('/rep reaches the application', reached(repOnRep),
    `${repOnRep.status} — the app's own 404 for a signed-out rep is the RIGHT answer here; the middleware's is not`);
  check('  …and the api namespace does too', reached(await ask(REP_HOST, '/api/rep/whoami')),
    'nothing is mounted there yet — this asserts the door, not a route');
  // THE ROOT, PROVED AGAINST /rep RATHER THAN AGAINST A PHRASE. "Not the marketing site" was the
  // first version of this clause and it passed before the rewrite existed, because the tenant
  // homepage is not the marketing site either. A rewrite means the two paths answer IDENTICALLY.
  const root = await ask(REP_HOST, '/');
  check('the root answers exactly as /rep does', reached(root) && root.status === repOnRep.status && root.body === repOnRep.body,
    `/ → ${root.status}, /rep → ${repOnRep.status} — rewritten, the way er. rewrites to /superadmin`);
  check('an operator or rep can still sign in there', (await ask(REP_HOST, '/api/auth/csrf')).status === 200,
    'the auth endpoints are shared by all three hosts, or nobody reaches any of them');
  check('the brand asset resolves', (await ask(REP_HOST, '/greasedesk-Logo.png')).status === 200,
    'one exact path out of /public — an <img> to anything else would be permanently broken');

  // ── 2. AND NOTHING ELSE ───────────────────────────────────────────────────────────────────────
  console.log('\n— and nothing else —');
  check('the tenant app 404s on the rep host', blocked(await ask(REP_HOST, '/admin/login')));
  check('the Engine Room 404s on the rep host', blocked(await ask(REP_HOST, '/superadmin/login')),
    'one door, and it is not this one');
  check('  …and so does its api', blocked(await ask(REP_HOST, '/api/superadmin/pay-run')));
  check('the marketing site 404s on the rep host', blocked(await ask(REP_HOST, '/pricing')));

  // ── 3. THE REP PORTAL IS NOWHERE ELSE ─────────────────────────────────────────────────────────
  console.log('\n— the rep portal is reachable from nowhere else —');
  check('/rep 404s on the apex', blocked(await ask(APEX.hostname, '/rep')),
    'it was reachable at localhost until this slice; a rep portal on the tenant origin shares the tenant cookie jar');
  check('  …and its api too', blocked(await ask(APEX.hostname, '/api/rep/whoami')));
  check('/rep 404s on er.', blocked(await ask(ER_HOST, '/rep')),
    'already true — er. 404s everything outside the Engine Room — and asserted so it stays true');

  // ── 4. THE SUBSTRING TRAP ─────────────────────────────────────────────────────────────────────
  console.log('\n— a path that merely starts the same way is not the rep portal —');
  check('/api/reports/vat-summary still reaches the tenant app',
    reached(await ask(APEX.hostname, '/api/reports/vat-summary')),
    "startsWith('/api/rep') matches it; a tenant's VAT return must not 404 because a rep portal shipped");
  check('/admin/settings/rep still reaches the tenant app',
    reached(await ask(APEX.hostname, '/admin/settings/rep')),
    "startsWith('/rep') does not reach it, but the next sibling path is one rename away");

  // ── 5. NOTHING THAT WORKED YESTERDAY STOPPED ──────────────────────────────────────────────────
  console.log('\n— the two existing hosts are untouched —');
  check('the tenant app still serves on the apex', (await ask(APEX.hostname, '/admin/login')).status === 200);
  check('the Engine Room still serves on er.', (await ask(ER_HOST, '/superadmin/login')).status === 200);
  check('the Engine Room is still closed on the apex', blocked(await ask(APEX.hostname, '/superadmin/login')));
  check('the tenant app is still closed on er.', blocked(await ask(ER_HOST, '/admin/login')));
} catch (e) {
  check('run completed', false, describeError(e));
}

console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
process.exit(out.includes('F') ? 1 : 0);
