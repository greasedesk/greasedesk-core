/**
 * File: scripts/trial-control-gate.mjs
 * THE TRIAL EXTENSION CONTROL, DRIVEN THE WAY AN OPERATOR DRIVES IT.
 * @gate-requires: server:3000, db
 *
 * ── THE GAP THIS CLOSES, TWICE OVER ─────────────────────────────────────────────────────────────
 * The addressee endpoint shipped with no control at all behind a green gate, because the gate drove
 * it with fetch. The trial endpoint then shipped with a control that could not be used — three
 * prompt() calls, a pre-filled date that made the obvious gesture a REDUCTION, and no catch, so a
 * rejected fetch reset the button and said nothing. Both gates were green. Both drove the API.
 *
 * So this one signs in as an operator and presses the button.
 *
 * ── REACHING THE ENGINE ROOM AT ALL ─────────────────────────────────────────────────────────────
 * middleware.ts serves /superadmin only on er.greasedesk.com and 404s it everywhere else, so a gate
 * on localhost could not see the portal. Chromium is launched with a host-resolver rule mapping
 * that hostname to the local server: the browser genuinely sends Host: er.greasedesk.com, the real
 * middleware runs, and the real host routing is exercised rather than bypassed.
 *
 * Its own operator is created and torn down — support role, GB region, no second factor (2FA is
 * enforced only when enrolled, see the authorize() branch). Two suspended gate operators already
 * exist from earlier work; this makes a third only for the length of the run, and asserts it is
 * gone at the end. An operator row that outlives its gate is a credential nobody meant to leave.
 *
 * Fixtures on ZZ Gate Garage only. Never TMBS. ZZ's trial_ends_at is set for the run and RESTORED
 * to what it was — it is the gate tenant, and nothing reads that column for ZZ (the billing gate
 * derives from Stripe, and ZZ has no subscription).
 */
import './_gate-preflight.mjs';
const { gatePrisma, explainIfClientStale, serverReady, describeError } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');
const { readFileSync } = await import('node:fs');
const bcrypt = (await import('/Users/hugh/Developer/greasedesk-core/node_modules/bcryptjs/index.js')).default;
const X = await import('../lib/trial-extension.ts').catch(() => ({}));
const prisma = await gatePrisma();

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const PAGE = 'pages/superadmin/tenants/[id].tsx';
const OP_EMAIL = 'zz-trial-control-gate@greasedesk.test';
const OP_PASS = 'TrialControlGate!2026';
const ER = 'http://er.greasedesk.com:3000';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const prose = (src) => src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const ymd = (d) => d.toISOString().slice(0, 10);
let fix = null, browser = null, clickErr = null;

try {
  const stale = await prisma.operator.count({ where: { email: OP_EMAIL } });
  if (stale) throw new Error('REFUSING: an operator from a previous run is still present');

  // ── 1. THE PROMPTS ARE GONE AND EVERY HANDLER CATCHES ────────────────────────────────────────
  console.log('\n— the page no longer asks in dialogs —');
  const src = prose(readFileSync(PAGE, 'utf8'));
  // SCOPED TO THE TRIAL HANDLER, not the whole page. The phone-exemption control legitimately asks
  // for one reason in a prompt and is not in this slice; banning the call everywhere would be a
  // claim about a file rather than about the defect. What broke was THREE in a row in one handler —
  // exactly the pattern that makes Chrome offer to suppress dialogs, after which every prompt
  // returns null and the handler exits in silence.
  const trialHandler = src.slice(src.indexOf('async function extendTrial'), src.indexOf('async function extendTrial') + 2200);
  check('the trial handler asks in no dialogs at all',
    !/window\.prompt\(|window\.confirm\(|[^.\w]alert\(/.test(trialHandler),
    trialHandler.length ? 'it collected a date, a category and a note in three prompts' : 'HANDLER NOT FOUND');
  // A REJECTED FETCH MUST SAY SO. `finally` alone resets the button, so a failure looked like a
  // completion — the reported symptom, and the shape of every silent failure in this codebase.
  const handlers = [...src.matchAll(/async function (\w+)\s*\([^)]*\)\s*\{/g)].map((m) => m[1]);
  const fetchHandlers = handlers.filter((h) => {
    const body = src.slice(src.indexOf(`async function ${h}`), src.indexOf(`async function ${h}`) + 2200);
    return /fetch\(/.test(body);
  });
  const uncaught = fetchHandlers.filter((h) => {
    const body = src.slice(src.indexOf(`async function ${h}`), src.indexOf(`async function ${h}`) + 2200);
    return !/\}\s*catch\s*\(/.test(body);
  });
  check('every handler that fetches also catches', uncaught.length === 0,
    uncaught.join(', ') || `${fetchHandlers.length} handlers: ${fetchHandlers.join(', ')}`);
  check('  …and there are three of them to check', fetchHandlers.length === 3, fetchHandlers.join(', '));

  // ── 2. THE DATE IS A DATE, RESOLVED SERVER-SIDE ──────────────────────────────────────────────
  console.log('\n— a plain date, resolved where the rule lives —');
  check('lib/trial-extension resolves a plain date', typeof X.resolveTrialDate === 'function',
    `resolveTrialDate=${typeof X.resolveTrialDate}`);
  const resolved = (() => { try { return X.resolveTrialDate('2026-11-03'); } catch { return null; } })();
  check('  …to the END of that day', resolved?.toISOString?.() === '2026-11-03T23:59:59.999Z',
    String(resolved?.toISOString?.()));
  // THE DEFECT THAT MADE THE FIRST ATTEMPT FAIL: noon UTC against a trial ending at 15:32 is a
  // REDUCTION, so extending "to the same day" was refused as a shortening.
  const sameDay = (() => {
    try {
      return X.validateExtension({ current: new Date('2026-11-03T15:32:39.000Z'), next: X.resolveTrialDate('2026-11-03'),
        category: 'sales', note: 'Same day, later — this used to be refused as a reduction', now: new Date('2026-09-05T12:00:00.000Z') });
    } catch { return null; }
  })();
  check('a same-day extension is expressible', sameDay?.ok === true,
    `${JSON.stringify(sameDay)} — noon UTC made this a 3½-hour reduction`);

  // ── 3. THE FIXTURES ──────────────────────────────────────────────────────────────────────────
  const zzBefore = await prisma.group.findUnique({ where: { id: ZZ }, select: { trial_ends_at: true, country_code: true } });
  const start = new Date(Date.now() + 20 * 86_400_000);
  await prisma.group.update({ where: { id: ZZ }, data: { trial_ends_at: start } });
  const op = await prisma.operator.create({
    data: { email: OP_EMAIL, name: 'Trial Control Gate', role: 'support', status: 'active',
      regions: [zzBefore?.country_code ?? 'GB'], passwordHash: await bcrypt.hash(OP_PASS, 10) },
    select: { id: true },
  });
  fix = { opId: op.id, zzTrialBefore: zzBefore?.trial_ends_at ?? null, start };

  const ready = await serverReady();
  check('the dev server serves pages before we drive it', ready.ok, `HTTP ${ready.status} after ${ready.attempts} attempt(s)`);
  // THE HOST RULE IS WHAT MAKES THE ENGINE ROOM REACHABLE. Without it middleware 404s every
  // /superadmin path on localhost and this whole section would test a Not Found page.
  browser = await chromium.launch({ channel: 'chrome', args: ['--host-resolver-rules=MAP er.greasedesk.com 127.0.0.1'] });
  // A VIEWPORT THAT FITS THE PAGE. The tenant detail runs to ~1700px and the control sits near the
  // bottom, so at the default 720 the click was resolving an element outside the viewport and
  // timing out on actionability — a failure about scroll position, not about the control.
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 2200 } })).newPage();

  console.log('\n— signed in as an operator, on the real host —');
  await page.goto(`${ER}/superadmin/login`, { waitUntil: 'domcontentloaded' });
  const loginBody = await page.evaluate(() => document.body.innerText);
  check('the Engine Room is reachable at its own host', !/Not Found/.test(loginBody) && loginBody.length > 40,
    loginBody.slice(0, 70).replace(/\s+/g, ' '));
  await page.fill('input[type="email"]', OP_EMAIL);
  await page.fill('input[type="password"]', OP_PASS);
  await page.click('button[type="submit"]');
  // SETTLE FIRST. next-auth redirects on its own after the credential POST, and racing it with a
  // goto aborts the navigation — ERR_ABORTED, which reads like the page is broken when it is not.
  await page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(800);
  check('the operator is signed in', !/\/login/.test(new URL(page.url()).pathname), page.url());
  await page.goto(`${ER}/superadmin/tenants/${ZZ}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="er-trial-extend"]', { timeout: 30000 }).catch(() => {});
  check('a support operator sees the tenant and the control',
    (await page.locator('[data-testid="er-trial-extend"]').count()) === 1,
    'the role the schema declares this capability on');

  // ── 4. THE PANEL ─────────────────────────────────────────────────────────────────────────────
  console.log('\n— the panel, not three dialogs —');
  const opened = (await page.locator('[data-testid="er-trial-extend"]').count()) === 1;
  if (opened) {
    // SCROLLED FIRST. The control sits far down a long tenant page, and a click on an off-screen
    // element tests the scroll position rather than the control.
    await page.locator('[data-testid="er-trial-extend"]').scrollIntoViewIfNeeded();
    clickErr = await page.locator('[data-testid="er-trial-extend"]').click({ timeout: 15000 }).then(() => null, (e) => describeError(e).replace(/\s+/g, ' ').slice(0, 700));
    await page.waitForTimeout(800);
  }
  check('the Extend button accepted the click', clickErr === null, clickErr ?? 'clicked');
  const fields = ['er-trial-date', 'er-trial-category', 'er-trial-note', 'er-trial-save'];
  const absent = [];
  for (const f of fields) if ((await page.locator(`[data-testid="${f}"]`).count()) !== 1) absent.push(f);
  check('it has a date, a category, a note and a save', absent.length === 0, absent.join(', ') || '4 of 4');

  // STRIPE'S FLOOR MADE UNREACHABLE RATHER THAN EXPLAINED AFTER THE FACT.
  const min = opened ? await page.locator('[data-testid="er-trial-date"]').getAttribute('min') : null;
  const expectMin = ymd(new Date(Date.now() + 48 * 3600_000));
  check('the date cannot be set inside Stripe’s 48 hours', min === expectMin, `min=${min} expected=${expectMin}`);
  // THE PRE-FILL THAT BROKE IT: the current end meant pressing OK was a reduction.
  const preset = opened ? await page.locator('[data-testid="er-trial-date"]').inputValue() : null;
  check('  …and is not pre-filled with the current end', preset !== ymd(start),
    `${preset} — the stored end is ${ymd(start)}`);
  check('  …but with a month further on', preset === ymd(new Date(start.getTime() + 30 * 86_400_000)),
    `${preset} — the default gesture should extend, not refuse`);

  const cats = opened ? await page.locator('[data-testid="er-trial-category"] option').allTextContents() : [];
  check('the category is chosen, never typed', cats.length === X.TRIAL_EXTENSION_CATEGORIES?.length,
    `${cats.length} options — "Sales" with a capital was a 400`);

  // ── 5. THE PREVIEW AND THE LIVE VALIDATION ───────────────────────────────────────────────────
  const target = new Date(start.getTime() + 30 * 86_400_000);
  if (opened) {
    await page.locator('[data-testid="er-trial-date"]').fill(ymd(target));
    await page.locator('[data-testid="er-trial-note"]').fill('x');
    await page.waitForTimeout(300);
  }
  check('save is refused while the note is a placeholder',
    opened && (await page.locator('[data-testid="er-trial-save"]').isDisabled()),
    'the same MIN_REASON_LENGTH rule a void reason follows');
  // THE PREVIEW DOUBLES AS THE VALIDATION MESSAGE, so it must be read with a VALID note — reading it
  // while the note is still a placeholder asserts against "Give a bit more detail", which is the
  // panel working. The gate was wrong about when to look, not the panel about what to say.
  if (opened) {
    await page.locator('[data-testid="er-trial-note"]').fill('Agreed another month while they import their old system');
    await page.waitForTimeout(300);
  }
  const preview = opened ? await page.locator('[data-testid="er-trial-preview"]').innerText().catch(() => '') : '';
  const monthName = target.toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' });
  check('the preview names the delta AND the date',
    /Extends by 30 days/.test(preview) && new RegExp(monthName).test(preview),
    preview || '(no preview)');
  check('  …so a wrong year would be visible before pressing',
    new RegExp(String(target.getUTCFullYear())).test(preview), preview || '(no preview)');

  // ── 6. IT ACTUALLY EXTENDS, AND SAYS SO INLINE ───────────────────────────────────────────────
  console.log('\n— and pressing it extends the trial —');
  if (opened) {
    await page.locator('[data-testid="er-trial-save"]').scrollIntoViewIfNeeded();
    await page.locator('[data-testid="er-trial-save"]').click({ timeout: 15000 });
    await page.waitForTimeout(3000);
  }
  const after = await prisma.group.findUnique({ where: { id: ZZ }, select: { trial_ends_at: true } });
  check('the trial moved', ymd(after?.trial_ends_at ?? new Date(0)) === ymd(target),
    `${after?.trial_ends_at?.toISOString()} — expected ${ymd(target)}`);
  const sa = await prisma.superAdminAudit.findFirst({ where: { target_group_id: ZZ, action: 'tenant.trial_extended' },
    orderBy: { created_at: 'desc' }, select: { reason: true, detail: true } });
  check('  …the operator ledger recorded it', !!sa, JSON.stringify(sa?.detail ?? null).slice(0, 150));
  check('  …with the delta and no subscription', (sa?.detail)?.deltaDays === 30 && (sa?.detail)?.hadSubscription === false,
    JSON.stringify(sa?.detail ?? null).slice(0, 150));
  const tenantRow = await prisma.auditLog.findFirst({ where: { group_id: ZZ, action: 'billing.trial_extended' },
    orderBy: { created_at: 'desc' }, select: { user_id: true, entity: true } });
  check('  …and so did the tenant’s own', !!tenantRow && tenantRow.user_id === null && tenantRow.entity === 'group',
    JSON.stringify(tenantRow));
  // INLINE, NOT alert(). An alert is the same modal Chrome offers to suppress.
  const result = opened ? await page.locator('[data-testid="er-trial-result"]').innerText().catch(() => '') : '';
  check('the result is on the page, not in a dialog', /extended/i.test(result), result.slice(0, 140) || '(no inline result)');
  check('  …naming the local branch, since ZZ has no subscription', /only|no subscription/i.test(result),
    result.slice(0, 160) || '(no inline result)');
} catch (e) {
  check('gate run completed', false, describeError(e).slice(0, 300));
  await explainIfClientStale('http://localhost:3000');
} finally {
  if (browser) await browser.close().catch(() => {});
  if (fix) {
    const step = async (n, fn) => { try { await fn(); } catch (e) { console.log(`  teardown ${n}: ${describeError(e).slice(0, 90)}`); } };
    // RESTORED, not blanked: ZZ's column had a value (or a null) before this run and must end with it.
    await step('zz trial', () => prisma.group.update({ where: { id: ZZ }, data: { trial_ends_at: fix.zzTrialBefore } }));
    await step('operator', () => prisma.operator.deleteMany({ where: { id: fix.opId } }));
    // AuditLog and SuperAdminAudit rows are NEVER deleted — the extension really happened.
    const opsLeft = await prisma.operator.count({ where: { email: OP_EMAIL } });
    const zzNow = await prisma.group.findUnique({ where: { id: ZZ }, select: { trial_ends_at: true } });
    check('teardown removed the operator and restored ZZ',
      opsLeft === 0 && String(zzNow?.trial_ends_at ?? null) === String(fix.zzTrialBefore ?? null),
      `operators left ${opsLeft}, zz trial ${String(zzNow?.trial_ends_at)}`);
  }
}

console.log(`\n${out.filter((x) => x === 'F').length} failures of ${out.length}`);
await prisma.$disconnect();
process.exit(out.includes('F') ? 1 : 0);
