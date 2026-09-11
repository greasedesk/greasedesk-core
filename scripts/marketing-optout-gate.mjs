/**
 * File: scripts/marketing-optout-gate.mjs
 * "NO REMINDERS OR OFFERS" STOPS REMINDERS AND OFFERS — AND NEVER A QUOTE OR AN INVOICE.
 * @gate-requires: server, db
 *
 * Step 3 of the tenant unsubscribe (owner decision B). The marketing opt-out now reaches the send
 * path, the marketing board, the MOT list and the send preview.
 *
 * ── THE CLAUSE THAT MATTERS ─────────────────────────────────────────────────────────────────────
 * A customer who opts out of marketing STILL RECEIVES quotes and invoices. That positive case is
 * asserted in the SAME RUN as every refusal, against the same customer: a send path that refused
 * EVERYTHING would pass every refusal clause here, and only the positive case tells them apart.
 *
 * ── HOW A SEND IS SEEN WITHOUT BEING MADE ───────────────────────────────────────────────────────
 * This process has no email or SMS provider (it refuses to run if one is configured). So an ALLOWED
 * send gets past every preference check and stops at `not_configured`; a REFUSED one stops earlier,
 * with its OWN code. Which code comes back says which check stopped it — the prospect-gate device.
 *
 * ── EVERY REMOVAL NAMES ITS DESTINATION ─────────────────────────────────────────────────────────
 * A refused reminder is not "gone": it lands as a `skipped` NotificationLog row saying why. A car
 * whose owner refused offers does not leave the board: it stays, with the text and email offers
 * withdrawn, the phone number shown, and a label saying which refusal. Each is asserted where it lands.
 *
 * Fixtures on ZZ, marked by the address domain @marketing-optout-gate.invalid and the vehicle make
 * MktOptGate; swept first if a killed run left them, with one planted so the sweep is proved.
 */
import './_gate-preflight.mjs';
import './_ts.mjs';
// BEFORE ANY NOTIFY CODE LOADS: no email provider in this process, whatever .env says.
process.env.RESEND_API_KEY = '';
const { gatePrisma, describeError, declineToRun, gateOrigin, zzSite, ZZ_GROUP } = await import('./_gate-preflight.mjs');
const { randomUUID } = await import('node:crypto');
const { readFileSync } = await import('node:fs');
const R = await import('../lib/contact-preference-rules.ts');
const CP = await import('../lib/contact-preferences.ts');
const N = await import('../lib/notify.ts');
const T = await import('../lib/notification-templates.ts');
const O = await import('../lib/send-outcome.ts');
const M = await import('../lib/marketing-lists.ts');
const BOARD = await import('../lib/marketing-board.ts');
const DATA = await import('../lib/marketing-data.ts');
if (N.channelConfigured('email') || N.channelConfigured('sms')) declineToRun('a message provider is configured in this process — refusing to run a gate that sends to fixtures');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const code = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const prisma = await gatePrisma();
const ZZ = ZZ_GROUP;
const MARK = '@marketing-optout-gate.invalid';
const MAKE = 'MktOptGate';
const made = { customers: [], vehicles: [], logs: [] };
const uniq = () => randomUUID().slice(0, 8);
const day = (n) => new Date(Date.now() + n * 86_400_000);

// ── 0. A KILLED RUN'S LEFTOVERS FIRST, AND ONE PLANTED ─────────────────────────────────────────────
{
  const planted = await prisma.customer.create({ data: { group_id: ZZ, name: 'Planted leftover', email: `planted-${uniq()}${MARK}` }, select: { id: true } });
  await prisma.vehicle.deleteMany({ where: { group_id: ZZ, make: MAKE } });
  await prisma.notificationLog.deleteMany({ where: { group_id: ZZ, OR: [{ recipient: { endsWith: MARK } }, { recipient: { startsWith: '4477007' } }] } });
  await prisma.customer.deleteMany({ where: { group_id: ZZ, email: { endsWith: MARK } } });
  check('a killed run\'s fixtures are swept first', (await prisma.customer.count({ where: { OR: [{ id: planted.id }, { group_id: ZZ, email: { endsWith: MARK } }] } })) === 0);
}

try {
  const zzOwner = await prisma.user.findFirst({ where: { group_id: ZZ, email: 'owner@zzgategarage.test' }, select: { id: true } });
  const site = await zzSite(prisma);
  const mobile = `4477007${String(Math.floor(Math.random() * 1e5)).padStart(5, '0')}`;
  const email = `optout-${uniq()}${MARK}`;
  check('the fixture addresses belong to nobody else', (await prisma.customer.count({ where: { OR: [{ phone_e164: mobile }, { phone: mobile }, { email }] } })) === 0);
  const cust = (await prisma.customer.create({ data: { group_id: ZZ, name: 'Dana Optout', email, phone: mobile, phone_e164: mobile }, select: { id: true } })).id;
  made.customers.push(cust);
  const veh = (await prisma.vehicle.create({ data: { group_id: ZZ, registration: `MO${uniq().toUpperCase().slice(0, 5)}`, make: MAKE, model: 'Fixture', mot_expiry: day(9) }, select: { id: true } })).id;
  made.vehicles.push(veh);
  await prisma.vehicleOwnership.create({ data: { vehicle_id: veh, customer_id: cust, is_current: true } });

  const send = async (template, channel, recipient) => {
    const r = await N.sendNotification({ groupId: ZZ, template, channel, recipient, data: {
      garageName: 'ZZ Gate Garage', garagePhone: '01384 000000', customerName: 'Dana', registration: 'MO12 GTE', vehicleDesc: 'Fixture',
      expiryDate: '20 September 2026', link: 'https://greasedesk.com/c/x', total: '£100.00', expiryDays: 14 } });
    if (r.notificationId) made.logs.push(r.notificationId);
    return r;
  };
  const reachedProvider = (r) => r.skipCode === 'not_configured';
  const setPref = async (channel, scope, optedOut, reason) => {
    const r = await CP.recordContactPreference({ groupId: ZZ, customerId: cust, channel, scope, optedOut, via: 'staff', actorUserId: zzOwner.id, reason }, prisma);
    if (!r.ok) throw new Error(`the writer refused the fixture preference: ${r.refusal}`);
  };

  // ── 1. BEFORE: THE SAME CUSTOMER IS REACHABLE ─────────────────────────────────────────────────
  console.log('\n— before: every route is open —');
  const before = await Promise.all([send('mot_due', 'email', email), send('mot_due', 'sms', mobile)]);
  check('an MOT reminder reaches the provider stage on both channels', before.every(reachedProvider),
    before.map((r) => r.skipCode).join(' / ') + ' — so a refusal below is the preference, not a broken fixture or template');
  const boardRow = async () => { const b = await BOARD.buildBoard(ZZ, new Date()); return [...b.hot, ...b.warm, ...b.later].find((r) => r.vehicleId === veh) ?? null; };
  const rowBefore = await boardRow();
  check('the car is on the board, offering a text and an email', !!rowBefore && rowBefore.canSms === true && rowBefore.canEmail === true && rowBefore.noContact === null,
    rowBefore ? `canSms ${rowBefore.canSms}, canEmail ${rowBefore.canEmail}` : 'NOT ON THE BOARD — the clauses below would prove nothing');

  // ── 2. "NO REMINDERS OR OFFERS", ON BOTH CHANNELS ─────────────────────────────────────────────
  await setPref('email', 'marketing', true);
  await setPref('sms', 'marketing', true);
  console.log('\n— after "no reminders or offers": reminders are refused —');
  const refusedEmail = await send('mot_due', 'email', email);
  const refusedSms = await send('mot_due', 'sms', mobile);
  const refusedExpired = await send('mot_expired', 'email', email);
  check('an MOT reminder by email is REFUSED, as a marketing opt-out', refusedEmail.skipCode === 'opted_out_marketing' && refusedEmail.suppressed === true, `${refusedEmail.status}/${refusedEmail.skipCode}`);
  check('  …and by text', refusedSms.skipCode === 'opted_out_marketing', `${refusedSms.status}/${refusedSms.skipCode}`);
  check('  …and the EXPIRED reminder too — both reminder templates are marketing', refusedExpired.skipCode === 'opted_out_marketing', `${refusedExpired.skipCode}`);
  const refusedRows = await prisma.notificationLog.findMany({ where: { id: { in: [refusedEmail.notificationId, refusedSms.notificationId].filter(Boolean) } }, select: { status: true, error: true } });
  check('  …and each refusal LANDS in the message record, saying why', refusedRows.length === 2 && refusedRows.every((r) => r.status === 'skipped' && /no reminders or offers/.test(r.error ?? '')),
    refusedRows.map((r) => `${r.status}: ${r.error}`).join(' | ') || 'no rows — a refusal that vanished');

  // ── 3. THE CLAUSE THAT MATTERS, IN THE SAME RUN, ON THE SAME CUSTOMER ─────────────────────────
  console.log('\n— and in the SAME run, to the SAME customer: quotes and invoices still go —');
  const service = await Promise.all([
    send('quote_ready', 'email', email), send('invoice_document', 'email', email),
    send('quote_ready', 'sms', mobile), send('invoice_pay_link', 'sms', mobile),
  ]);
  const names = ['quote by email', 'invoice by email', 'quote by text', 'pay link by text'];
  check('a QUOTE and an INVOICE still reach this customer, by email and by text', service.every(reachedProvider),
    service.map((r, i) => `${names[i]}: ${r.skipCode ?? r.status}`).join(', '));
  check('  …none of them was refused as marketing', service.every((r) => r.skipCode !== 'opted_out_marketing' && r.skipCode !== 'opted_out'),
    'the promise decision B made: a marketing opt-out never stops a quote or an invoice');

  // ── 4. "NOTHING AT ALL" STILL MEANS NOTHING AT ALL ────────────────────────────────────────────
  console.log('\n— "no email at all" still refuses everything on that channel —');
  await setPref('email', 'all', true);
  const quoteNoEmail = await send('quote_ready', 'email', email);
  const reminderNoEmail = await send('mot_due', 'email', email);
  check('a quote by email is refused when they asked for no email at all', quoteNoEmail.skipCode === 'opted_out', quoteNoEmail.skipCode);
  check('  …and a reminder is refused as the STRONGER answer, not as marketing', reminderNoEmail.skipCode === 'opted_out', reminderNoEmail.skipCode);
  check('  …while their texts still carry the quote', reachedProvider(await send('quote_ready', 'sms', mobile)), 'one channel\'s refusal is not the other\'s');
  await setPref('email', 'all', null);

  // ── 5. WHEN THE CHECK ITSELF FAILS ─────────────────────────────────────────────────────────────
  console.log('\n— when the opt-out cannot be checked —');
  check('the rule: a MARKETING send is refused, a SERVICE send goes, exactly as before',
    R.suppressionDecision({ failed: true }, { channel: 'email', marketing: true }) === 'marketing_check_failed'
    && R.suppressionDecision({ failed: true }, { channel: 'email', marketing: false }) === 'send');
  // THE REAL FAILURE, through the real send path: Postgres refuses a NUL byte in a text parameter,
  // so the address lookup inside isSuppressed genuinely throws.
  const broken = 'broken ' + MARK;
  const mFail = await send('mot_due', 'email', broken);
  const sFail = await send('quote_ready', 'email', broken);
  check('a reminder whose opt-out lookup THREW is refused, not sent', mFail.skipCode === 'marketing_check_failed', `${mFail.status}/${mFail.skipCode}`);
  check('  …while a quote whose lookup threw still goes (service is unchanged: fail-open)', sFail.skipCode !== 'marketing_check_failed' && sFail.skipCode !== 'opted_out',
    `${sFail.status}/${sFail.skipCode ?? '—'} — dropping a quote because a lookup blinked is the worse harm`);
  const notifySrc = code(readFileSync('lib/notify.ts', 'utf8'));
  check('  …both through the one pure decision, in the catch', /catch \{[\s\S]{0,400}?return suppressionDecision\(\{ failed: true \}, \{ channel, marketing \}\);/.test(notifySrc));

  // ── 6. WHAT STAFF ARE TOLD ─────────────────────────────────────────────────────────────────────
  console.log('\n— each refusal carries a sentence staff can act on —');
  const mk = O.describeSendFailure(refusedSms, { channel: 'sms', customerName: 'Dana' });
  check('"no reminders or offers": not retryable, names the channel, and says quotes and invoices still reach them',
    mk.code === 'opted_out_marketing' && mk.retryable === false && /reminders or offers by text/.test(mk.message) && /Quotes and invoices still reach them/.test(mk.message), mk.message);
  const cf = O.describeSendFailure(mFail, { channel: 'email', customerName: 'Dana' });
  check('"could not check": retryable, and says to try again', cf.code === 'marketing_check_failed' && cf.retryable === true && /Try again/.test(cf.message), cf.message);

  // ── 7. THE BOARD, THE MOT LIST AND THE PREVIEW STOP OFFERING — AND KEEP THE CAR ────────────────
  console.log('\n— the board and the preview stop offering an offer, and keep the car —');
  const rowAfter = await boardRow();
  check('the car STAYS on the board (its destination is not "gone")', !!rowAfter && rowAfter.reasons.length > 0, rowAfter ? `stack ${rowAfter.stack}` : 'the car vanished');
  check('  …with no text and no email offered', rowAfter?.canSms === false && rowAfter?.canEmail === false);
  check('  …the phone number still shown — a call is not an electronic message', rowAfter?.phone === mobile, String(rowAfter?.phone));
  check('  …and labelled with WHICH refusal', rowAfter?.noContact === 'No offers', String(rowAfter?.noContact));
  const mot = await DATA.buildMotList(ZZ, new Date());
  const motRow = [...mot.due, ...mot.expired].find((r) => r.vehicleId === veh);
  check('the MOT list says the same, by the same rule', !!motRow && motRow.canSms === false && motRow.canEmail === false && motRow.noContact === 'No offers' && motRow.phone === mobile,
    motRow ? `canSms ${motRow.canSms}, canEmail ${motRow.canEmail}, "${motRow.noContact}"` : 'not on the MOT list');
  // THE PREVIEW, reached the way the page reaches it: a signed-in GET.
  const B = gateOrigin();
  const csrfRes = await fetch(`${B}/api/auth/csrf`);
  const csrfToken = (await csrfRes.json()).csrfToken;
  const csrfCookie = (csrfRes.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const cred = await fetch(`${B}/api/auth/callback/credentials`, { method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', cookie: csrfCookie },
    body: new URLSearchParams({ email: 'owner@zzgategarage.test', password: 'GateGarage!2026', csrfToken, json: 'true' }) });
  const session = /next-auth\.session-token=[^;]+/.exec((cred.headers.getSetCookie?.() ?? []).join('; '))?.[0] ?? '';
  const pv = await fetch(`${B}/api/marketing-send?vehicleId=${veh}`, { headers: { cookie: session } });
  const preview = pv.ok ? await pv.json() : {};
  check('the send preview offers neither channel, and says why in words staff can act on', pv.status === 200 && preview.canSms === false && preview.canEmail === false
    && /reminders or offers by text/.test(preview.smsWhyNot ?? '') && /Quotes and invoices still reach them/.test(preview.smsWhyNot ?? '') && /reminders or offers by email/.test(preview.emailWhyNot ?? ''),
    `HTTP ${pv.status}: ${preview.smsWhyNot ?? '—'}`);
  check('  …not "opted out of texts", which is a different refusal fixed a different way', !/opted out of texts/.test(preview.smsWhyNot ?? ''));

  console.log('\n— the labels, one rule for every combination —');
  const L = (o) => M.noContactLabel({ sms_opt_out: null, email_opt_out: null, sms_marketing_opt_out: null, email_marketing_opt_out: null, ...o });
  check('each refusal names itself', L({}) === null && L({ sms_opt_out: true }) === 'No texts' && L({ email_marketing_opt_out: true }) === 'No offers by email'
    && L({ sms_opt_out: true, email_opt_out: true }) === 'No electronic contact' && L({ sms_marketing_opt_out: true, email_marketing_opt_out: true }) === 'No offers'
    && L({ sms_opt_out: true, email_marketing_opt_out: true }) === 'No texts · No offers by email'
    && L({ sms_opt_out: true, sms_marketing_opt_out: true }) === 'No texts',
    'and "nothing at all" wins over "no offers" on the same channel');

  // ── 8. WHICH TEMPLATES ARE MARKETING ───────────────────────────────────────────────────────────
  console.log('\n— which messages count as marketing —');
  const tpls = Object.entries(T.NOTIFICATION_TEMPLATES);
  check('both MOT reminders are marketing', T.NOTIFICATION_TEMPLATES.mot_due.marketing === true && T.NOTIFICATION_TEMPLATES.mot_expired.marketing === true);
  const serviceKeys = tpls.map(([k]) => k).filter((k) => /^(quote_|invoice_|intake_|job_card_link)/.test(k));
  check('  …and no quote, invoice, intake or job-card message is', serviceKeys.length >= 6 && serviceKeys.every((k) => T.NOTIFICATION_TEMPLATES[k].marketing !== true), `${serviceKeys.length} service templates checked`);
  check('  …and nothing is both marketing and security, or marketing and prospecting', tpls.every(([, t]) => !(t.marketing && (t.security || t.prospecting))));

  // ── 9. THE RECORD STILL HOLDS ──────────────────────────────────────────────────────────────────
  const mismatch = await prisma.$queryRawUnsafe(`SELECT contact_preference_mismatch($1) AS m`, cust);
  check('the fixture\'s preferences agree with their history', mismatch[0].m === null, mismatch[0].m ?? 'agrees');
} catch (e) {
  check('gate run completed', false, describeError(e));
} finally {
  try {
    if (made.vehicles.length) await prisma.vehicle.deleteMany({ where: { id: { in: made.vehicles } } });
    if (made.customers.length) await prisma.customer.deleteMany({ where: { id: { in: made.customers } } });
    if (made.logs.length) await prisma.notificationLog.deleteMany({ where: { id: { in: made.logs } } });
    const left = await prisma.customer.count({ where: { id: { in: made.customers } } }) + await prisma.vehicle.count({ where: { id: { in: made.vehicles } } });
    check('teardown removed every fixture', left === 0, `${made.customers.length} customer, ${made.vehicles.length} car, ${made.logs.length} messages`);
  } catch (e) { check('teardown completed', false, describeError(e)); }
  await prisma.$disconnect();
}
console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
process.exit(out.includes('F') ? 1 : 0);
