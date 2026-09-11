/**
 * File: scripts/demo-refresh-guard-gate.mjs
 * A DEMO REFRESH REFUSES WHILE SOMEONE HAS BEEN USING THE DEMO — AND NEVER CLAIMS NOBODY IS THERE.
 * @gate-requires: server, db
 *
 * Demo tenants have real people in them now (owner, 2026-09-11). scripts/demo-refresh.mjs deletes the
 * whole tenant; this proves the stop in front of it (lib/demo-tenants::refuseRefreshWhileActive).
 *
 * ── WHAT THIS NEVER DOES ────────────────────────────────────────────────────────────────────────
 * Run the refresh with --apply. A broken guard would then delete Kingsford — the demo prospects are
 * using. So the REFUSAL is proved on the pure rule and by reading both checkpoints in the script; the
 * one live run is a DRY run, which reports the check and stops before generating anything.
 * It also never writes an AuditLog row (append-only, so a fixture one could never be removed).
 *
 * ── THE BLIND SPOT IS PART OF THE CONTRACT ──────────────────────────────────────────────────────
 * Someone who signed in over an hour ago and is only reading leaves no trace — the most likely
 * prospect. Every report, pass, refusal or override, says so; a pass reads "no traces", never "nobody".
 */
import './_gate-preflight.mjs';
import './_ts.mjs';
const { gatePrisma, describeError, gateOrigin, ZZ_GROUP } = await import('./_gate-preflight.mjs');
const { execFileSync } = await import('node:child_process');
const { readFileSync } = await import('node:fs');
const { randomUUID } = await import('node:crypto');
const D = await import('../lib/demo-tenants.ts');
const A = await import('../lib/demo-activity.ts');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const code = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const prisma = await gatePrisma();
const ZZ = ZZ_GROUP;
const MARK = '@demo-refresh-guard-gate.invalid';
const made = { customers: [], logs: [] };

await prisma.notificationLog.deleteMany({ where: { recipient: { endsWith: MARK } } });
await prisma.customer.deleteMany({ where: { group_id: ZZ, email: { endsWith: MARK } } });

try {
  const now = new Date();
  const min = (n) => new Date(now.getTime() - n * 60_000);
  const quiet = { lastSignIn: null, personChanges: 0, latestPersonChange: null, messagesByPeople: 0, latestMessage: null, newRecords: 0, latestNewRecord: null };
  const blind = D.ACTIVITY_BLIND_SPOT;

  // ── 1. THE RULE ────────────────────────────────────────────────────────────────────────────────
  console.log('\n— the rule —');
  const pass = D.refuseRefreshWhileActive('GB-GD9999', quiet, now, false);
  check('with no traces it passes', !pass.refuse && !pass.overridden);
  check('  …and says NO TRACES — never that nobody is there', /^No traces of anyone on GB-GD9999 in the last 60 minutes\./.test(pass.report) && pass.report.includes(blind),
    'the most likely prospect — signed in earlier, only reading — leaves no trace at all');
  check('the blind-spot sentence names who it cannot see', /signed in more than an hour ago and is only reading/.test(blind) && /NO TRACES in the last hour, not that nobody is there/.test(blind));
  const kinds = {
    'a sign-in 10 minutes ago': { ...quiet, lastSignIn: min(10) },
    'a change by a person': { ...quiet, personChanges: 2, latestPersonChange: min(5) },
    'a message a person sent': { ...quiet, messagesByPeople: 1, latestMessage: min(30) },
    'a new customer, card or booking': { ...quiet, newRecords: 1, latestNewRecord: min(45) },
  };
  for (const [what, a] of Object.entries(kinds)) {
    const r = D.refuseRefreshWhileActive('GB-GD9999', a, now, false);
    check(`${what} alone REFUSES`, r.refuse && /Someone has been using GB-GD9999/.test(r.report) && /--even-if-active/.test(r.report) && r.report.includes(blind), r.report.slice(0, 90));
  }
  const stale = D.refuseRefreshWhileActive('GB-GD9999', { ...quiet, lastSignIn: min(61) }, now, false);
  check('a sign-in 61 minutes ago is outside the window — and the pass STILL names the blind spot', !stale.refuse && stale.report.includes(blind),
    'that person may well still be there, reading; the report says it cannot tell');
  const forced = D.refuseRefreshWhileActive('GB-GD9999', kinds['a sign-in 10 minutes ago'], now, true);
  check('--even-if-active overrides, and SAYS what it is overriding', !forced.refuse && forced.overridden && /OVERRIDDEN with --even-if-active/.test(forced.report) && /deleted/.test(forced.report) && forced.report.includes(blind));
  check('a report names no person — only what was seen and when', !/@|owner|Dana/i.test(D.refuseRefreshWhileActive('GB-GD9999', kinds['a change by a person'], now, false).report),
    'the activity it reads carries counts and times, never who');

  // ── 2. THE READ, ON REAL ROWS ──────────────────────────────────────────────────────────────────
  console.log('\n— the read sees a person\'s traces on a real tenant —');
  const zzOwner = await prisma.user.findFirst({ where: { group_id: ZZ, email: 'owner@zzgategarage.test' }, select: { id: true } });
  // A SIGN-IN — the prospect signal, made the way a prospect makes it: the credentials form.
  const B = gateOrigin();
  const csrfRes = await fetch(`${B}/api/auth/csrf`);
  const csrfToken = (await csrfRes.json()).csrfToken;
  const csrfCookie = (csrfRes.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  await fetch(`${B}/api/auth/callback/credentials`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', cookie: csrfCookie },
    body: new URLSearchParams({ email: 'owner@zzgategarage.test', password: 'GateGarage!2026', csrfToken, json: 'true' }) });
  const c = await prisma.customer.create({ data: { group_id: ZZ, name: 'Guard trace', email: `trace-${randomUUID().slice(0, 8)}${MARK}` }, select: { id: true } });
  made.customers.push(c.id);
  const msg = await prisma.notificationLog.create({ data: { group_id: ZZ, scope: 'tenant', channel: 'email', template: 'free_text', provider: 'none', status: 'skipped', recipient: `trace${MARK}`, sent_by_user: zzOwner.id }, select: { id: true } });
  made.logs.push(msg.id);
  const seen = await A.tenantActivity(prisma, ZZ, new Date());
  check('it sees the sign-in just made through the credentials form', !!seen.lastSignIn && Date.now() - seen.lastSignIn.getTime() < 5 * 60_000,
    seen.lastSignIn ? `${Math.round((Date.now() - seen.lastSignIn.getTime()) / 1000)}s ago` : 'no sign-in seen');
  check('  …the new record', seen.newRecords >= 1 && !!seen.latestNewRecord);
  check('  …and the message a person sent', seen.messagesByPeople >= 1 && !!seen.latestMessage);
  check('and those traces REFUSE a refresh of that tenant', D.refuseRefreshWhileActive('ZZ', seen, new Date(), false).refuse);
  const longAgo = await A.tenantActivity(prisma, ZZ, new Date('2016-01-01T00:00:00Z'));
  check('the window is the last hour only — the same tenant a decade ago shows nothing', !longAgo.lastSignIn && longAgo.personChanges === 0 && longAgo.newRecords === 0 && longAgo.messagesByPeople === 0,
    'the discriminator: the read is bounded by the window, not by the tenant');

  // ── 3. BOTH CHECKPOINTS, AND THE OVERRIDE, IN THE SCRIPT ───────────────────────────────────────
  console.log('\n— the refresh asks before generating AND again at the swap —');
  const s = code(readFileSync('scripts/demo-refresh.mjs', 'utf8'));
  const first = s.indexOf('const firstLook = refuseRefreshWhileActive(');
  // THE REFRESH'S OWN generation call. `generateDemoTenant(` also appears in the --create branch at the
  // top of the file, which the first version found and compared against — a search term that was not
  // unique to its subject.
  const generate = s.indexOf('fresh = await generateDemoTenant(');
  const swapCheck = s.indexOf('const atSwap = refuseRefreshWhileActive(');
  const swap = s.indexOf("await tx.group.update({ where: { id: target.id }, data: { ref: supersededRef } });");
  const purge = s.indexOf("await purgeTenant('demo-refresh', target.id);");
  check('it checks BEFORE the 27 minutes of generation, and an --apply refusal exits there', first > 0 && generate > first
    && /if \(firstLook\.refuse && APPLY\) \{[\s\S]{0,300}?process\.exit\(2\);/.test(s), `check @${first}, generation @${generate}`);
  check('  …and AGAIN at the swap, before any identity moves — where a live session breaks', swapCheck > generate && swap > swapCheck && purge > swap
    && /if \(atSwap\.refuse\) \{[\s\S]{0,400}?process\.exit\(2\);/.test(s), `swap check @${swapCheck}, swap @${swap}, purge @${purge}`);
  check('the override is its own flag, never implied by --apply', /const EVEN_IF_ACTIVE = process\.argv\.includes\('--even-if-active'\);/.test(s)
    // Whole lines, counted: `[^)]*` stopped at the nested tenantActivity(...) call's own paren.
    && (s.match(/= refuseRefreshWhileActive\(target\.ref, await tenantActivity\(prisma, target\.id\), new Date\(\), EVEN_IF_ACTIVE\);/g) ?? []).length === 2);

  // ── 4. THE ONE LIVE RUN: A DRY RUN AGAINST THE DEMO PROSPECTS USE ──────────────────────────────
  console.log('\n— a dry run reports the check on the real demo, and destroys nothing —');
  const kingsford = await prisma.group.findUnique({ where: { ref: 'GB-GD2369' }, select: { id: true } });
  const cardsBefore = kingsford ? await prisma.jobCard.count({ where: { group_id: kingsford.id } }) : null;
  let dry = '';
  try { dry = execFileSync('node', ['scripts/demo-refresh.mjs', '--group=GB-GD2369'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GATE_ALLOW_PIPE: '1' } }); }
  catch (e) { dry = String(e.stdout ?? '') + String(e.stderr ?? ''); }
  check('the dry run reports the activity check — and its blind spot — on Kingsford', /DRY RUN/.test(dry) && dry.includes(blind) && /(No traces of anyone on GB-GD2369|WOULD REFUSE with --apply: Someone has been using GB-GD2369)/.test(dry),
    (dry.match(/(No traces[^.]*\.|WOULD REFUSE[^.]*\.)/) ?? ['(no activity line)'])[0]);
  check('  …and destroyed nothing', kingsford && (await prisma.jobCard.count({ where: { group_id: kingsford.id } })) === cardsBefore && /Nothing generated, nothing swapped, nothing destroyed/.test(dry),
    `${cardsBefore} job cards before and after`);
} catch (e) {
  check('gate run completed', false, describeError(e));
} finally {
  try {
    if (made.logs.length) await prisma.notificationLog.deleteMany({ where: { id: { in: made.logs } } });
    if (made.customers.length) await prisma.customer.deleteMany({ where: { id: { in: made.customers } } });
    check('teardown removed its traces', (await prisma.customer.count({ where: { id: { in: made.customers } } })) === 0);
  } catch (e) { check('teardown completed', false, describeError(e)); }
  await prisma.$disconnect();
}
console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
process.exit(out.includes('F') ? 1 : 0);
