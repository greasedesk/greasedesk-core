/**
 * File: scripts/notify-scope-gate.mjs
 * A send must SAY whose it is. A forgotten tenant is refused; a platform send is declared.
 *
 * ── WHAT THIS IS ACTUALLY GUARDING ──────────────────────────────────────────────────────────────
 * Not the label on a NotificationLog row. THREE tenant-scoped guards inside sendNotification read
 * the tenant's truthiness and fail OPEN without one:
 *
 *   demoSendDecision — a demo tenant's invented customers stop being blocked. Measured, not
 *                      hypothetical: a demo's phone_verify reached Twilio and came back 21211.
 *   isSuppressed     — no opt-out list is consulted, so SOMEONE WHO ASKED NOT TO BE CONTACTED IS
 *                      CONTACTED. That is a consent failure, not a reporting one.
 *   smsAllowance     — the allowance is not checked.
 *
 * All three are CORRECT for a real platform send and wrong for a forgotten one, so the fix is not
 * to change the guards — it is to stop inferring "platform" from absence.
 *
 * ── WHY A RUNTIME REFUSAL AND NOT JUST THE TYPE ─────────────────────────────────────────────────
 * `groupId` is now required in SendNotificationArgs, and that IS enforced (proven by removing it
 * from a caller: TS2345). But nearly every caller sources it from `session.user as any`, so
 * `groupId: user.group_id as string` type-checks with a runtime `undefined` — the same `any` that
 * let a forgotten `select` store a null site on every counter payment. The type catches a missing
 * KEY; only the runtime check catches a missing VALUE. Both halves are asserted below.
 *
 * ── FIXTURES ────────────────────────────────────────────────────────────────────────────────────
 * ZZ only, and no demo tenant is touched (the reference demo is under a hold). The opt-out flag on
 * one ZZ customer is CAPTURED AND RESTORED, and every NotificationLog row written here is removed.
 */
import './_gate-preflight.mjs';
import './_ts.mjs';
const { prisma } = await import('../lib/db.ts');
const { sendNotification, PLATFORM_SEND, NotifyScopeError } = await import('../lib/notify.ts');
const { readFileSync } = await import('node:fs');

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };

const madeRows = [];
let custId = null, custRestore = null;
const rowsNow = async () => (await prisma.$queryRawUnsafe('SELECT count(*)::int AS n FROM "NotificationLog"'))[0].n;

try {
  // ── 1. THE TYPE SAYS IT IS REQUIRED ────────────────────────────────────────────────────────
  console.log('\n— the declaration —');
  const src = readFileSync('lib/notify.ts', 'utf8');
  check('groupId is REQUIRED and admits the platform sentinel',
    /groupId:\s*string\s*\|\s*typeof PLATFORM_SEND;/.test(src),
    'no `?` — an omitted key is a TS2345, proven by deleting it from pages/api/invoice-sms.ts');
  check('PLATFORM_SEND is a REGISTERED symbol', Symbol.keyFor(PLATFORM_SEND) === 'greasedesk.notify.platform-send',
    'Symbol.for, because Next can evaluate a module twice and two private symbols would not compare equal');
  // The guards must read the RESOLVED scope, not the raw argument — otherwise the sentinel leaks
  // into a query as a symbol and the whole exercise is decorative.
  check('the three guards read the resolved scope, not args.groupId',
    /demoSendDecision\(groupId,/.test(src) && /isSuppressed\(groupId,/.test(src) && /smsAllowance\(prisma, groupId\)/.test(src));

  // ── 2. A FALSY SCOPE IS REFUSED, AND NOTHING IS RECORDED ───────────────────────────────────
  console.log('\n— a forgotten tenant —');
  for (const [label, value] of [['undefined', undefined], ['null', null], ['empty string', '']]) {
    const before = await rowsNow();
    let err = null;
    try {
      await sendNotification({ groupId: value, channel: 'sms', template: 'invoice_pay_link', recipient: '+447700900123' });
    } catch (e) { err = e; }
    check(`${label} THROWS NotifyScopeError`, err instanceof NotifyScopeError && err.code === 'notify_no_scope',
      err ? `${err.name}/${err.code ?? '—'}` : 'NO THROW — the send proceeded without a tenant');
    // Refused, not recorded: recording would write the very null this exists to prevent.
    check(`${label} wrote NO NotificationLog row`, (await rowsNow()) === before);
  }
  check('the message names the fix', new NotifyScopeError('x').message.includes('PLATFORM_SEND'),
    'the person who hits this must learn the alternative from the error, not from a memory file');

  // ── 3. A DECLARED PLATFORM SEND IS ALLOWED, AND SAYS SO ────────────────────────────────────
  console.log('\n— a declared platform send —');
  const r = await sendNotification({
    groupId: PLATFORM_SEND, channel: 'sms', template: 'invoice_pay_link', recipient: '+447700900124',
  });
  check('it does not throw', !!r && typeof r.ok === 'boolean', JSON.stringify(r?.skipCode ?? r?.status));
  const row = r.notificationId
    ? await prisma.notificationLog.findUnique({ where: { id: r.notificationId }, select: { id: true, group_id: true } })
    : null;
  if (row) madeRows.push(row.id);
  check('and the row records NO tenant', !!row && row.group_id === null,
    'null here is now DECLARED, never inferred — the only way to produce one is to say PLATFORM_SEND');

  // ── 4. REGRESSION: THE CONSENT GUARD STILL READS THE TENANT ────────────────────────────────
  // The point of the refactor is that this must be unchanged. If resolving the scope had broken
  // suppression, the fix would have caused the exact failure it was written to prevent.
  console.log('\n— the opt-out check still bites —');
  const cust = await prisma.customer.findFirst({
    where: { group_id: ZZ, OR: [{ phone_e164: { not: null } }, { phone: { not: null } }] },
    select: { id: true, phone_e164: true, phone: true, sms_opt_out: true },
  });
  if (!cust) throw new Error('no ZZ customer with a phone to work against');
  custId = cust.id; custRestore = cust.sms_opt_out;
  const to = cust.phone_e164 ?? cust.phone;

  await prisma.customer.update({ where: { id: custId }, data: { sms_opt_out: true } });
  const refused = await sendNotification({ groupId: ZZ, channel: 'sms', template: 'invoice_pay_link', recipient: to });
  if (refused.notificationId) madeRows.push(refused.notificationId);
  check('the template resolves at all', refused.skipCode !== 'unknown_template',
    'asserted separately so a bad fixture key cannot masquerade as a passing discriminator below');
  check('an opted-out ZZ customer is SUPPRESSED', refused.suppressed === true && refused.skipCode === 'opted_out',
    `${refused.status}/${refused.skipCode ?? '—'}`);

  // Discriminating: without the opt-out, the same send is NOT suppressed — so the check above is
  // reading the flag, not simply failing for some other reason further down the path.
  await prisma.customer.update({ where: { id: custId }, data: { sms_opt_out: false } });
  const allowed = await sendNotification({ groupId: ZZ, channel: 'sms', template: 'invoice_pay_link', recipient: to });
  if (allowed.notificationId) madeRows.push(allowed.notificationId);
  // VACUITY GUARD. The first run of this gate used a template key that does not exist, so the send
  // died at `unknown_template` BEFORE the opt-out check — and this discriminator passed anyway,
  // because 'unknown_template' !== 'opted_out'. A discriminator that a broken fixture satisfies is
  // not a discriminator. So: it must have got PAST template resolution to mean anything.
  check('the check is discriminating — without the flag it is NOT suppressed',
    allowed.skipCode !== 'opted_out' && allowed.suppressed !== true && allowed.skipCode !== 'unknown_template',
    `${allowed.status}/${allowed.skipCode ?? '—'}`);

  // And THE defect this whole slice exists to close: the same opted-out recipient, sent with no
  // tenant, must not slip past the opt-out. It is refused before it can.
  let leaked = null;
  try {
    await sendNotification({ groupId: undefined, channel: 'sms', template: 'invoice_pay_link', recipient: to });
    leaked = 'THE SEND PROCEEDED';
  } catch (e) { leaked = e instanceof NotifyScopeError ? null : `wrong error: ${e?.name}`; }
  check('a tenant-less send to that same recipient cannot bypass the opt-out', leaked === null,
    leaked ?? 'refused at the scope, before isSuppressed is ever consulted');
} catch (e) {
  check('run completed', false, String(e?.message ?? e).slice(0, 300));
} finally {
  if (custId !== null) {
    await prisma.customer.update({ where: { id: custId }, data: { sms_opt_out: custRestore } });
    const now = (await prisma.customer.findUnique({ where: { id: custId }, select: { sms_opt_out: true } })).sms_opt_out;
    check('teardown restored the opt-out flag exactly', now === custRestore, `${JSON.stringify(custRestore)} → ${JSON.stringify(now)}`);
  }
  if (madeRows.length) {
    const d = await prisma.notificationLog.deleteMany({ where: { id: { in: madeRows } } });
    check('teardown removed the fixture notification rows', d.count === madeRows.length, `${d.count} of ${madeRows.length}`);
  }
  // The platform row is the one that must not be left behind: a stray null group_id here would be
  // indistinguishable from the defect, which is the whole point of the slice.
  check('no fixture row survives', (await prisma.notificationLog.count({ where: { id: { in: madeRows } } })) === 0);
  console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
  await prisma.$disconnect();
  process.exit(out.includes('F') ? 1 : 0);
}
