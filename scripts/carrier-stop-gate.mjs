/**
 * File: scripts/carrier-stop-gate.mjs
 * WHEN A HANDSET REPLIES STOP, WE STOP OFFERING IT TEXTS.
 * @gate-requires: server, db
 *
 * Step 2 of the tenant unsubscribe (2026-09-11). Before this, Twilio blocked a number that had
 * replied STOP and we recorded a failed send — and the marketing board went on offering texts to a
 * person who had said no. The one place a real person refused and we ignored it (owner).
 *
 * ── WHAT IS PROVED, AND WHAT IS NOT ─────────────────────────────────────────────────────────────
 *   · the 21610 recogniser, on the shapes Twilio actually sends it in — and not on a phone number or
 *     another code that merely contains the digits;
 *   · the ONE recorder (lib/contact-preferences::recordCarrierStop) on real rows: every customer in
 *     the SENDING garage holding the number is marked "no texts at all", citing the message; another
 *     garage's customer with the same number is NOT (owner, 2026-09-10); nothing else moves; a second
 *     STOP records nothing; the board stops offering a text; the next text is refused before any
 *     provider; the history agrees with every column (the trigger would refuse it otherwise).
 *   · that BOTH entry points call that recorder — by reading them.
 *   NOT driven end to end: the live Twilio paths. This machine has no SMS keys, so a send stops at
 *   `not_configured` before any provider, and the status webhook answers 503 without its signing
 *   key. Both are one line each — `isCarrierStop(...)` then `recordCarrierStop(id)` — asserted below,
 *   and everything behind them is driven for real.
 *
 * Fixtures: ZZ, plus one customer on ZZUS (US-GD2175, the standing second tenant), all marked by the
 * address domain @carrier-stop-gate.invalid; the failed send is a NotificationLog row of our own.
 * A killed run's leftovers are swept first, with one planted so the sweep is proved.
 */
import './_gate-preflight.mjs';
import './_ts.mjs';
const { gatePrisma, describeError, ZZ_GROUP } = await import('./_gate-preflight.mjs');
const { randomUUID } = await import('node:crypto');
const { readFileSync } = await import('node:fs');
const R = await import('../lib/contact-preference-rules.ts');
const CP = await import('../lib/contact-preferences.ts');
const N = await import('../lib/notify.ts');
const M = await import('../lib/marketing-lists.ts');
const O = await import('../lib/send-outcome.ts');
const { keyRegex } = await import('../lib/anchored-match.ts');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const code = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const prisma = await gatePrisma();
const ZZ = ZZ_GROUP;
const MARK = '@carrier-stop-gate.invalid';
const made = { customers: [], logs: [] };
const uniq = () => randomUUID().slice(0, 8);

// ── 0. A KILLED RUN'S LEFTOVERS FIRST, AND ONE PLANTED ─────────────────────────────────────────────
const zzus = await prisma.group.findUnique({ where: { ref: 'US-GD2175' }, select: { id: true } });
{
  const planted = await prisma.customer.create({ data: { group_id: ZZ, name: 'Planted leftover', email: `planted-${uniq()}${MARK}` }, select: { id: true } });
  // Customers first — their events cite the fixture messages, which are held NO ACTION.
  await prisma.customer.deleteMany({ where: { email: { endsWith: MARK } } });
  await prisma.notificationLog.deleteMany({ where: { template: 'carrier_stop_gate' } }); // a template name unique to this gate
  check('a killed run\'s fixtures are swept first', (await prisma.customer.count({ where: { OR: [{ id: planted.id }, { email: { endsWith: MARK } }] } })) === 0);
}

try {
  check('the second tenant exists', !!zzus, 'US-GD2175 — a customer there shares the number and must NOT be marked');

  // ── 1. RECOGNISING A STOP ───────────────────────────────────────────────────────────────────────
  console.log('\n— a STOP is recognised in the shapes Twilio sends it, and nothing else is —');
  const sendTimeBody = 'sms 400: {"code": 21610, "message": "Attempt to send to unsubscribed recipient", "more_info": "https://www.twilio.com/docs/errors/21610", "status": 400}';
  check('the refusal at send time (the adapter\'s own error text)', R.isCarrierStop(sendTimeBody));
  check('the delivery callback as stored (`twilio 21610`) and as sent (`21610`)', R.isCarrierStop('twilio 21610') && R.isCarrierStop('21610'));
  check('NOT an unreachable handset, NOT a neighbouring code', !R.isCarrierStop('twilio 30003') && !R.isCarrierStop('twilio 21611') && !R.isCarrierStop('sms 400: {"code": 21211}'),
    '30003 is a phone that is off; 21211 a bad number — neither is a person saying no');
  check('NOT a phone number that merely contains the digits', !R.isCarrierStop('sms 400: could not reach +447700921610') && !R.isCarrierStop('216100'),
    'matched as a whole number, so a recipient in the error text is not a STOP');
  check('nothing is not a STOP', !R.isCarrierStop(null) && !R.isCarrierStop(''));

  // ── 2. RECORDING ONE ────────────────────────────────────────────────────────────────────────────
  console.log('\n— the sending garage\'s customers are marked, and only theirs —');
  const num = `4477008${String(Math.floor(Math.random() * 1e5)).padStart(5, '0')}`;
  const other = `4477008${String(Math.floor(Math.random() * 1e5)).padStart(5, '0')}`;
  check('the fixture numbers belong to nobody else', (await prisma.customer.count({ where: { OR: [{ phone_e164: { in: [num, other] } }, { phone: { in: [num, other] } }] } })) === 0);
  const cust = async (group, label, phone, extra = {}) => {
    const c = await prisma.customer.create({ data: { group_id: group, name: `Carrier Stop ${label}`, email: `${label}-${uniq()}${MARK}`, phone, phone_e164: phone, ...extra }, select: { id: true } });
    made.customers.push(c.id); return c.id;
  };
  const holder = await cust(ZZ, 'holder', num);
  const household = await cust(ZZ, 'household', num);       // a second ZZ customer on the SAME handset
  const neighbour = await cust(ZZ, 'neighbour', other);     // ZZ, a different number
  const elsewhere = zzus ? await cust(zzus.id, 'elsewhere', num) : null; // ANOTHER garage, the same number
  const failed = await prisma.notificationLog.create({ data: {
    group_id: ZZ, scope: 'tenant', channel: 'sms', template: 'carrier_stop_gate', provider: 'twilio',
    status: 'failed', recipient: num, error: 'twilio 21610',
  }, select: { id: true } });
  made.logs.push(failed.id);

  const r1 = await CP.recordCarrierStop(failed.id, prisma);
  const cols = (id) => prisma.customer.findUnique({ where: { id }, select: { sms_opt_out: true, email_opt_out: true, sms_marketing_opt_out: true, email_marketing_opt_out: true, phone_e164: true, email: true } });
  const ev = (id) => prisma.contactPreferenceEvent.findMany({ where: { customer_id: id }, orderBy: { seq: 'asc' } });
  const [h, hh, nb] = await Promise.all([cols(holder), cols(household), cols(neighbour)]);
  check('the customer who holds the number is marked NO TEXTS AT ALL', r1.recorded && h.sms_opt_out === true, JSON.stringify(r1));
  check('  …and so is everyone else in that garage on the same handset', hh.sms_opt_out === true && r1.recorded && r1.customers === 2,
    'the carrier refuses the HANDSET; suppression already refuses on any row holding it');
  const [eh, ehh] = await Promise.all([ev(holder), ev(household)]);
  check('  …each through the one writer, citing the message the STOP came back on',
    [eh, ehh].every((e) => e.length === 1 && e[0].via === 'carrier_stop' && e[0].scope === 'all' && e[0].channel === 'sms'
      && e[0].notification_log_id === failed.id && e[0].actor_user_id === null && e[0].previous === null && e[0].opted_out === true),
    `${eh.length} + ${ehh.length} event(s), via ${eh[0]?.via}, citing ${eh[0]?.notification_log_id === failed.id ? 'the failed send' : eh[0]?.notification_log_id}`);
  check('a ZZ customer on a DIFFERENT number is untouched', nb.sms_opt_out === null && (await ev(neighbour)).length === 0);
  if (elsewhere) {
    const el = await cols(elsewhere);
    check('ANOTHER GARAGE\'s customer on the SAME number is untouched', el.sms_opt_out === null && (await ev(elsewhere)).length === 0,
      'their first text gets its own 21610 and is marked then — each garage\'s consent record stays its own');
  }
  check('only texts moved: email and marketing are exactly as they were',
    [h, hh].every((c) => c.email_opt_out === null && c.sms_marketing_opt_out === null && c.email_marketing_opt_out === null));
  const r2 = await CP.recordCarrierStop(failed.id, prisma);
  check('a second STOP for the same number records nothing new', r2.recorded && r2.changed === 0 && (await ev(holder)).length === 1, JSON.stringify(r2));

  console.log('\n— and what that changes for the garage —');
  check('the marketing board no longer offers a text', M.contactRoute(h).sms === false && M.contactRoute(h).email === true,
    `sms ${M.contactRoute(h).sms}, email ${M.contactRoute(h).email} — a STOP to texts is not a STOP to email`);
  const next = await N.sendNotification({ groupId: ZZ, channel: 'sms', template: 'invoice_pay_link', recipient: num, data: { garageName: 'ZZ', link: 'https://greasedesk.com/c/x' } });
  if (next.notificationId) made.logs.push(next.notificationId);
  check('the next text to that number is refused before any provider', next.skipCode === 'opted_out' && next.suppressed === true,
    `${next.status}/${next.skipCode} — a quote as much as an offer: the carrier refuses every text`);
  const copy = O.describeSendFailure({ ok: false, status: 'failed', reason: 'twilio 21610', skipCode: 'carrier_stop' }, { channel: 'sms', customerName: 'Dave' });
  check('a STOP is NOT offered as "try again"', copy.code === 'carrier_stop' && copy.retryable === false && /replied STOP/.test(copy.message) && /START/.test(copy.message),
    copy.message);
  const plainFail = O.describeSendFailure({ ok: false, status: 'failed', reason: 'twilio 30003' }, { channel: 'sms' });
  check('  …while an ordinary provider refusal still is', plainFail.code === 'provider_rejected' && plainFail.retryable === true,
    'the discriminator: the new branch took only the STOP');

  console.log('\n— what a STOP is not —');
  const platform = await prisma.notificationLog.create({ data: { group_id: null, scope: 'platform', channel: 'sms', template: 'carrier_stop_gate', provider: 'twilio', status: 'failed', recipient: num, error: 'twilio 21610' }, select: { id: true } });
  made.logs.push(platform.id);
  const rp = await CP.recordCarrierStop(platform.id, prisma);
  check('a STOP on one of OUR OWN texts marks no garage\'s customer', !rp.recorded && rp.why === 'not_a_tenant_send', JSON.stringify(rp));
  const email = await prisma.notificationLog.create({ data: { group_id: ZZ, scope: 'tenant', channel: 'email', template: 'carrier_stop_gate', provider: 'resend', status: 'failed', recipient: `x${MARK}`, error: '21610' }, select: { id: true } });
  made.logs.push(email.id);
  const re = await CP.recordCarrierStop(email.id, prisma);
  check('  …nor does an email failure that happens to carry the digits', !re.recorded && re.why === 'not_a_text', JSON.stringify(re));
  const nobody = await prisma.notificationLog.create({ data: { group_id: ZZ, scope: 'tenant', channel: 'sms', template: 'carrier_stop_gate', provider: 'twilio', status: 'failed', recipient: '447700800000', error: 'twilio 21610' }, select: { id: true } });
  made.logs.push(nobody.id);
  const rn = await CP.recordCarrierStop(nobody.id, prisma);
  check('  …and a STOP from a number no customer holds says so, rather than succeeding at nothing', !rn.recorded && rn.why === 'no_customer_holds_the_number', JSON.stringify(rn));

  // ── 3. BOTH ENTRY POINTS CALL THE ONE RECORDER ──────────────────────────────────────────────────
  console.log('\n— both ways a STOP arrives reach it —');
  const notifySrc = code(readFileSync('lib/notify.ts', 'utf8'));
  const sendBody = notifySrc.slice(notifySrc.indexOf('export async function sendNotification'));
  check('refused at send time: the send path records it before returning',
    /if \(!accepted && channel === 'sms' && isCarrierStop\(error\) && id\) \{\s*const stop = await recordCarrierStop\(id\);/.test(sendBody)
    && keyRegex('skipCode', "'carrier_stop'").test(sendBody),
    'and answers carrier_stop — not the retryable provider_rejected it used to fall into');
  const hook = code(readFileSync('pages/api/webhooks/twilio-status.ts', 'utf8'));
  check('reported later: the delivery callback records it, before the status ratchet',
    /if \(isCarrierStop\(params\.ErrorCode\)\) \{\s*const stop = await recordCarrierStop\(row\.id\);/.test(hook)
    && hook.indexOf('recordCarrierStop(row.id)') < hook.indexOf('ratchet(row.status'),
    'the STOP is a fact about the handset, whatever order the callbacks arrive in');
  check('the send path\'s opt-out check and the recorder use ONE address match',
    /customerAddressWhere\(groupId, channel, to\)/.test(notifySrc) && /customerAddressWhere\(groupId, 'sms', log\.recipient\)/.test(code(readFileSync('lib/contact-preferences.ts', 'utf8'))),
    'so a number that counts as this customer when refusing a text is the number that counts when they say stop');

  // ── 4. THE RECORD STILL HOLDS ───────────────────────────────────────────────────────────────────
  const disagree = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "Customer" c WHERE c.id = ANY($1::text[]) AND contact_preference_mismatch(c.id) IS NOT NULL`, made.customers);
  check('every fixture customer agrees with its history (the trigger\'s own test)', disagree[0].n === 0, `${made.customers.length} customers`);
} catch (e) {
  check('gate run completed', false, describeError(e));
} finally {
  try {
    // Customers first: their events cite the fixture messages, which are held NO ACTION.
    if (made.customers.length) await prisma.customer.deleteMany({ where: { id: { in: made.customers } } });
    if (made.logs.length) await prisma.notificationLog.deleteMany({ where: { id: { in: made.logs } } });
    const left = await prisma.customer.count({ where: { id: { in: made.customers } } }) + await prisma.notificationLog.count({ where: { id: { in: made.logs } } });
    check('teardown removed every fixture, history with it', left === 0, `${made.customers.length} customers, ${made.logs.length} messages`);
  } catch (e) { check('teardown completed', false, describeError(e)); }
  await prisma.$disconnect();
}
console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
process.exit(out.includes('F') ? 1 : 0);
