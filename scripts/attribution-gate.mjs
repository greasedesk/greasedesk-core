/**
 * File: scripts/attribution-gate.mjs
 * @gate-requires: db, server
 *
 * WHO SENT THIS GARAGE, AND DOES THE RECORD SURVIVE THE SIGNUP.
 *
 * ── WHAT IS BEING GUARDED ───────────────────────────────────────────────────────────────────────
 * An affiliate introduces a garage and is paid for it. The entire claim rests on one row written
 * once, at one moment, from a string that travelled through a URL, possibly a cookie, possibly a
 * person retyping it off a business card. Every step of that journey can lose it silently, and the
 * loss is invisible: the garage signs up fine, pays fine, and nobody notices for weeks that the
 * person who introduced them was never recorded. So the clauses here are mostly about ABSENCE —
 * and absence is measured before and after, never asserted as "is zero now".
 *
 * ── THE RULES THESE PIN (owner, 2026-10-28) ─────────────────────────────────────────────────────
 *   first click wins ......... an old link is not overwritten by a newer one
 *   a typed code beats both ... the field is what the person is telling us
 *   ?ref= on /register ....... prefills the field from the URL, stores NOTHING, needs no consent
 *   affiliate codes fold ..... GBJONES and gbjones are one code; a rep code matches only as typed
 *   unknown / suspended ...... a clear message, no referral, and the signup still succeeds
 *   nobody refers themselves
 *   referred once ............ never changed afterwards, never applied retrospectively
 *   the offer switch ......... gates the PRICE, never the attribution
 *
 * FIXTURES: this gate's own ZZATTR prefix on the gate database, swept before and after, registered
 * with onTeardown. It creates real garages through the real signup endpoint, which is the only way
 * to prove the transaction clause — a hand-written row would prove the fixture, not the path.
 */
import './_gate-preflight.mjs';
const { gatePrisma, describeError, gateOrigin, serverReady, onTeardown, declineToRun } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const R = '/Users/hugh/Developer/greasedesk-core';
const PREFIX = 'ZZATTR';
const SETTINGS = 'ZZATTR-settings';
const PASS = 'GateGarage!2026';

let prisma, browser;

const sweep = async () => {
  if (!prisma) return 0;
  const reps = (await prisma.rep.findMany({ where: { ref_code: { startsWith: PREFIX, mode: 'insensitive' } }, select: { id: true } })).map((r) => r.id);
  const groups = (await prisma.group.findMany({ where: { group_name: { startsWith: PREFIX } }, select: { id: true } })).map((g) => g.id);
  // AND THE GARAGES THE SIGNUP ENDPOINT NAMED ITSELF. register-garage sets group_name to the
  // neutral 'New garage', so a sweep that only matched the prefix would leave behind every garage
  // this gate created through the real path — which is most of them.
  const viaUsers = (await prisma.user.findMany({ where: { email: { startsWith: `${PREFIX.toLowerCase()}-` } }, select: { group_id: true } })).map((u) => u.group_id);
  const all = [...new Set([...groups, ...viaUsers])].filter(Boolean);
  if (all.length) {
    for (const t of ['tenantAffiliateTerms', 'tenantAttribution', 'commissionEntry', 'tenantPlanTerms', 'notificationLog', 'auditLog', 'user']) {
      await prisma[t].deleteMany({ where: { group_id: { in: all } } }).catch(() => {});
    }
    await prisma.group.deleteMany({ where: { id: { in: all } } }).catch(() => {});
  }
  await prisma.verificationToken.deleteMany({ where: { identifier: { startsWith: `${PREFIX.toLowerCase()}-` } } }).catch(() => {});
  if (reps.length) {
    await prisma.commissionEntry.deleteMany({ where: { party_id: { in: reps } } }).catch(() => {});
    await prisma.tenantAttribution.deleteMany({ where: { party_id: { in: reps } } }).catch(() => {});
    await prisma.rep.deleteMany({ where: { id: { in: reps } } }).catch(() => {});
  }
  const settings = await prisma.programmeSettings.deleteMany({ where: { id: SETTINGS } }).catch(() => ({ count: 0 }));
  return all.length + reps.length + (settings?.count ?? 0);
};

/**
 * A COOKIE JAR THAT BEHAVES LIKE A BROWSER'S, which is the only reason these clauses mean
 * anything. The point of interest is that a browser keys a cookie on (name, domain) and
 * `document.cookie` returns EVERY cookie visible to the host with no attributes and no defined
 * order — so a host-only gd_ref and a domain-scoped gd_ref coexist and read back as
 * `gd_ref=a; gd_ref=b`. A jar modelled as a flat name→value map cannot express the bug this is
 * here to catch, and would pass whatever the code did.
 */
function installJar(hostname) {
  const jar = [];
  const find = (name, domain) => jar.findIndex((c) => c.name === name && c.domain === domain);
  globalThis.location = { hostname };
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      get cookie() { return jar.map((c) => `${c.name}=${c.value}`).join('; '); },
      set cookie(str) {
        const parts = String(str).split(';').map((x) => x.trim());
        const eq = parts[0].indexOf('=');
        const name = parts[0].slice(0, eq);
        const value = parts[0].slice(eq + 1);
        const domain = (parts.find((a) => /^domain=/i.test(a)) ?? '=').split('=')[1] ?? '';
        const ma = parts.find((a) => /^max-age=/i.test(a));
        const maxAge = ma ? Number(ma.split('=')[1]) : null;
        const at = find(name, domain);
        if (maxAge === 0) { if (at >= 0) jar.splice(at, 1); return; }
        const rec = { name, value, domain, maxAge };
        if (at >= 0) jar[at] = rec; else jar.push(rec);
      },
    },
  });
  return jar;
}

try {
  prisma = await gatePrisma();
  onTeardown(sweep);
  await sweep();

  const ready = await serverReady('/register');
  if (!ready.ok) declineToRun(`the dev server is not answering on ${gateOrigin()} — ${ready.reason ?? 'no response'}. These clauses drive the real signup page; without it nothing here has been tested.`);

  const C = await import(`${R}/lib/consent.ts`);
  const AT = await import(`${R}/lib/attribution.ts`);
  const AF = await import(`${R}/lib/affiliate.ts`);

  // ── 1. THE COOKIE: SCOPE, AND FIRST CLICK WINS ──────────────────────────────────────────────
  console.log('\n— the cookie —');
  {
    const jar = installJar('greasedesk.com');
    check('gd_ref is scoped to the registrable domain, so an affiliate subdomain link reaches the apex',
      C.writeGdRef('ZZATTRAFF') === true && jar.find((c) => c.name === 'gd_ref')?.domain === '.greasedesk.com',
      jar.find((c) => c.name === 'gd_ref')?.domain || 'host-only');
    check('  …and it keeps the 90 days it has always had',
      jar.find((c) => c.name === 'gd_ref')?.maxAge === 90 * 24 * 60 * 60);

    // THE CLAUSE THE WHOLE PROGRAMME TURNS ON.
    const second = C.writeGdRef('ZZATTRREP');
    const refs = jar.filter((c) => c.name === 'gd_ref');
    check('FIRST CLICK WINS: a second ?ref= does not overwrite the first',
      second === false && refs.length === 1 && refs[0].value === 'ZZATTRAFF',
      `${refs.length} cookie(s), holding ${refs.map((c) => c.value).join(' + ')}`);

    C.clearGdRef();
    check('  …and withdrawal clears it at BOTH scopes, leaving nothing readable',
      jar.filter((c) => c.name === 'gd_ref').length === 0 && C.readGdRef() === null);
  }
  {
    // THE MIGRATION HAZARD, which is what makes widening a live cookie different from building one.
    const jar = installJar('greasedesk.com');
    jar.push({ name: 'gd_consent', value: 'OLD', domain: '', maxAge: 999 }); // the host-only predecessor
    C.writeConsentCookie({ v: C.POLICY_VERSION, id: 'zzattr', ts: Date.now(), region: 'GB', choice: C.ALL_ON });
    const cs = jar.filter((c) => c.name === 'gd_consent');
    check('widening expires the host-only predecessor, so one name never reads back twice',
      cs.length === 1 && cs[0].domain === '.greasedesk.com',
      `${cs.length} gd_consent cookie(s) — two would make document.cookie ambiguous`);
  }
  {
    const jar = installJar('localhost');
    C.writeGdRef('ZZATTRAFF');
    check('a host that cannot carry the domain gets none, rather than a silently dropped attribute',
      jar.find((c) => c.name === 'gd_ref')?.domain === '',
      `cookieDomainFor('localhost') = '${C.cookieDomainFor('localhost')}'`);
    check('  …and the rule is the registrable domain, not a substring of it',
      C.cookieDomainFor('affiliates.greasedesk.com') === '.greasedesk.com'
        && C.cookieDomainFor('greasedesk.com.evil.test') === ''
        && C.cookieDomainFor('notgreasedesk.com') === '');
  }

  // ── 2. MATCHING A CODE TO A PARTY ───────────────────────────────────────────────────────────
  console.log('\n— matching the code —');
  const mkParty = (code, over = {}) => prisma.rep.create({
    data: {
      email: `${PREFIX.toLowerCase()}-${code.toLowerCase()}@example.invalid`,
      name: `${PREFIX} ${code}`, ref_code: code, country_code: 'GB', party_type: 'affiliate', ...over,
    },
    select: { id: true, ref_code: true },
  });
  const aff = await mkParty(`${PREFIX}AFF`);
  const rep = await mkParty(`${PREFIX}REP`, { party_type: 'rep' });
  const susp = await mkParty(`${PREFIX}SUSP`, { suspended_at: new Date() });
  const dupA = await mkParty(`${PREFIX}DUP`);
  // A DISTINCT EMAIL, because the two codes differ only by case and the email is derived from
  // the code — the first draft collided on User.email and never reached the clause it exists for.
  const dupB = await mkParty(`${PREFIX.toLowerCase()}dup`, { email: `${PREFIX.toLowerCase()}-dup-lower@example.invalid` });

  const m = (code) => AT.findPartyByRefCode(prisma, code);
  check('an affiliate code matches whatever case it was retyped in',
    (await m(`${PREFIX.toLowerCase()}aff`)).partyId === aff.id && (await m(`${PREFIX}AFF`)).partyId === aff.id);
  check('  …and surrounding whitespace is not part of it',
    (await m(`  ${PREFIX}AFF  `)).partyId === aff.id);
  check('a REP code still matches only as typed, pending the production case check',
    (await m(`${PREFIX}REP`)).partyId === rep.id && (await m(`${PREFIX.toLowerCase()}rep`)).status === 'none',
    'ref_code is @unique and Postgres uniqueness is case-sensitive — folding reps is a separate ruling');
  check('a suspended party is NAMED as suspended, not reported as unknown',
    (await m(`${PREFIX}SUSP`)).status === 'suspended',
    'they are different things to say and they get different messages');
  check('two codes differing only by case REFUSE rather than pick one',
    (await m(`${PREFIX.toLowerCase()}DUP`)).status === 'ambiguous',
    `${dupA.ref_code} and ${dupB.ref_code} — paying the wrong person on an invisible difference`);
  check('an unknown code is unknown, and a blank one is not an error',
    (await m('ZZATTRNOSUCH')).status === 'none' && (await m('')).status === 'none' && (await m(null)).status === 'none');

  // ── 3. THE SIGNUP PATH, DRIVEN FOR REAL ─────────────────────────────────────────────────────
  console.log('\n— the signup —');
  browser = await chromium.launch({ channel: 'chrome' });

  /** Sign up through the real page. `cookie` seeds gd_ref; `urlRef` puts ?ref= on the URL;
   *  `type` overrides the field by hand. Returns the created group, read back from the database. */
  const signUp = async (n, { urlRef = null, cookie = null, type = null, email = null } = {}) => {
    const ctx = await browser.newContext();
    if (cookie) await ctx.addCookies([{ name: 'gd_ref', value: cookie, domain: 'localhost', path: '/' }]);
    const page = await ctx.newPage();
    const addr = email ?? `${PREFIX.toLowerCase()}-${n}@example.invalid`;
    await page.goto(`${gateOrigin()}/register${urlRef ? `?ref=${encodeURIComponent(urlRef)}` : ''}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="ref-code"]');
    // WAIT FOR THE PREFILL'S OWN CONDITION, not for the element and not for a fixed delay: the
    // field exists from the first paint and is filled by an effect a tick later, so a locator that
    // waits for the element reads an empty value and passes for the wrong reason.
    if (urlRef || cookie) {
      await page.waitForFunction(() => document.querySelector('[data-testid="ref-code"]')?.value !== '', null, { timeout: 5000 }).catch(() => {});
    }
    const prefilled = await page.inputValue('[data-testid="ref-code"]');
    if (type !== null) await page.fill('[data-testid="ref-code"]', type);
    await page.fill('input[autocomplete="name"]', `${PREFIX} garage ${n}`);
    await page.fill('input[type="email"]', addr);
    await page.fill('input[type="password"]', PASS);
    await page.click('button[type="submit"]');
    await page.waitForURL(/check-email/, { timeout: 15000 });
    const cookiesAfter = await ctx.cookies();
    await ctx.close();
    const user = await prisma.user.findUnique({ where: { email: addr }, select: { group_id: true } });
    const group = user && await prisma.group.findUnique({
      where: { id: user.group_id },
      select: { id: true, signup_ref: true, created_at: true },
    });
    const attribution = group && await prisma.tenantAttribution.findFirst({
      where: { group_id: group.id, ended_at: null }, select: { party_id: true, party_type: true, share_bp: true, source: true },
    });
    const terms = group && await prisma.tenantAffiliateTerms.findUnique({ where: { group_id: group.id } });
    return { prefilled, group, attribution, terms, cookiesAfter };
  };

  // RULING 3: THE PATH THAT NEEDS NO CONSENT. No cookie is seeded and none is accepted — the
  // consent banner is sitting there undecided — and the referral still lands.
  const a = await signUp('nocookie', { urlRef: `${PREFIX}AFF` });
  check('?ref= on the signup URL attributes with NO cookie and NO consent',
    a.prefilled === `${PREFIX}AFF` && a.attribution?.party_id === aff.id && a.attribution?.party_type === 'affiliate',
    `field prefilled "${a.prefilled}", attributed to ${a.attribution?.party_type ?? 'nobody'}`);
  check('  …and it stored nothing on the way: no gd_ref was written',
    !a.cookiesAfter.some((c) => c.name === 'gd_ref'),
    'functional consent was never given, so there was nothing to gate');
  check('  …and the attribution is the whole payment, from the ref param',
    a.attribution?.share_bp === 10000 && a.attribution?.source === 'ref_param');

  // THE SECOND CLAUSE TO RED-PROVE.
  const b = await signUp('typed', { cookie: `${PREFIX}REP`, type: `${PREFIX}AFF` });
  check('A TYPED CODE BEATS THE COOKIE',
    b.group?.signup_ref === `${PREFIX}AFF` && b.attribution?.party_id === aff.id,
    `cookie said ${PREFIX}REP, the field said ${PREFIX}AFF, recorded ${b.group?.signup_ref}`);
  check('  …and the cookie is what fills the field when the URL says nothing',
    b.prefilled === `${PREFIX}REP`, `prefilled "${b.prefilled}"`);

  // ── 4. THE TRANSACTION, AND WHAT IT FREEZES ─────────────────────────────────────────────────
  console.log('\n— frozen with the garage, in one commit —');
  check('the reward terms are frozen at signup, naming the affiliate',
    a.terms?.affiliate_id === aff.id && a.terms?.total_reward_pennies > 0,
    `£${((a.terms?.total_reward_pennies ?? 0) / 100).toFixed(2)} total, £${((a.terms?.instalment_pennies ?? 0) / 100).toFixed(2)} per instalment`);
  check('  …and they are frozen in the SAME transaction as the garage, not after it',
    !!a.terms && !!a.attribution && a.terms.group_id === a.group.id
      && Math.abs(new Date(a.terms.signed_up_at).getTime() - new Date(a.group.created_at).getTime()) < 5000,
    'one moment, one commit — a garage with no record of who sent it is an unpayable affiliate');
  {
    // THE ROLLBACK. A transaction that fails after the attribution must leave NEITHER — proved by
    // forcing one, not by reading the code that opens it.
    const before = await prisma.tenantAttribution.count({ where: { party_id: aff.id } });
    const g = await prisma.group.create({ data: { group_name: `${PREFIX} rollback`, billing_email: `${PREFIX.toLowerCase()}-rb@example.invalid` }, select: { id: true } });
    await prisma.$transaction(async (tx) => {
      await AF.attributeAtSignup(tx, { groupId: g.id, match: await AT.findPartyByRefCode(tx, `${PREFIX}AFF`), garage: { email: `${PREFIX.toLowerCase()}-rb@example.invalid` } }, { settingsId: SETTINGS });
      throw new Error('ZZATTR deliberate rollback');
    }).catch(() => {});
    check('a failed signup leaves no attribution and no terms behind',
      (await prisma.tenantAttribution.count({ where: { party_id: aff.id } })) === before
        && (await prisma.tenantAffiliateTerms.count({ where: { group_id: g.id } })) === 0,
      `${before} attribution(s) before and after`);
    await prisma.group.delete({ where: { id: g.id } }).catch(() => {});
  }

  // ── 5. WHAT IS REFUSED, AND WHAT IS NEVER REFUSED ───────────────────────────────────────────
  console.log('\n— refused, but never the signup —');
  const unknown = await signUp('unknown', { urlRef: 'ZZATTRNOSUCH' });
  check('an UNKNOWN code: no referral, and the garage exists anyway',
    !!unknown.group && unknown.attribution === null && unknown.group.signup_ref === 'ZZATTRNOSUCH',
    'the raw code is KEPT — it resolves the day that affiliate is created');
  const suspended = await signUp('suspended', { urlRef: `${PREFIX}SUSP` });
  check('a SUSPENDED code: no referral, and the garage exists anyway',
    !!suspended.group && suspended.attribution === null);
  check('  …and the two are told apart in words, not merged into one message',
    AF.attributionMessage('unknown_code') !== AF.attributionMessage('suspended')
      && /not one we recognise/i.test(AF.attributionMessage('unknown_code'))
      && /no longer active/i.test(AF.attributionMessage('suspended')));

  const selfEmail = `${PREFIX.toLowerCase()}-${PREFIX.toLowerCase()}aff@example.invalid`; // the affiliate's own address
  const self = await signUp('self', { urlRef: `${PREFIX}AFF`, email: `${PREFIX.toLowerCase()}-self@example.invalid` });
  check('a stranger IS referred (the control for the self-referral clause)', self.attribution?.party_id === aff.id);
  {
    const g = await prisma.group.create({ data: { group_name: `${PREFIX} self`, billing_email: selfEmail }, select: { id: true } });
    const r = await AF.attributeAtSignup(prisma, { groupId: g.id, match: await AT.findPartyByRefCode(prisma, `${PREFIX}AFF`), garage: { email: selfEmail } }, { settingsId: SETTINGS });
    check('NOBODY REFERS THEMSELVES: the affiliate\'s own email earns nothing',
      r.attributed === false && r.reason === 'self_referral'
        && (await prisma.tenantAttribution.count({ where: { group_id: g.id } })) === 0,
      r.message ?? '');
    await prisma.group.delete({ where: { id: g.id } }).catch(() => {});
  }

  // ── 6. ONCE, AND NEVER AFTERWARDS ───────────────────────────────────────────────────────────
  console.log('\n— referred once —');
  {
    const existing = a.attribution.party_id;
    const second = await AF.attributeAtSignup(prisma, {
      groupId: a.group.id, match: await AT.findPartyByRefCode(prisma, `${PREFIX}DUP`), garage: { email: 'someone@example.invalid' },
    }, { settingsId: SETTINGS });
    const now = await prisma.tenantAttribution.findMany({ where: { group_id: a.group.id, ended_at: null }, select: { party_id: true } });
    check('a garage already referred is NOT re-referred by a later code',
      second.attributed === false && second.reason === 'already_referred'
        && now.length === 1 && now[0].party_id === existing,
      'changing who a garage belongs to is an operator act, not something a second signup does');
    check('  …and re-running resolution is a no-op, not a second row',
      (await AT.resolveAttribution(prisma, a.group.id)).created === false
        && (await prisma.tenantAttribution.count({ where: { group_id: a.group.id, ended_at: null } })) === 1);
  }
  {
    // NEVER RETROSPECTIVE. A garage that signed up carrying no code does not acquire one because
    // an affiliate was created afterwards.
    const plain = await signUp('plain');
    check('a garage that arrived with no code stays unreferred',
      plain.group?.signup_ref === null && plain.attribution === null,
      'an affiliate created tomorrow does not reach backwards for it');
    const swept = await AT.resolveAllPending(prisma);
    check('  …and the operator sweep does not reach it either',
      (await prisma.tenantAttribution.count({ where: { group_id: plain.group.id } })) === 0,
      `${swept.scanned} group(s) scanned, ${swept.created} written`);
  }

  // ── 7. THE SWITCH GATES THE PRICE, NEVER THE RECORD ─────────────────────────────────────────
  console.log('\n— the offer switch —');
  await AF.saveSettings(prisma, { signupsOpen: false }, { settingsId: SETTINGS });
  {
    const g = await prisma.group.create({ data: { group_name: `${PREFIX} closed`, billing_email: `${PREFIX.toLowerCase()}-closed@example.invalid` }, select: { id: true } });
    const r = await AF.attributeAtSignup(prisma, { groupId: g.id, match: await AT.findPartyByRefCode(prisma, `${PREFIX}AFF`), garage: { email: `${PREFIX.toLowerCase()}-closed@example.invalid` } }, { settingsId: SETTINGS });
    check('a referred garage is attributed with the offer CLOSED',
      r.attributed === true && (await prisma.tenantAttribution.count({ where: { group_id: g.id, ended_at: null } })) === 1,
      'who introduced them is a fact; the discount is a decision');
    await prisma.tenantAffiliateTerms.deleteMany({ where: { group_id: g.id } }).catch(() => {});
    await prisma.tenantAttribution.deleteMany({ where: { group_id: g.id } }).catch(() => {});
    await prisma.group.delete({ where: { id: g.id } }).catch(() => {});
  }
  check('  …while the OFFER itself is refused',
    !!AF.refuseOffer({ code: `${PREFIX}AFF`, codeValid: true, isNewGarage: true, alreadyTaken: false, signupsOpen: false }));
  check('  …and the refusal says what it actually closed',
    /offer/i.test(AF.refuseOffer({ code: 'X', codeValid: true, isNewGarage: true, alreadyTaken: false, signupsOpen: false }))
      && !/programme is closed to new signups/i.test(AF.refuseOffer({ code: 'X', codeValid: true, isNewGarage: true, alreadyTaken: false, signupsOpen: false })),
    'the old wording read as though affiliates could no longer join, which nothing here controls');
  check('  …and the Engine Room label says the same thing',
    /offer/i.test((await import(`${R}/lib/programme-settings.ts`)).PLAN_SETTING_LABEL.affiliate_signups_open));
} catch (e) {
  console.log(`\n✗ THREW: ${describeError(e).slice(0, 700)}`);
  out.push('F');
} finally {
  await browser?.close().catch(() => {});
  const left = await sweep().catch(() => -1);
  check('teardown removed every fixture row (ZZ only)', left >= 0, left < 0 ? 'sweep threw — check for ZZATTR by hand' : `${left} row(s)`);
  console.log(`\n${out.filter((x) => x === 'F').length} failures of ${out.length}`);
  await prisma?.$disconnect();
  process.exit(out.includes('F') ? 1 : 0);
}
