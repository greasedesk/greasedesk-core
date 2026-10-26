/**
 * File: scripts/trial-setting-gate.mjs
 * @gate-requires: db, server
 *
 * ONE TRIAL LENGTH, AND EVERY SURFACE READS IT.
 *
 * ── THE DEFECT THIS EXISTS FOR ──────────────────────────────────────────────────────────────────
 * The trial length lived in TWO hard-coded constants, both 60, kept in step by a COMMENT saying one
 * mirrored the other — so changing one would give a garage a Stripe trial of one length and a
 * trial_ends_at of another, with nothing anywhere to notice. Seven more 60s sat in marketing copy.
 *
 * ── WHAT THIS GATE IS REALLY FOR ────────────────────────────────────────────────────────────────
 * Not "the number is 30" — that is a setting and will change. It is that there is exactly ONE place
 * the number can come from, and that every surface reaches it. The clause that does the work is the
 * FIRST one, and it runs before anything else: no literal trial length in pages/, components/ or
 * lib/. Every other clause in this file passes the day somebody re-introduces a constant that
 * happens to equal the setting. That one does not.
 *
 * FIXTURES ON ZZ ONLY — except that the SETTING IS GLOBAL. It is restored in a registered teardown
 * AND in the finally: a gate that exits leaving the trial length at 17 has changed what every later
 * signup is offered, on the same database production reads.
 */
import './_gate-preflight.mjs';
const { gatePrisma, describeError, gateOrigin, serverReady, onTeardown, declineToRun, erOrigin, ER_RESOLVER_ARGS } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');
const { underPath } = await import('/Users/hugh/Developer/greasedesk-core/lib/anchored-match.ts');
const { i18n: I18N } = (await import('/Users/hugh/Developer/greasedesk-core/next-i18next.config.js')).default;
const bcrypt = (await import('bcryptjs')).default;
const { readFileSync, readdirSync, statSync, existsSync } = await import('node:fs');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const R = '/Users/hugh/Developer/greasedesk-core';
/** A module that may not be built yet: every clause below it then fails with a REASON, not a throw. */
const soft = async (p) => { try { return await import(p); } catch (e) { console.log(`   (${p.replace(`${R}/`, '')}: ${describeError(e).slice(0, 90)})`); return null; } };

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const OWNER_EMAIL = 'zz-trial-setting-gate-owner@greasedesk.test';
const SUPPORT_EMAIL = 'zz-trial-setting-gate-support@greasedesk.test';
const OP_PASS = 'TrialSettingGate!2026';
const ER = erOrigin();

let prisma; let browser = null; let settingWas = null; let zzTrialWas; let opIds = [];
/** The last value THIS GATE put in the setting. null = the gate has not written it. */
let gateWrote = null;
let sweepVerdict = null; // 'restored' | 'left-alone'

/**
 * RESTORE ONLY WHAT THIS GATE WROTE.
 *
 * ── WHY THIS IS NOT `updateMany({ trial_days: settingWas })` ────────────────────────────────────
 * It was, and on 2026-10-25 it changed a public offer. trial_days is GLOBAL and a person can edit
 * it in the Engine Room at any moment, including while this gate runs. The owner nudged the field
 * to 46 and corrected it to 45 six seconds later; a run that started inside those six seconds
 * captured 46 as "what it was", and every sweep after that restored 46 over the owner's 45. The
 * ISR boundary then passed and greasedesk.com advertised a 45→46 typo as a real offer.
 *
 * So the rule is not "put back what I found" but "undo what I did": if the value is still the one
 * this gate last wrote, put the original back; if it is anything else, a PERSON changed it during
 * the run and their decision outranks this gate's bookkeeping. Leave it, and say so loudly —
 * silence would be the gate deciding on its own that it had tidied up.
 */
const shouldRestoreSetting = (now, written) => written !== null && now === written;

/**
 * ONE SWEEP, TWO CALLERS — registered with onTeardown (which only runs on a signal) AND awaited in
 * this gate's own finally. Registering without calling is the failure mode the harness docstring
 * warns about, and it is not theoretical: the first run of this section registered its sweep,
 * exited normally, and left a live OWNER operator on the production database.
 *
 * Idempotent, because a gate killed mid-sweep runs parts of it twice.
 */
const sweep = async () => {
  if (!prisma) return;
  if (settingWas !== null) {
    const now = (await prisma.programmeSettings.findUnique({ where: { id: 'singleton' }, select: { trial_days: true } }).catch(() => null))?.trial_days ?? null;
    if (shouldRestoreSetting(now, gateWrote)) {
      await prisma.programmeSettings.updateMany({ data: { trial_days: settingWas } }).catch(() => {});
      sweepVerdict = 'restored';
    } else if (gateWrote !== null) {
      console.log(`  SWEEP LEFT trial_days AT ${now}. This gate last wrote ${gateWrote}, so somebody`);
      console.log(`  changed it during the run. Restoring ${settingWas} would overwrite a person's decision,`);
      console.log(`  which is how a 46-day trial reached the public site on 2026-10-25.`);
      sweepVerdict = 'left-alone';
    } else {
      sweepVerdict = 'restored'; // nothing written, nothing to undo
    }
  }
  if (zzTrialWas !== undefined) await prisma.group.update({ where: { id: ZZ }, data: { trial_ends_at: zzTrialWas } }).catch(() => {});
  if (opIds.length) await prisma.operator.deleteMany({ where: { id: { in: opIds } } }).catch(() => {});
};

try {
  // ── 1. THE CLAUSE THAT KEEPS IT ONE NUMBER ─────────────────────────────────────────────────
  // FIRST, and with no database or server behind it, so it reports even on the run where nothing
  // else is built yet. Two patterns, because the defect had two shapes: the COPY ("60-day free
  // trial") and the CONSTANT (`TRIAL_PERIOD_DAYS = 60`).
  console.log('— no literal trial length anywhere —');
  const walk = (dir, acc = []) => {
    if (!existsSync(dir)) return acc;
    for (const e of readdirSync(dir)) {
      const p = `${dir}/${e}`;
      if (statSync(p).isDirectory()) walk(p, acc);
      else if (/\.(ts|tsx)$/.test(e)) acc.push(p);
    }
    return acc;
  };
  // ANCHORED on the phrase and on the identifier, never on the bare digits: `* 24 * 60 * 60 *
  // 1000`, 60 days of GRACE and a car declined 60 days ago are all legitimate and none of them is
  // a trial length.
  const COPY = /(\b\d{1,3}\s*[- ]?\s*days?\b[^.\n]{0,24}\btrial\b)|(\btrial\b[^.\n]{0,24}\b\d{1,3}\s*[- ]?\s*days?\b)/i;
  // The identifier must name BOTH a trial and a DAY count. `STRIPE_MIN_TRIAL_HOURS = 48` is a
  // Stripe API floor in hours, not a trial length, and the first draft of this clause flagged it.
  //
  // AND THE NUMBER MUST BE POSITIVE. `trialDays: 0` is the ABSENCE of a trial — it is how
  // lib/billing-plans says "this annual shape has none", which is the trial-or-pay-now rule, not
  // an offer to anybody. A zero cannot be a wrong trial length: refusePlanSettings rejects one
  // and the TenantPlanTerms_trial_xor_paynow CHECK rejects the row.
  const CONST = /\b[A-Za-z_]*trial[A-Za-z_]*day[A-Za-z_]*\s*[=:]\s*\{?\s*[1-9]\d*/i;
  const files = [...walk(`${R}/pages`), ...walk(`${R}/components`), ...walk(`${R}/lib`)];
  const hits = [];
  for (const f of files) {
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (COPY.test(line) || CONST.test(line)) hits.push(`${f.replace(`${R}/`, '')}:${i + 1}  ${line.trim().slice(0, 86)}`);
    });
  }
  check('NO literal trial length survives in pages/, components/ or lib/', hits.length === 0,
    hits.length ? `${hits.length} hit(s):\n    ${hits.join('\n    ')}` : `${files.length} files scanned, none carries one`);
  check('  …and the scan would FIND one — it is not a pair of regexes that match nothing',
    COPY.test('Start your 60-day free trial') && COPY.test('The trial runs 60 days.')
      && CONST.test('export const TRIAL_PERIOD_DAYS = 60;') && CONST.test('trial_period_days: 60,')
      && !CONST.test('export const STRIPE_MIN_TRIAL_HOURS = 48;')
      && !CONST.test('trialDays: 0, payNowPennies: months * price,')
      && !COPY.test('TRIAL_DAYS * 24 * 60 * 60 * 1000') && !COPY.test('60 days of grace over a 90-day hold')
      && !CONST.test('trial_period_days: await trialDays(),') && !CONST.test('trialEndsAt: g.trial_ends_at'),
    'an unproved scan did not run: it must match the real copy AND the real constants, and leave the real non-trial 60s alone');

  prisma = await gatePrisma();
  onTeardown(sweep);
  /** THE ONE PLACE THIS GATE WRITES THE SETTING, so the sweep always knows what it put there. */
  var setSetting = async (n) => {
    await prisma.programmeSettings.update({ where: { id: 'singleton' }, data: { trial_days: n } });
    gateWrote = n;
  };
  const ready = await serverReady();
  check('the dev server serves pages before we drive it', ready.ok, `HTTP ${ready.status} after ${ready.attempts} attempt(s)`);

  const PS = await soft(`${R}/lib/programme-settings.ts`);
  const row = await prisma.programmeSettings.findUnique({ where: { id: 'singleton' }, select: { trial_days: true } });
  check('premise: there is a settings row to read', !!row, row ? `trial_days=${row.trial_days}` : 'NONE — every clause below would assert nothing');
  settingWas = row?.trial_days ?? 30;

  // CAPTURED HERE, NOT WHERE IT IS USED. Section 5 needs ZZ's trial date as it was BEFORE this gate
  // ran, and sections 4 and 6 call saveTrialDays several times first. Reading it late would capture
  // whatever those saves had already done to it — which is exactly how a red-proof of section 5's
  // clause moved the date and then "restored" the moved value.
  zzTrialWas = (await prisma.group.findUnique({ where: { id: ZZ }, select: { trial_ends_at: true } }))?.trial_ends_at ?? null;

  const stale = await prisma.operator.count({ where: { email: { in: [OWNER_EMAIL, SUPPORT_EMAIL] } } });
  if (stale) declineToRun(`${stale} operator(s) from a previous run are still on the system — remove them before re-running.`);

  // ── 2. THE BEHAVIOUR READS IT ───────────────────────────────────────────────────────────────
  console.log('\n— what Stripe is told, and what the card says —');
  check('trialDays() resolves from the SETTING', PS && (await PS.trialDays()) === settingWas, PS ? `${await PS.trialDays()} vs ${settingWas}` : 'lib/programme-settings not built');
  const endsNow = PS ? await PS.trialEndsAt() : null;
  const dNow = endsNow ? Math.round((endsNow.getTime() - Date.now()) / 86_400_000) : -1;
  check('trial_ends_at is the SETTING days out', dNow === settingWas, `${dNow} days`);
  // THE DISCRIMINATOR for both. Without it, two constants that happen to equal the setting today
  // would pass the two clauses above and the gate would report a single source that is not one.
  let moved = false;
  if (PS) {
    await setSetting(17);
    moved = (await PS.trialDays()) === 17
      && Math.round(((await PS.trialEndsAt()).getTime() - Date.now()) / 86_400_000) === 17;
    await setSetting(settingWas);
  }
  check('  …and BOTH follow the setting when it MOVES', moved,
    'a constant that happens to match today passes the two clauses above and fails this one');

  // ── 3. EVERY SURFACE SHOWS IT ───────────────────────────────────────────────────────────────
  // Each clause asserts the NUMBER IS PRESENT, not that the old one is absent: a page that reads
  // the setting and renders nothing would pass a "does not say 60" test. Removal needs a destination.
  console.log('\n— and every surface a customer reads —');
  // ER_RESOLVER_ARGS maps er.greasedesk.com to localhost. Without it middleware 404s every
  // /superadmin path and section 6 would be testing a Not Found page.
  browser = await chromium.launch({ channel: 'chrome', args: ER_RESOLVER_ARGS });
  const page = await (await browser.newContext()).newPage();
  const bodyOf = async (path) => {
    await page.goto(`${gateOrigin()}${path}`, { waitUntil: 'domcontentloaded' });
    return ((await page.textContent('body')) ?? '').replace(/\s+/g, ' ');
  };
  const says = async (path, label, n = settingWas) => {
    const body = await bodyOf(path);
    check(`${label} shows the setting's number`, new RegExp(`\\b${n}[- ]day`, 'i').test(body),
      body.match(/\b\d{1,3}[- ]day/i)?.[0] ?? `no "N-day" anywhere in ${path}`);
    check('  …and no OTHER trial length on it',
      !(body.match(/\b(\d{1,3})[- ]day free trial/gi) ?? []).some((m) => !new RegExp(`\\b${n}\\b`).test(m)),
      (body.match(/\b\d{1,3}[- ]day free trial/gi) ?? []).join(' | ') || 'none');
  };
  await says('/', 'the homepage');
  await says('/pricing', 'the pricing page');

  const llms = await (await fetch(`${gateOrigin()}/llms.txt`)).text();
  check('/llms.txt shows the setting’s number', new RegExp(`\\b${settingWas}-day`).test(llms),
    llms.match(/\b\d{1,3}-day[^.]*/)?.[0] ?? 'no N-day line');

  // The onboarding page is behind auth, so it is read as the module's own copy rather than driven:
  // what is asserted is that its heading and body are a FUNCTION of the prop, not a literal.
  const onboarding = readFileSync(`${R}/pages/onboarding/billing.tsx`, 'utf8');
  check('the checkout page’s copy is a function of the prop, not a literal',
    /\$\{?trialDays\}?|\{trialDays\}/.test(onboarding) && !/\d{1,3}-day free trial/.test(onboarding),
    onboarding.match(/\d{1,3}-day free trial/)?.[0] ?? 'interpolated');

  // THE FIRST EMAIL A GARAGE EVER RECEIVES. It is rendered here rather than sent: sendNotification
  // would write a NotificationLog row and, on a non-demo tenant, actually post it.
  const T = await soft(`${R}/lib/notification-templates.ts`);
  const verify = T?.NOTIFICATION_TEMPLATES?.signup_verify?.email?.({ name: 'Gate', link: 'https://x.invalid', trialDays: settingWas });
  check('the verification email names the setting’s number',
    !!verify && new RegExp(`\\b${settingWas}-day`).test(verify.html),
    verify ? (verify.html.match(/\b\d{1,3}-day[^<.]*/)?.[0] ?? 'no N-day in the body') : 'template not reached');
  check('  …and it says the number it was GIVEN, not one of its own',
    !!T && /\b44-day/.test(T.NOTIFICATION_TEMPLATES.signup_verify.email({ name: 'G', link: 'x', trialDays: 44 }).html ?? ''),
    'a template with the number baked in passes the clause above on the day the setting happens to match');

  // ── 4. CHANGING IT IN THE ENGINE ROOM CHANGES THEM, WITH NO DEPLOY ──────────────────────────
  // WHAT THIS CANNOT PROVE, stated plainly. In dev, getStaticProps runs on EVERY request, so "the
  // page changed" would pass even if on-demand revalidation did nothing at all — the production
  // mechanism is simply not exercised here, and a green here is not a green on the live site. So
  // the clauses assert what IS checkable in dev: the save reports exactly which paths it asked to
  // revalidate, and REPORTS a failure instead of swallowing it. Confirming the live homepage after
  // deploy is the other half and it is a person's job, every time this ships.
  console.log('\n— saving it in the Engine Room —');
  const O = gateOrigin();
  const save = async (days, revalidate) => {
    const r = await PS.saveTrialDays(prisma, { days, actorId: null, revalidate, origin: O });
    gateWrote = days;
    return r;
  };

  check('the sweep restores ONLY the value this gate itself wrote',
    shouldRestoreSetting(23, 23) === true && shouldRestoreSetting(45, 23) === false && shouldRestoreSetting(45, null) === false,
    'a person editing the setting mid-run outranks the gate\u2019s bookkeeping — restoring over them put a 46-day trial on the public site');

  // ── THE TARGETS ARE THE PRERENDERED ROUTE KEYS, AND THEY ARE DERIVED ───────────────────────
  // THE EXTRACTOR IS THE ORACLE FOR EVERY VERIFICATION CLAUSE BELOW, so it is proved first, on a
  // planted case. React's SSR markers split an interpolated number out of its text run, and an
  // extractor that cannot read through them reports "no number" about a page plainly showing one —
  // which reads as a failed refresh and would have sent us hunting the wrong defect.
  check('the extractor reads through React\u2019s SSR comment markers',
    PS?.renderedTrialDays('<p>Start your <!-- -->45<!-- -->-day free trial</p>') === 45,
    String(PS?.renderedTrialDays('<p>Start your <!-- -->45<!-- -->-day free trial</p>')));
  check('  …ignores __NEXT_DATA__ and says nothing when the page names two numbers',
    PS?.renderedTrialDays('<script>{"trialDays":99}</script><p>a 45-day trial</p>') === 45
      && PS?.renderedTrialDays('<p>a 45-day trial</p><p>a 30-day trial</p>') === null,
    'a page carrying two different lengths is not evidence of either');

  const targets = PS ? PS.revalidationTargets() : [];
  check('every revalidation target is LOCALE-PREFIXED', targets.length > 0 && targets.every((t) => /^\/[a-z]{2}-[A-Z]{2}(\/|$)/.test(t)),
    `${JSON.stringify(targets)} — production answers x-matched-path: /en-GB, so '/' addresses a page that is not the one in the cache`);
  check('  …and DERIVED from the i18n config, not written out',
    targets.length === I18N.locales.length * 2 && I18N.locales.every((l) => targets.includes(`/${l}`) && targets.includes(`/${l}/pricing`)),
    `${I18N.locales.length} locale(s) → expected ${I18N.locales.length * 2} targets, got ${targets.length}`);
  // AND EACH ONE IS A PAGE THIS SITE ACTUALLY SERVES. A target that 404s is a refresh of nothing,
  // which is exactly the shape that passed for an hour.
  const statuses = await Promise.all(targets.map(async (t) => [t, (await fetch(`${O}${t}`, { method: 'HEAD' })).status]));
  check('  …and every target is a page the site actually serves',
    statuses.every(([, st]) => st === 200), JSON.stringify(statuses));

  const saved = PS ? await save(21, async (p) => p) : null;
  check('the save reports WHICH paths it attempted',
    Array.isArray(saved?.attempted) && targets.every((t) => saved.attempted.includes(t)),
    JSON.stringify(saved?.attempted));
  check('  …and VERIFIES by reading the public pages back', saved?.verified === true,
    JSON.stringify(saved?.checks));
  const failed = PS ? await save(21, async () => { throw new Error('edge said no'); }) : null;
  check('  …and a THROWN revalidation is REPORTED, not swallowed', failed?.revalidateError != null,
    'a save that succeeds while the homepage keeps the old number is the worst outcome of the lot');

  // ── THE CLAUSE THAT WOULD HAVE CAUGHT 2026-10-25 ───────────────────────────────────────────
  // res.revalidate() RESOLVED for both pages and neither changed, and the screen said "refreshed".
  // A no-op refresher is indistinguishable from a working one unless the page is read back, so
  // this is the shape the whole rewrite exists for: the attempt succeeds and nothing happens.
  const noop = PS ? await PS.saveTrialDays(prisma, {
    days: 19, actorId: null, revalidate: async (p) => p,
    origin: `${O}/__a-path-that-serves-no-trial-number`,
  }) : null;
  check('a refresh that RESOLVES but changes nothing is NOT reported as refreshed',
    noop?.verified === false && noop?.note != null && noop?.revalidateError == null,
    `verified=${noop?.verified} note=${JSON.stringify(noop?.note)} — this is the exact defect: no throw, no change, "refreshed"`);
  const afterNoop = await prisma.programmeSettings.findUnique({ where: { id: 'singleton' }, select: { copy_revalidated_at: true, copy_revalidate_error: true } });
  check('  …and the ROW records it as unconfirmed, not as a refresh',
    afterNoop?.copy_revalidate_error != null, JSON.stringify(afterNoop));

  check('  …and a nonsense length is REFUSED, not written',
    PS ? await save(0, async (p) => p).then(() => false, () => true) : false,
    'the one field here sets what every new garage is offered');
  if (PS) { await save(settingWas, async (p) => p); }

  // ── 5. AND NOBODY ALREADY ON A TRIAL MOVES ──────────────────────────────────────────────────
  // There are no garages on a trial today, so this clause has NOTHING TO CHECK and says so — a
  // clean verdict over an empty population is a positive report of safety, which is a lie. It
  // plants one instead, moves the setting, and asserts the planted date did not follow.
  console.log('\n— and an existing trial does not move —');
  const planted = new Date('2027-03-04T00:00:00.000Z');
  await prisma.group.update({ where: { id: ZZ }, data: { trial_ends_at: planted } });
  if (PS) await PS.saveTrialDays(prisma, { days: 13, actorId: null, revalidate: async (p) => p });
  const after = (await prisma.group.findUnique({ where: { id: ZZ }, select: { trial_ends_at: true } }))?.trial_ends_at ?? null;
  check('a garage already on a trial keeps the date it was given',
    after?.getTime() === planted.getTime(), `${after?.toISOString()} vs ${planted.toISOString()}`);
  if (PS) await setSetting(settingWas);
  await prisma.group.update({ where: { id: ZZ }, data: { trial_ends_at: zzTrialWas } });

  // ── 6. AND IT IS A SCREEN AN OWNER CAN ACTUALLY TYPE INTO ───────────────────────────────────
  // Everything above tests the module. A setting whose only writer is a gate is a database write
  // with extra steps — it has to be reachable, and reachable by the right person. This drives the
  // real Engine Room screen on its real host, which is also the only thing that proves the route,
  // the host rule, the owner gate and the form are wired to each other.
  console.log('\n— on the real Engine Room screen —');
  const mkOp = async (email, role) => (await prisma.operator.create({
    data: { email, name: 'Trial Setting Gate', role, status: 'active', regions: ['GB'],
      passwordHash: await bcrypt.hash(OP_PASS, 10) },
    select: { id: true },
  })).id;
  opIds = [await mkOp(OWNER_EMAIL, 'owner'), await mkOp(SUPPORT_EMAIL, 'support')];

  const erCtx = await browser.newContext({ viewport: { width: 1280, height: 1400 } });
  const er = await erCtx.newPage();
  const signIn = async (email) => {
    await er.goto(`${ER}/superadmin/login`, { waitUntil: 'domcontentloaded' });
    await er.fill('input[type="email"]', email);
    await er.fill('input[type="password"]', OP_PASS);
    await er.click('button[type="submit"]');
    await er.waitForURL((u) => !underPath(u.pathname, '/superadmin/login'), { timeout: 60000 }).catch(() => {});
    await er.waitForTimeout(600);
  };
  await signIn(OWNER_EMAIL);
  await er.goto(`${ER}/superadmin/billing`, { waitUntil: 'domcontentloaded' });
  // WAIT FOR THE FIELD TO BE POPULATED, not merely present. The input is in the first render with
  // an empty value and is filled by a client fetch, so waiting for the ELEMENT waits for nothing:
  // on a dev server that is still compiling the API route the fetch takes seconds, and a fixed
  // 400ms wait then asserted against an empty box. Wait for the condition, not a proxy for it.
  await er.waitForFunction(
    () => (document.querySelector('[data-testid="trial-days"]')?.value ?? '') !== '',
    null, { timeout: 60000 },
  ).catch(() => {});
  const field = er.locator('[data-testid="trial-days"]');
  check('the owner reaches the Billing screen and it shows the current setting',
    (await field.count()) === 1 && (await field.inputValue()) === String(settingWas),
    `${await field.count()} field(s), value ${await field.count() ? await field.inputValue() : 'n/a'}`);
  // Typed in, submitted, and read back from the DATABASE — not from the screen's own state, which
  // would be the screen agreeing with itself.
  await field.fill('23');
  await er.click('button:has-text("Save")');
  // WAIT FOR THE SAVE TO ANSWER, not for a guessed number of milliseconds. The save now reads the
  // public pages back before it replies, so it takes seconds rather than one round trip — and a
  // fixed 1500ms wait asserted against the state BEFORE the save, which read as two failures of
  // the screen rather than as a gate that had not waited.
  await er.waitForSelector('[data-testid="save-result"]', { timeout: 60000 }).catch(() => {});
  // AND THEN WAIT FOR THE SCREEN TO HAVE RE-READ. setMsg fires before `await refresh()`, so the
  // banner appearing says the SAVE returned, not that the page has caught up — the attribution
  // line can still be showing the previous change. A fixed wait was enough until the GET grew;
  // this waits for the thing the next clause asserts.
  await er.waitForFunction(
    () => /Last changed .* by Trial Setting Gate/.test(document.body.innerText),
    null, { timeout: 60000 },
  ).catch(() => {});
  const typed = (await prisma.programmeSettings.findUnique({ where: { id: 'singleton' }, select: { trial_days: true } }))?.trial_days;
  gateWrote = 23; // the SCREEN wrote it, but this gate caused it — the sweep must own it
  check('  …and typing a number into it changes the setting', typed === 23, `trial_days=${typed}`);
  const erText = (await er.textContent('body'))?.replace(/\s+/g, ' ') ?? '';
  check('  …and the screen then names who changed it and when',
    /Last changed .* by Trial Setting Gate/.test(erText), erText.match(/Last changed[^.]*/)?.[0] ?? 'no attribution line');
  // SHARPENED. This first asserted that the words "Public pages … refreshed" appeared, which all
  // THREE branches of that line satisfy — including "have not been refreshed from here yet". It
  // could not be made red, so it was testing nothing. The save above succeeded, so the only
  // acceptable wording is the one that names WHEN, and the time has to be the save just made.
  // ── WHAT THE SCREEN SAYS ABOUT THE PUBLIC SITE MUST BE A READING OF IT ─────────────────────
  // The old clause here compared the screen's "last refreshed <time>" against the stored stamp —
  // the screen agreeing with the row that the same save had just written. Both were wrong together
  // for an hour. This asserts the screen has gone and LOOKED, and says what it found.
  await er.waitForSelector('[data-testid="public-copy-agrees"], [data-testid="public-copy-disagrees"]', { timeout: 30000 }).catch(() => {});
  const agreesEl = await er.locator('[data-testid="public-copy-agrees"]').count();
  const copyLine = (await er.textContent('body'))?.replace(/\s+/g, ' ') ?? '';
  check('  …and the screen reports what the public site is ACTUALLY showing',
    agreesEl === 1 && /The public site agrees/.test(copyLine),
    copyLine.match(/The public site[^.]*/)?.[0] ?? 'no public-site line at all');
  await setSetting(settingWas);

  // UNDISCOVERABLE, not forbidden: a support operator must get Not Found, never a 403 that would
  // confirm a screen exists for setting commercial terms.
  await erCtx.clearCookies();
  await signIn(SUPPORT_EMAIL);
  const r404 = await er.goto(`${ER}/superadmin/billing`, { waitUntil: 'domcontentloaded' });
  check('a support operator gets 404, not a 403 that confirms the screen exists',
    r404?.status() === 404, `HTTP ${r404?.status()}`);
} catch (e) {
  console.log(`\n✗ THREW: ${describeError(e).slice(0, 700)}`);
  out.push('F');
} finally {
  await browser?.close().catch(() => {});
  await sweep();
  // ASSERTED, not assumed. A sweep that silently failed would leave the next signup on the wrong
  // trial and a live operator account on a production database — so the gate reads back what it
  // actually left behind and reports it as a clause of its own.
  const back = await prisma?.programmeSettings.findUnique({ where: { id: 'singleton' }, select: { trial_days: true } }).catch(() => null);
  const opsLeft = await prisma?.operator.count({ where: { id: { in: opIds } } }).catch(() => -1);
  const zzNow = (await prisma?.group.findUnique({ where: { id: ZZ }, select: { trial_ends_at: true } }).catch(() => null))?.trial_ends_at ?? null;
  check('the sweep undid this gate\u2019s own changes, and left anyone else\u2019s alone',
    opsLeft === 0 && String(zzNow) === String(zzTrialWas ?? null)
      && (sweepVerdict === 'left-alone' || back?.trial_days === settingWas),
    `trial_days ${back?.trial_days} (sweep ${sweepVerdict}, original ${settingWas}); operators left ${opsLeft}; ZZ ${String(zzNow)} vs ${String(zzTrialWas ?? null)}`);
  console.log(`\n${out.filter((x) => x === 'F').length} failures of ${out.length}`);
  await prisma?.$disconnect();
  process.exit(out.includes('F') ? 1 : 0);
}
