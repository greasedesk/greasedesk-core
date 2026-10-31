/**
 * File: scripts/affiliate-join-gate.mjs
 * BECOMING AN AFFILIATE: the form, the text, the code typed back, and what they walk away with.
 * @gate-requires: server, db
 *
 * Its own gate rather than more clauses in affiliate-site-gate, because the SUBJECT is different:
 * that one holds the public page, its host and its figures; this one holds a signup that mints a
 * credential-shaped thing and spends a text.
 *
 * ── THE WHOLE FLOW IS DRIVEN, IN A REAL BROWSER ────────────────────────────────────────────────
 * Three states on one page with no navigation between them (form → code → done), so the only way
 * to prove the second state keeps the email the first one took is to drive it. The SMS never
 * leaves the building: Environment.kind on the gate database is `test`, sendNotification refuses
 * every send, and the refusal hands the code back to the caller — which is the only reason a flow
 * that ends in a texted code can be driven to the end at all.
 *
 * ── AND THE SAME PATH WITH A PRODUCTION MARKER MUST LEAK NOTHING (owner, 2026-10-30) ───────────
 * Section 6. The code and the verification URL exist for a gate; on production they would be a
 * hole. Driven IN THIS PROCESS rather than through the server, and the comment there says why — it
 * is not a shortcut, it is the only way to move the marker without restarting the dev server into
 * a state where a send would be real.
 *
 * ── FIXTURES ───────────────────────────────────────────────────────────────────────────────────
 * Rep rows whose email ends @zz-affiliate-join.invalid, their DeliveredCode/TwoFactorSecret/
 * RepMagicLink children, the limiter tokens this gate spends on its own forwarded IP, and the
 * joining switch on the settings singleton — all swept in a registered teardown. The MOBILE is an
 * Ofcom drama number (07700 900xxx, never allocated to a subscriber), so even a misconfigured
 * send could not reach a person.
 */
import './_gate-preflight.mjs';
import './_ts.mjs';
const { gatePrisma, describeError, gateOrigin, affiliateOrigin, serverReady, onTeardown, declineToRun } = await import('./_gate-preflight.mjs');
const http = await import('node:http');
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');
const JOIN = await import('../lib/affiliate-join.ts');
const { urlUnder } = await import('../lib/anchored-match.ts');
const ENV = await import('../lib/environment.ts');
const PV = await import('../lib/phone-verification.ts');
const EV = await import('../lib/affiliate-email-verify.ts');
const { PLATFORM_SEND, channelConfigured } = await import('../lib/notify.ts');
const { smsDestinationKey } = await import('../lib/auth-rate-limit.ts');
const { COMPANY } = await import('../lib/company-info.ts');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const B = new URL(gateOrigin());
const AFF = affiliateOrigin();
const AFF_HOST = new URL(AFF).hostname;
const AFF_RESOLVER = ['--host-resolver-rules=MAP affiliates.greasedesk.com 127.0.0.1'];

const MARK = '@zz-affiliate-join.invalid';
const GATE_IP = '203.0.113.9';
/** Ofcom's drama range: allocated to nobody, ever. A send that escaped could not reach a person. */
const MOBILE = '07700 900321';

const ask = (host, path, { method = 'GET', body, xff = GATE_IP } = {}) => new Promise((resolve) => {
  const headers = { Host: `${host}:${B.port}`, 'x-forwarded-for': xff };
  if (body) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(body); }
  const r = http.request({ hostname: B.hostname, port: B.port, path, method, headers }, (res) => {
    let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: b, headers: res.headers }));
  });
  r.on('error', (e) => resolve({ status: 0, body: String(e), headers: {} }));
  if (body) r.write(body);
  r.end();
});
const post = (path, payload, opts = {}) => ask(AFF_HOST, path, { method: 'POST', body: JSON.stringify(payload), ...opts });

let prisma, browser;
let joiningBefore = null;
const sweep = async () => {
  if (!prisma) return 0;
  const reps = (await prisma.rep.findMany({ where: { email: { endsWith: MARK } }, select: { id: true } })).map((r) => r.id);
  if (reps.length) {
    // CHILDREN FIRST where there is no cascade to rely on. DeliveredCode and TwoFactorSecret are
    // keyed by SUBJECT (a loose pair, never a foreign key), so nothing deletes them for us.
    await prisma.deliveredCode.deleteMany({ where: { subject_type: 'rep', subject_id: { in: reps } } }).catch(() => {});
    await prisma.twoFactorSecret.deleteMany({ where: { subject_type: 'rep', subject_id: { in: reps } } }).catch(() => {});
    await prisma.repMagicLink.deleteMany({ where: { rep_id: { in: reps } } }).catch(() => {});
    await prisma.rep.deleteMany({ where: { id: { in: reps } } }).catch(() => {});
  }
  await prisma.authRateLimit.deleteMany({ where: { key: { startsWith: `join:ip:${GATE_IP}` } } }).catch(() => {});
  await prisma.authRateLimit.deleteMany({ where: { key: { startsWith: `sms:ip:${GATE_IP}` } } }).catch(() => {});
  // ── EVERY AXIS THIS GATE SPENDS, INCLUDING THE HASHED ONE ───────────────────────────────────
  // sendPhoneVerification spends FOUR: subject, destination, IP and the platform's daily total.
  // The first draft swept the IP and not the DESTINATION — five codes an hour per number — so the
  // fifth run of the day was refused with "Too many codes requested" and three clauses went red
  // about a flow that was working. The destination key is hashed, so it is computed through the
  // limiter's own helper rather than guessed at.
  for (const n of ['447700900321', '447700900322']) {
    await prisma.authRateLimit.deleteMany({ where: { key: smsDestinationKey(n) } }).catch(() => {});
  }
  if (reps.length) {
    await prisma.authRateLimit.deleteMany({ where: { key: { in: reps.map((id) => `sms:sub:rep:${id}`) } } }).catch(() => {});
  }
  // The platform axis is NOT swept: it is one shared daily ceiling of 100, a handful of which this
  // gate legitimately spends, and deleting it would hide a real day's spend from the next reader.
  if (joiningBefore !== null) {
    await prisma.programmeSettings.update({ where: { id: 'singleton' }, data: { affiliate_joining_open: joiningBefore } }).catch(() => {});
  }
  // THE MARKER, ALWAYS BACK TO test. Section 6 moves it for two calls in this process. If this gate
  // died in that window every later gate would refuse to start (gatePrisma demands `test`), so the
  // restore is registered rather than written at the end of the happy path.
  await prisma.environment.update({ where: { id: ENV.ENVIRONMENT_ID }, data: { kind: 'test' } }).catch(() => {});
  ENV.__resetEnvironmentCache();
  return reps.length;
};

try {
  prisma = await gatePrisma();
  onTeardown(sweep);
  await sweep();

  // ── THE PREMISE, CHECKED RATHER THAN STATED ──────────────────────────────────────────────────
  // Section 6 moves the marker to `production` in this process. If an SMS provider were configured
  // here, the send that follows would be real — so the gate DECLINES instead of running that
  // section against a live adapter. A premise in a comment is not a premise.
  if (channelConfigured('sms')) {
    declineToRun('an SMS provider IS configured in this environment, so section 6 — which moves the '
      + 'Environment marker to `production` and then asks for a code — could send a real text. It '
      + 'refuses rather than risk one. Run it where no SMS adapter is configured.');
  }

  const ready = await serverReady();
  check('the dev server serves pages before we drive it', ready.ok, `HTTP ${ready.status} after ${ready.attempts} attempt(s)`);
  const envNow = await ENV.readEnvironment(prisma);
  check('this is the TEST database, which is what lets a texted code be driven to the end',
    envNow.kind === 'test', String(envNow.kind));

  const before = await prisma.programmeSettings.findUnique({ where: { id: 'singleton' }, select: { affiliate_joining_open: true } });
  joiningBefore = before?.affiliate_joining_open ?? false;
  await prisma.programmeSettings.update({ where: { id: 'singleton' }, data: { affiliate_joining_open: true } });

  // ── 1. THE MINT ──────────────────────────────────────────────────────────────────────────────
  console.log('— the code it mints —');
  const sample = Array.from({ length: 40 }, () => JOIN.mintCandidate());
  check('every minted code is eight characters of the unambiguous alphabet',
    sample.every((c) => JOIN.codeShapeOk(c)), `${sample[0]} …`);
  check('  …and the pairs people mistype are NOT in it',
    sample.every((c) => !/[O0I1]/.test(c)),
    'O/0 and I/1 are the pairs that cost a referral when a code is read off a card. L STAYS: the '
      + 'confusable pair is lower-case l against 1, and these are printed upper case');
  // THE DRAW IS UNBIASED, held against the EXPORTED alphabet rather than against the number 32 —
  // the rule is "it divides 256", and the module refuses to load when it does not. A 30-letter
  // alphabet would quietly favour the first sixteen letters and nothing would ever say so.
  check('  …and the alphabet divides 256, so the byte draw cannot favour the earlier letters',
    256 % JOIN.ALPHABET.length === 0 && JOIN.ALPHABET.length === 32 && JOIN.CODE_LENGTH === 8,
    `${JOIN.ALPHABET.length} letters, ${JOIN.CODE_LENGTH} long — 32^8, about a thousand billion`);
  check('  …and it is not the same code every time', new Set(sample).size === sample.length, `${new Set(sample).size} distinct of ${sample.length}`);
  check('a shape check refuses what the mint would never produce',
    !JOIN.codeShapeOk('SHORT') && !JOIN.codeShapeOk('abcdefgh') && !JOIN.codeShapeOk('ABCDEFG0'),
    'otherwise the clause above passes against a function that says yes to everything');

  // THE CASE-INSENSITIVE COLLISION CHECK, against a planted mixed-case code. This is the courtesy
  // in front of the new unique index, and the only way to see it work is to make it collide.
  const planted = await prisma.rep.create({ data: {
    party_type: 'affiliate', email: `planted${MARK}`, name: 'ZZ planted', ref_code: 'AbCdEfGh',
    terms_accepted_at: new Date() }, select: { id: true } });
  const clash = await prisma.rep.findFirst({ where: { ref_code: { equals: 'ABCDEFGH', mode: 'insensitive' } }, select: { id: true } });
  check('a mixed-case code IS found by a folded lookup', clash?.id === planted.id,
    'which is why minting checks case-insensitively, not just for an exact match');
  // AND THE DATABASE REFUSES IT OUTRIGHT — the new index, not the application's courtesy.
  const refused = await prisma.rep.create({ data: {
    party_type: 'affiliate', email: `clash${MARK}`, name: 'ZZ clash', ref_code: 'ABCDEFGH',
    terms_accepted_at: new Date() } }).then(() => null, (e) => e);
  check('  …and the DATABASE refuses a code that differs only by case',
    !!refused && /Rep_ref_code_lower_uniq|unique/i.test(String(refused?.message ?? '')),
    refused ? String(refused.code ?? refused.message).slice(0, 60) : 'IT WAS ACCEPTED — the unique index on lower(ref_code) is not doing its job');

  // ── 2. THE RULES BEHIND THE FORM ─────────────────────────────────────────────────────────────
  console.log('\n— the form’s own rules —');
  check('a missing name, email or mobile is refused, and the FIELD is named',
    JOIN.validateJoin({ email: 'a@b.co', phone: '1' }).field === 'name'
      && JOIN.validateJoin({ name: 'A', phone: '1' }).field === 'email'
      && JOIN.validateJoin({ name: 'A', email: 'a@b.co' }).field === 'phone');
  check('  …a malformed email is refused', JOIN.validateJoin({ name: 'A', email: 'nope', phone: '1' }).ok === false);
  check('  …a complete form is ACCEPTED, lower-cased, with the optional field as NULL',
    (() => {
      const v = JOIN.validateJoin({ name: ' Sam ', email: ' SAM@X.CO ', phone: ' 07700 900321 ', social: '' });
      return v.ok && v.fields.email === 'sam@x.co' && v.fields.name === 'Sam' && v.fields.social === null;
    })(),
    'empty is NULL, not an empty string: "not given" and "given as nothing" must not be one row');

  // THE THREE CASES BEHIND ONE UNIQUE EMAIL.
  check('an unknown email is a NEW affiliate', JOIN.decideExisting(null, false).action === 'create');
  check('  …an unfinished one is CARRIED ON, not refused',
    JOIN.decideExisting({ id: 'r1', party_type: 'affiliate', ref_code: 'X', suspended_at: null }, false).action === 'carry_on',
    'they lost the tab, or the text never came — the same row, not a second account');
  check('  …a finished one is DONE, and not sent round again',
    JOIN.decideExisting({ id: 'r1', party_type: 'affiliate', ref_code: 'X', suspended_at: null }, true).action === 'done');
  check('  …a RESELLER’s address is refused, and the sentence says why',
    (() => {
      const d = JOIN.decideExisting({ id: 'r1', party_type: 'rep', ref_code: 'X', suspended_at: null }, false);
      return d.action === 'refuse' && /reseller/i.test(d.message);
    })(),
    'silently adding an affiliate code to a reseller’s row would put them in two programmes without either being explained');
  check('  …and a suspended one is refused rather than carried on',
    JOIN.decideExisting({ id: 'r1', party_type: 'affiliate', ref_code: 'X', suspended_at: new Date() }, false).action === 'refuse');

  check('the referral link points at the APEX, where a garage signs up',
    JOIN.referralLink('ABCD2345', COMPANY.siteUrl) === `${COMPANY.siteUrl}/register?ref=ABCD2345`,
    JOIN.referralLink('ABCD2345', COMPANY.siteUrl));

  // ── 3. THE WHOLE FLOW, THROUGH THE PAGE ──────────────────────────────────────────────────────
  console.log('\n— and the signup itself, in a browser —');
  browser = await chromium.launch({ channel: 'chrome', args: AFF_RESOLVER });
  // THE BROWSER CARRIES THIS GATE'S OWN FORWARDED ADDRESS, for the reason the raw requests do: the
  // limiter falls back to the literal 'unknown', which every anonymous caller shares — so without
  // this the form's five-an-hour budget is spent against a key the teardown cannot clean without
  // clearing a budget that is not ours. The fifth run of the day got 429 and four clauses went red
  // about a signup that was working.
  const page = await (await browser.newContext({
    viewport: { width: 420, height: 1400 },
    extraHTTPHeaders: { 'x-forwarded-for': GATE_IP },
  })).newPage();
  const EMAIL = `sam${MARK}`;
  await page.goto(`${AFF}/join`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="join-form"]', { timeout: 30000 });
  check('the form is served on the affiliate host, at phone width',
    (await page.locator('[data-testid="join-form"]').count()) === 1);
  const terms = await page.locator('[data-testid="join-terms"]').innerText().catch(() => '');
  check('  …with the money terms ABOVE the button that accepts them',
    /£30/.test(terms) && /£120/.test(terms) && /first 4 paid months/.test(terms),
    'from the settings, on the same request — the sentence and the acceptance cannot drift apart');

  await page.fill('[data-testid="join-name"]', 'ZZ Sam Affiliate');
  await page.fill('[data-testid="join-email"]', EMAIL);
  await page.fill('[data-testid="join-phone"]', MOBILE);
  await page.fill('[data-testid="join-social"]', 'youtube.com/@zz-gate');
  // THE PAGE'S OWN RESPONSE, captured as it arrives. The first draft re-posted the same form from
  // this process to read the code out of a second response — and the RESEND COOLDOWN refused it,
  // correctly: issueCode slows a user hammering "send again" because every issue is a text. So the
  // code is read from the response the browser actually got, which also means the clause is about
  // the request the FORM made rather than one the gate made to look like it.
  const signupResponse = page.waitForResponse((r) => urlUnder(r.url(), '/api/affiliate-site/signup'), { timeout: 30000 });
  await page.click('[data-testid="join-submit"]');
  const signupBody = await (await signupResponse).json().catch(() => ({}));
  await page.waitForSelector('[data-testid="join-code-form"]', { timeout: 30000 }).catch(() => {});
  check('pressing it moves to the CODE screen', (await page.locator('[data-testid="join-code-form"]').count()) === 1,
    'one page, three states — a redirect here would lose the email the next step is keyed on');

  const made = await prisma.rep.findUnique({ where: { email: EMAIL }, select: { id: true, ref_code: true, party_type: true, terms_accepted_at: true, social_handle: true, phone: true, email_verified_at: true } });
  check('  …and the affiliate row exists, with the terms accepted',
    !!made && made.party_type === 'affiliate' && !!made.terms_accepted_at,
    `${made?.ref_code} — the button accepts the terms it is under, which is what lets a reward accrue`);
  check('  …the channel they gave is kept', made?.social_handle === 'youtube.com/@zz-gate');
  check('  …and the MOBILE is not written to Rep.phone',
    made?.phone === null,
    'that column is the PUBLISHED number a garage is shown; the verified mobile belongs on TwoFactorSecret');
  check('  …their email is NOT verified yet, because nothing has been clicked',
    made?.email_verified_at === null, 'the text proves a handset; the email is proved by the link being followed');

  // THE CODE. It is not in the database in plaintext — DeliveredCode stores sha256 — so the only
  // place it exists is the response the test-environment branch handed back.
  const codeRow = await prisma.deliveredCode.findFirst({ where: { subject_type: 'rep', subject_id: made.id, purpose: 'phone_verify' }, select: { code_hash: true, channel: true, destination: true } });
  // DIGITS, NO PLUS — toE164Digits says so in its name, and asserting the '+' form was my own
  // clause being wrong about the normaliser rather than the normaliser being wrong.
  check('a code was minted and stored HASHED, against the dialable number',
    !!codeRow && codeRow.code_hash.length === 64 && codeRow.destination === '447700900321' && codeRow.channel === 'sms',
    `${codeRow?.destination} / ${codeRow?.channel} / hash ${codeRow?.code_hash?.length} chars`);

  // Re-posted through the API to READ the code, because the browser cannot see a JSON response it
  // did not ask for. Same endpoint, same payload — the second call carries on the same row.
  check('the test database hands the code back instead of texting it',
    typeof signupBody.testCode === 'string' && signupBody.testCode.length >= 4,
    `${signupBody.message ?? JSON.stringify(signupBody).slice(0, 90)} — the ONLY reason a flow ending in a texted code can be driven to the end`);
  check('  …and it names WHY nothing was sent, rather than only that nothing was',
    /test database/.test(String(signupBody.message ?? '')) && /not_configured|test_environment|skipped/.test(String(signupBody.message ?? '')),
    String(signupBody.message ?? ''));

  await page.fill('[data-testid="join-code"]', signupBody.testCode);
  // THE CONFIRM RESPONSE, captured too. The verify URL is the second test-only payload, and the
  // clause that it is WITHHELD on production is about the predicate (section 6) — so this is the
  // other half: that the handler is actually wired to the predicate's true branch, rather than
  // returning null always and passing section 6 by never revealing anything at all.
  // urlUnder here too: '/api/affiliate-site/confirm' as a SUBSTRING also matches
  // /api/affiliate-site/confirm-email, which is a different endpoint on this very site (the API
  // prefix did NOT move — only the page addresses did).
  const confirmResponse = page.waitForResponse((r) => urlUnder(r.url(), '/api/affiliate-site/confirm'), { timeout: 30000 });
  await page.click('[data-testid="join-confirm"]');
  const confirmBody = await (await confirmResponse).json().catch(() => ({}));
  await page.waitForSelector('[data-testid="join-done"]', { timeout: 30000 }).catch(() => {});
  check('typing the code finishes the signup', (await page.locator('[data-testid="join-done"]').count()) === 1);
  const shownCode = await page.locator('[data-testid="done-code"]').innerText().catch(() => '');
  check('  …and the referral code on the screen is the one in the database',
    shownCode.trim() === made.ref_code, `${shownCode.trim()} vs ${made.ref_code}`);
  const shownLink = await page.locator('[data-testid="done-link"]').innerText().catch(() => '');
  check('  …the link carries that code, to the apex',
    shownLink.trim() === `${COMPANY.siteUrl}/register?ref=${made.ref_code}`, shownLink.trim());
  const qrSrc = await page.locator('[data-testid="done-qr"]').getAttribute('src').catch(() => null);
  check('  …and the QR is a real image of it', !!qrSrc && qrSrc.startsWith('data:image/png;base64,') && qrSrc.length > 500,
    `${qrSrc?.slice(0, 30)}… ${qrSrc?.length} chars`);

  // urlUnder, NOT .includes(): a substring test is true of /confirm-emails-archive
  // and of anything that merely contains the words. anchored-match-gate bans the hand-written form
  // across the whole suite, and caught this line in the core tier — after I had run that gate and
  // then added one more clause.
  check('the test database hands back the verification URL as well',
    typeof confirmBody.verifyUrl === 'string' && urlUnder(confirmBody.verifyUrl, '/confirm-email'),
    `${String(confirmBody.verifyUrl).slice(0, 60)} — the link that was never emailed, for the same reason the code is handed back`);
  check('  …and says the email did NOT go, rather than claiming it did',
    confirmBody.emailed === false, `emailed ${confirmBody.emailed}`);

  const verified = await prisma.twoFactorSecret.findUnique({
    where: { subject_type_subject_id: { subject_type: 'rep', subject_id: made.id } },
    select: { phone_e164: true, phone_verified_at: true },
  });
  check('the handset is recorded as verified, where every other verified number lives',
    verified?.phone_e164 === '447700900321' && !!verified?.phone_verified_at,
    'TwoFactorSecret, by subject — written by confirmPhoneVerification and by nothing else');

  // ── 4. THE EMAIL HALF: A LINK, FOLLOWED, STAMPED ONCE ────────────────────────────────────────
  console.log('\n— the email is proved by the link being followed —');
  const confirmJson = JSON.parse((await post('/api/affiliate-site/confirm', { email: EMAIL, code: 'nonsense' })).body || '{}');
  check('a wrong code is refused after the signup is already done',
    confirmJson.ok === false, confirmJson.message);

  const link = await EV.mintEmailVerifyLink({ repId: made.id, sentTo: EMAIL, baseUrl: AFF });
  const token = link.rawToken;
  // TWO ROWS, ONE LIVE. The confirm endpoint already minted a link for the welcome email, so this
  // is the SUPERSEDE rule rather than a count: a person who asks again is telling us the first did
  // not arrive, and two live links prove nothing extra. My first draft asserted `=== 1` and found
  // the second row — the rule working, read as a failure.
  const links = await prisma.repMagicLink.findMany({
    where: { rep_id: made.id, purpose: 'email_verify' },
    select: { consumed_at: true, revoked_at: true, revoked_reason: true },
  });
  const live = links.filter((l) => !l.consumed_at && !l.revoked_at);
  check('a verification link is minted for the EMAIL purpose, and only ONE is live',
    links.length === 2 && live.length === 1 && links.some((l) => l.revoked_reason === 'superseded'),
    `${links.length} link(s), ${live.length} live — the store is shared with sign-in; purpose is what keeps them apart`);

  const visit = await ask(AFF_HOST, new URL(link.url).pathname);
  check('following it confirms the address', visit.status === 200 && /data-testid="confirm-ok"/.test(visit.body), `HTTP ${visit.status}`);
  const stamped = await prisma.rep.findUnique({ where: { id: made.id }, select: { email_verified_at: true } });
  check('  …and the row is stamped', !!stamped?.email_verified_at, String(stamped?.email_verified_at));

  const firstStamp = stamped.email_verified_at;
  const again = await ask(AFF_HOST, new URL(link.url).pathname);
  check('  …clicking the same link twice is a SUCCESS, not an error',
    again.status === 200 && /data-testid="confirm-ok"/.test(again.body),
    'they have done nothing wrong and their address is no less proved');
  check('  …and the FIRST stamp stands',
    (await prisma.rep.findUnique({ where: { id: made.id }, select: { email_verified_at: true } }))?.email_verified_at?.getTime() === firstStamp.getTime(),
    'when the address was proved is a fact about the first time it happened');

  const nonsense = await ask(AFF_HOST, '/confirm-email/' + 'f'.repeat(64));
  check('an unknown token confirms nothing', nonsense.status === 200 && /data-testid="confirm-failed"/.test(nonsense.body));
  // A SIGN-IN TOKEN MUST NOT WORK HERE. The two purposes share one table, and this is the clause
  // that stops a verification endpoint becoming a way to spend a credential.
  const { mintRepLink } = await import('../lib/rep-magic-link.ts');
  const signIn = await mintRepLink({ repId: made.id, sentTo: EMAIL, baseUrl: AFF });
  const crossed = await ask(AFF_HOST, `/confirm-email/${signIn.rawToken}`);
  check('  …and neither does a SIGN-IN token presented to it',
    crossed.status === 200 && /data-testid="confirm-failed"/.test(crossed.body),
    'one table, two purposes — a verification link that could be traded for a session is a credential');
  check('  …which is still unspent afterwards',
    (await prisma.repMagicLink.findFirst({ where: { rep_id: made.id, purpose: 'sign_in' }, select: { consumed_at: true } }))?.consumed_at === null,
    'refusing it must not burn it either');

  // ── 5. THE SWITCH STILL GOVERNS THE DOOR ─────────────────────────────────────────────────────
  console.log('\n— and the switch governs the signup, not just the button —');
  await prisma.programmeSettings.update({ where: { id: 'singleton' }, data: { affiliate_joining_open: false } });
  const shut = await ask(AFF_HOST, '/join');
  check('with joining shut the form is not on the page',
    shut.status === 200 && /data-testid="join-closed"/.test(shut.body) && !/data-testid="join-form"/.test(shut.body));
  const shutPost = await post('/api/affiliate-site/signup', { name: 'ZZ Nope', email: `nope${MARK}`, phone: MOBILE });
  check('  …and the API refuses a POST anyway',
    shutPost.status === 409 && !(await prisma.rep.findUnique({ where: { email: `nope${MARK}` } })),
    `HTTP ${shutPost.status} — a form nobody can see is still a POST anybody can make`);
  await prisma.programmeSettings.update({ where: { id: 'singleton' }, data: { affiliate_joining_open: true } });

  // ── 6. WITH A PRODUCTION MARKER, NOTHING IS HANDED BACK (owner, 2026-10-30) ───────────────────
  // IN THIS PROCESS, not through the server, and that is the only honest way: readEnvironment
  // caches a successful read per process, so the dev server already believes `test` and moving the
  // row would not change its answer. Restarting it with the marker on `production` would make the
  // next send REAL. So the marker is moved here, where the cache is resettable and where the
  // premise above (no SMS adapter configured) has been checked.
  console.log('\n— and with a production marker it hands back nothing —');
  check('the predicate reveals a test-only payload ONLY on a test marker',
    ENV.revealTestOnlySecrets({ kind: 'test', cached: false }) === true
      && ENV.revealTestOnlySecrets({ kind: 'production', cached: false }) === false,
    'two of the three states');
  check('  …and REFUSES when the marker cannot be read at all',
    ENV.revealTestOnlySecrets({ kind: null, why: 'unreadable', detail: 'x' }) === false
      && ENV.revealTestOnlySecrets({ kind: null, why: 'no row', detail: 'x' }) === false,
    'the third state is the one that matters: "we were not sure" is not a reason to hand out a credential');

  await prisma.environment.update({ where: { id: ENV.ENVIRONMENT_ID }, data: { kind: 'production' } });
  ENV.__resetEnvironmentCache();
  check('  …the marker really reads production now', (await ENV.readEnvironment(prisma)).kind === 'production',
    'otherwise the two clauses below prove nothing at all');
  // A FRESH SUBJECT, AND THAT IS NOT TIDINESS. The first version of this clause reused the affiliate
  // from section 3 and passed with `{"code":"cooldown"}` — refused seconds after its last code, so
  // it never reached the send and never asked the marker anything. It would have gone on passing
  // with the guard deleted. A subject with no code history is what makes the call reach the branch.
  const prodRep = await prisma.rep.create({ data: {
    party_type: 'affiliate', email: `onprod${MARK}`, name: 'ZZ on prod', ref_code: await JOIN.mintRefCode(prisma),
    terms_accepted_at: new Date() }, select: { id: true } });
  const onProd = await PV.sendPhoneVerification({
    subject: { type: 'rep', id: prodRep.id }, groupId: PLATFORM_SEND, rawPhone: '07700 900322', ip: GATE_IP,
  });
  check('  …the call REACHED the send rather than being turned back early',
    'code' in onProd && onProd.code !== 'cooldown' && onProd.code !== 'rate_limited',
    `${JSON.stringify(onProd).slice(0, 110)} — a cooldown here would mean the marker was never consulted`);
  check('  …and it hands back NO code',
    !('testCode' in onProd) && !(/\b\d{6}\b/.test(JSON.stringify(onProd))),
    'nothing in the answer is a code');
  check('  …nor did it take the test branch', !('code' in onProd && onProd.code === 'test_environment'),
    'on production the text goes out and the only copy is the handset’s');
  // AND THE CODE IS NOT LEFT LYING ABOUT EITHER. On production a failed send clears it, so there is
  // no live code for a caller to guess at after being told nothing was sent.
  check('  …and no live code was left behind',
    (await prisma.deliveredCode.count({ where: { subject_type: 'rep', subject_id: prodRep.id, purpose: 'phone_verify' } })) === 0,
    'a failed send on production drops the code — only the test branch keeps it');
  const envProd = await ENV.readEnvironment(prisma);
  check('  …and the verify URL would be withheld on the same marker',
    ENV.revealTestOnlySecrets(envProd) === false,
    'the one predicate the confirm endpoint consults — asserted against the live row, not a literal');

  await prisma.environment.update({ where: { id: ENV.ENVIRONMENT_ID }, data: { kind: 'test' } });
  ENV.__resetEnvironmentCache();
  check('  …and the marker is back to test before anything else runs',
    (await ENV.readEnvironment(prisma)).kind === 'test',
    'gatePrisma refuses a client unless this says test — a gate that left it wrong would stop every later one');

} catch (e) {
  console.log(`\n✗ THREW: ${describeError(e).slice(0, 700)}`);
  out.push('F');
} finally {
  await browser?.close().catch(() => {});
  const left = await sweep().catch(() => -1);
  const marker = await prisma?.environment.findUnique({ where: { id: ENV.ENVIRONMENT_ID }, select: { kind: true } }).catch(() => null);
  check('teardown swept the fixtures and left the marker on test',
    left >= 0 && marker?.kind === 'test', `${left} rep row(s) removed; marker ${marker?.kind}`);
  console.log(`\n${out.filter((x) => x === 'F').length} failures of ${out.length}`);
  await prisma?.$disconnect();
  process.exit(out.includes('F') ? 1 : 0);
}
