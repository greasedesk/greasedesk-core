/**
 * File: scripts/support-route-gate.mjs
 * A GARAGE WITH A BROKEN DIARY CAN FIND US.
 * @gate-requires: server, db
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────────────────────────
 * The support number existed and was good. It was four levels down — Settings → Account → My Rep —
 * under a label naming a person most garages do not have: there are zero reps and zero attributions,
 * so every tenant reads the empty state. Nothing in the main rail pointed anywhere, and the one
 * route out linked to /contact, a MARKETING page: a signed-in garage clicking it got the public
 * site chrome and a cookie banner.
 *
 * ── WHAT THIS GATE CANNOT DRIVE, AND WHY IT SAYS SO ─────────────────────────────────────────────
 * IT NEVER POSTS THE FORM. RESEND_API_KEY is set on this machine and CONTACT_FORM_TO falls back to
 * a real inbox, so a gate that submitted would email a person on every run. The send path is left
 * alone deliberately.
 *
 * And the authenticated Turnstile bypass is asserted in SOURCE, not over HTTP, because
 * TURNSTILE_SECRET_KEY is unset here and verifyTurnstile then returns ok for everybody — an HTTP
 * test would pass whether the bypass existed or not, which is worse than no test. What IS driven is
 * the half that matters to a garage: the page renders, a signed-in user reaches it, and it does not
 * send them to the marketing site.
 *
 * ── AND THE LOGIN ADDRESS IS NOT PUBLISHED ──────────────────────────────────────────────────────
 * The rep card shipped with a `mailto:` to Rep.email — which is the LOGIN address, the credential
 * the rep signs in with. GreaseDesk publishes no email for itself on exactly this reasoning
 * (lib/company-info: "Contact is form-only… phone is the only published non-form contact route"),
 * so publishing a named individual's credential was a stricter standard for the company than for
 * its own staff.
 *
 * THE GUARD IS AT THE READ. `email` is simply not in the resolver's select, which is the rule that
 * file already applies to share_bp, payout_details and ref_code: "the safest way to keep them out
 * of a page is to keep them out of the object the page receives." Asserted twice — the object has
 * no such key, and the SERVED page does not contain the address anywhere.
 *
 * Fixtures on ZZ Gate Garage only. Never TMBS. A Rep and its attribution are created and deleted by
 * their own ids.
 */
import './_gate-preflight.mjs';
const { gatePrisma, explainIfClientStale, serverReady, describeError, gateOrigin } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { keyRegex, pathRegex } = await import('../lib/anchored-match.ts');
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');
const { readFileSync, existsSync } = await import('node:fs');
const R = await import('../lib/tenant-rep.ts').catch(() => ({}));
const C = await import('../lib/company-info.ts').catch(() => ({}));
const prisma = await gatePrisma();

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const BASE = gateOrigin();
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const code = (f) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l)).join('\n') : '');
/** Ofcom's drama range — unroutable, so a fixture rep can never be phoned by accident. */
const RAW_PHONE = '07700 900123';
/** Distinctive on purpose: the served page is searched for this exact string. */
const REP_EMAIL = 'zz-support-gate@greasedesk.test';
let fix = null, browser = null;

try {
  // ── 1. THE RAIL ──────────────────────────────────────────────────────────────────────────────
  console.log('\n— support is reachable without hunting for it —');
  const layout = code('components/layout/AdminLayout.tsx');
  const supportAt = layout.search(pathRegex('/admin/support'));
  const settingsAt = layout.search(pathRegex('/admin/settings'));
  check('the rail links to Support', supportAt > -1);
  check('  …above Settings, in the pinned group', supportAt > -1 && settingsAt > -1 && supportAt < settingsAt,
    `support@${supportAt} settings@${settingsAt} — reached when something is wrong, not in the flow of work`);
  // NOT one of the thirteen: those are filtered by `ready`, and a support route is never conditional.
  check('  …and is not in the work list', !keyRegex('key', "'support'").test(layout),
    'navItems is work; this belongs beside Settings');

  // ── 2. THE PAGE ──────────────────────────────────────────────────────────────────────────────
  const page = code('pages/admin/support.tsx');
  check('the support page exists', page.length > 0);
  check('  …with no role gate', page.length > 0 && !/requireAdminPage|isAdmin\s*\?|adminOnly/.test(page),
    'the person who picks up the phone in a workshop is rarely the account holder');
  check('  …leading with the number, click-to-call', /COMPANY\.phoneE164/.test(page) && /tel:/.test(page)); // @anchored-ok: a URL scheme in the page's href, not a property key
  check('  …hosting its own form', pathRegex('/api/contact').test(page));
  check('  …and NOT sending a signed-in garage to the marketing site',
    page.length > 0 && !/href="\/contact"/.test(page), 'that is public chrome and a cookie banner');

  // ── 3. THE AUTHENTICATED SUBMISSION NEEDS NO CAPTCHA ─────────────────────────────────────────
  // Source, not HTTP — see the header. Stated as a scan so nobody reads it as behavioural proof.
  const api = code('pages/api/contact.ts');
  check('the contact route knows who is signed in', /getServerSession/.test(api),
    'a garage we have already authenticated is not a bot');
  const callAt = api.indexOf('await verifyTurnstile(');
  check('  …and only challenges the public form',
    callAt > -1 && /if \(!tenant\)/.test(api.slice(Math.max(0, callAt - 300), callAt)),
    `SCAN, not behaviour: TURNSTILE_SECRET_KEY is unset here so verifyTurnstile passes everyone. `
    + `call@${callAt}`);

  // ── 4. THE PHONE IS DERIVED, NOT TYPED TWICE ─────────────────────────────────────────────────
  console.log('\n— a published number is dialled, so it is stored dialable —');
  const f = (v) => { try { return R.repPhoneFields?.(v, '44'); } catch { return null; } };
  check('repPhoneFields derives E.164', f(RAW_PHONE)?.phone_e164 === '447700900123', JSON.stringify(f(RAW_PHONE)));
  check('  …keeping what a person typed', f(RAW_PHONE)?.phone === RAW_PHONE, JSON.stringify(f(RAW_PHONE)?.phone));
  check('  …and absence stays absent, both halves',
    f(null)?.phone === null && f(null)?.phone_e164 === null, JSON.stringify(f(null)));

  const schema = readFileSync('prisma/schema.prisma', 'utf8');
  const rep = /^model Rep \{([\s\S]*?)^\}/m.exec(schema)?.[1] ?? '';
  check('Rep carries both columns, nullable', /phone\s+String\?/.test(rep) && /phone_e164\s+String\?/.test(rep),
    'a rep who has not published a number is an ordinary state, not a missing field');
  // ── THE INVITE COLUMNS ARE GONE, AND THIS CLAUSE IS INVERTED RATHER THAN DELETED ─────────────
  // It used to assert Rep HAD three set-password invite columns, on the reasoning that the
  // alternative once a real rep existed was somebody typing a colleague's password into a form.
  // On 2026-09-09 the answer became better than either: a rep has no password at all. They sign in
  // with a single-use magic link to the address that IS the credential, so there is nothing for an
  // invite to set. passwordHash went with them — a permanent INVITE_PENDING sentinel would have
  // been a check outliving the flow it guarded.
  //
  // Inverted, not removed: a deleted clause leaves nothing to stop the columns coming back, and the
  // next person to notice Operator has them and Rep does not needs the reason written down.
  const retracted = ['passwordHash', 'invite_token_hash', 'invite_token_expires', 'invite_token_used_at']
    .filter((c) => new RegExp(`^\\s*${c}\\s+\\w+`, 'm').test(rep));
  check('Rep carries no password and nothing to set one', retracted.length === 0,
    retracted.join(', ') || 'no password, no invite — the magic link is the whole credential');

  // ── 5. THE THREE STATES ──────────────────────────────────────────────────────────────────────
  console.log('\n— who a garage is told to call —');
  const before = await R.tenantRep?.(ZZ);
  check('no attribution reads as no rep', before === null, JSON.stringify(before));

  const repRow = await prisma.rep.create({
    data: { email: REP_EMAIL, name: 'Gate Rep',
      ref_code: 'ZZSUPPORTGATE', country_code: 'GB', phone: RAW_PHONE, phone_e164: '447700900123' },
    select: { id: true },
  });
  const attr = await prisma.tenantAttribution.create({
    data: { group_id: ZZ, party_type: 'rep', party_id: repRow.id, role: 'referrer',
      share_bp: 10000, effective_from: new Date('2026-01-01'), source: 'manual' },
    select: { id: true },
  });
  fix = { repId: repRow.id, attrId: attr.id };

  const assigned = await R.tenantRep?.(ZZ);
  check('an active rep is named', assigned?.name === 'Gate Rep', JSON.stringify(assigned));
  check('  …with the number a garage can dial', assigned?.phone === RAW_PHONE
    && assigned?.phoneE164 === '447700900123', JSON.stringify(assigned));
  // WITHHELD, as the resolver already promises: none of these is shaped for a tenant's eyes.
  check('  …and nothing private rides along',
    assigned && !('ref_code' in assigned) && !('payout_details' in assigned) && !('share_bp' in assigned)
    && !('email' in assigned),
    Object.keys(assigned ?? {}).join(', '));
  // THE KEY IS ABSENT, not null. A null would still be a field the page could learn to render.
  check('  …the login address is not in the object at all',
    assigned && Object.values(assigned).every((v) => String(v ?? '') !== REP_EMAIL),
    `keys: ${Object.keys(assigned ?? {}).join(', ')}`);
  const src = code('lib/tenant-rep.ts');
  check('  …and the resolver never selects it',
    !keyRegex('email', 'true').test(src) && !/rep\.email/.test(src),
    'kept out of the object the page receives, like share_bp and payout_details');

  await prisma.rep.update({ where: { id: repRow.id }, data: { phone: null, phone_e164: null } });
  const noPhone = await R.tenantRep?.(ZZ);
  check('a rep with no number still resolves', noPhone?.name === 'Gate Rep');
  check('  …and the number is absent, not blank', noPhone?.phone === null && noPhone?.phoneE164 === null,
    'the page omits the line rather than printing a placeholder');
  await prisma.rep.update({ where: { id: repRow.id }, data: { phone: RAW_PHONE, phone_e164: '447700900123' } });

  await prisma.rep.update({ where: { id: repRow.id }, data: { status: 'suspended' } });
  check('a suspended rep is not handed out', (await R.tenantRep?.(ZZ)) === null,
    'their contact details stop being ours to give');
  await prisma.rep.update({ where: { id: repRow.id }, data: { status: 'active' } });

  // ── 6. DRIVEN, AS A NON-ADMIN ────────────────────────────────────────────────────────────────
  console.log('\n— and a site manager, not just the account holder, can reach it —');
  const ready = await serverReady();
  check('the dev server serves pages before we drive it', ready.ok, `HTTP ${ready.status} after ${ready.attempts} attempt(s)`);
  browser = await chromium.launch({ channel: 'chrome' });
  const p = await (await browser.newContext({ viewport: { width: 1280, height: 1000 } })).newPage();
  await p.goto(`${BASE}/admin/login`, { waitUntil: 'domcontentloaded' });
  await p.fill('input[type="email"]', 'manager@zzgategarage.test');
  await p.fill('input[type="password"]', 'GateGarage!2026');
  await Promise.all([p.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }), p.click('button[type="submit"]')]);
  check('the site manager is signed in', !pathRegex('/admin/login').test(p.url()), p.url());

  await p.goto(`${BASE}/admin/support`, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('[data-testid="support-phone"]', { timeout: 30000 }).catch(() => {});
  const url = p.url();
  check('a non-admin reaches Support', pathRegex('/admin/support').test(url), url);
  const body = await p.evaluate(() => document.body.innerText);
  const telHref = await p.evaluate(() => document.querySelector('[data-testid="support-phone"]')?.getAttribute('href') ?? null);
  check('  …and the number is the first thing on it', telHref === `tel:${C.COMPANY?.phoneE164}`, String(telHref));
  check('  …with a message box on the page', (await p.$('[data-testid="support-message"]')) !== null);
  check('  …and the rep named beneath', /Gate Rep/.test(body) && /447700900123|07700 900123/.test(body),
    'the rep card is a section, not the page');
  // THE SERVED PAGE, not the object. A second reader could reintroduce the address without the
  // resolver changing at all.
  const html = await p.content();
  check('  …with the login address nowhere on it', !body.includes(REP_EMAIL) && !html.includes(REP_EMAIL),
    'the credential a rep signs in with is not a published contact route');
  check('  …and no mailto for the rep', !/mailto:zz-support-gate/.test(html)); // @anchored-ok: a URL scheme in served HTML, not a property key

  // ── 7. THE OLD ROUTE STILL WORKS ─────────────────────────────────────────────────────────────
  await p.goto(`${BASE}/admin/settings/rep`, { waitUntil: 'domcontentloaded' });
  check('the old My Rep URL lands on Support', pathRegex('/admin/support').test(p.url()), p.url());
  const settings = code('components/layout/SettingsLayout.tsx');
  check('  …and the subtab became a pointer', !keyRegex('name', "'My Rep'").test(settings) && pathRegex('/admin/support').test(settings));

  // ── 8. A DEAD LINK OFFERS A WAY TO REPORT IT ─────────────────────────────────────────────────
  const notFound = code('pages/404.tsx');
  check('404 offers Support', pathRegex('/admin/support').test(notFound),
    'a garage that hits a dead link has a problem and nowhere to say so');
  check('  …and stopped hardcoding a hex', !/#[0-9a-fA-F]{6}/.test(notFound) && /bg-accent/.test(notFound));
} catch (e) {
  check('gate run completed', false, describeError(e).slice(0, 300));
  await explainIfClientStale(BASE);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (fix) {
    try {
      if (fix.attrId) await prisma.tenantAttribution.delete({ where: { id: fix.attrId } });
      if (fix.repId) await prisma.rep.delete({ where: { id: fix.repId } });
    } catch (e) { console.log(`  teardown: ${describeError(e).slice(0, 120)}`); }
    const leftRep = await prisma.rep.count({ where: { id: fix.repId } });
    const leftAttr = await prisma.tenantAttribution.count({ where: { id: fix.attrId } });
    check('teardown removed the rep and its attribution', leftRep === 0 && leftAttr === 0,
      `rep=${leftRep} attribution=${leftAttr} — a stray attribution would make ZZ look referred`);
  }
}

console.log(`\n${out.filter((x) => x === 'F').length} failures of ${out.length}`);
await prisma.$disconnect();
process.exit(out.includes('F') ? 1 : 0);
