/**
 * File: scripts/staff-preferences-gate.mjs
 * STAFF RECORD A CUSTOMER'S CHOICES — AND UNDOING THE CUSTOMER'S OWN "NO" TAKES A REASON.
 * @gate-requires: server, db
 *
 * Step 6 of the tenant unsubscribe (owner, 2026-09-11): the owner panel's "no reminders or offers"
 * controls, a reason on EVERY staff opt-in to marketing (the database's rule), and — the writer's rule,
 * because it depends on earlier history — a reason whenever staff clear an opt-out that the customer's
 * own link or their phone network set.
 *
 * Driven through the real staff API (/api/jobcard-details) signed in as ZZ's owner, as the form does.
 * Sends for the positive case run in THIS process (no provider): the dev server holds a live email key.
 *
 * ── POSITIVE CASE IN THE SAME RUN ───────────────────────────────────────────────────────────────
 * After staff record "no reminders or offers" on both channels, a quote and an invoice still reach
 * that customer — and a reminder does not.
 */
import './_gate-preflight.mjs';
import './_ts.mjs';
process.env.RESEND_API_KEY = '';
const { gatePrisma, describeError, declineToRun, gateOrigin, zzSite, ZZ_GROUP } = await import('./_gate-preflight.mjs');
const { randomUUID } = await import('node:crypto');
const { readFileSync } = await import('node:fs');
const N = await import('../lib/notify.ts');
const R = await import('../lib/contact-preference-rules.ts');
const CP = await import('../lib/contact-preferences.ts');
const { keyRegex } = await import('../lib/anchored-match.ts');
if (N.channelConfigured('email') || N.channelConfigured('sms')) declineToRun('a message provider is configured in this process — refusing to run a gate that sends to fixtures');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const code = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const prisma = await gatePrisma();
const ZZ = ZZ_GROUP;
const MARK = '@staff-preferences-gate.invalid';
const MAKE = 'StaffPrefGate';
const B = gateOrigin();
const made = { customers: [], vehicles: [], cards: [], logs: [] };
const uniq = () => randomUUID().slice(0, 8);

{
  const planted = await prisma.customer.create({ data: { group_id: ZZ, name: 'Planted leftover', email: `planted-${uniq()}${MARK}` }, select: { id: true } });
  await prisma.jobCard.deleteMany({ where: { group_id: ZZ, vehicle: { make: MAKE } } });
  await prisma.vehicle.deleteMany({ where: { group_id: ZZ, make: MAKE } });
  await prisma.customer.deleteMany({ where: { group_id: ZZ, email: { endsWith: MARK } } }); // first: events cite messages
  await prisma.notificationLog.deleteMany({ where: { group_id: ZZ, OR: [{ recipient: { endsWith: MARK } }, { recipient: { startsWith: '4477004' } }] } });
  check('a killed run\'s fixtures are swept first', (await prisma.customer.count({ where: { OR: [{ id: planted.id }, { email: { endsWith: MARK } }] } })) === 0);
}

try {
  // ── 1. THE WRITER'S RULE, EVERY CASE ───────────────────────────────────────────────────────────
  console.log('\n— the rule: undoing the customer\'s own "no" takes a reason —');
  const C = (o) => R.clearingNeedsReason({ via: 'staff', previous: true, optedOut: false, latestVia: 'customer_link', reason: null, ...o });
  check('staff clearing an opt-out the CUSTOMER\'s link set needs a reason', C({}) === true && C({ optedOut: null }) === true);
  check('  …and one their PHONE NETWORK set', C({ latestVia: 'carrier_stop' }) === true);
  check('  …but not one a member of STAFF set', C({ latestVia: 'staff' }) === false, 'the database\'s own rule still covers a staff opt-in to marketing');
  check('  …and a reason satisfies it; blank does not', C({ reason: 'Asked at the counter' }) === false && C({ reason: '   ' }) === true);
  check('  …and it is only about CLEARING: setting an opt-out never needs one', C({ previous: null, optedOut: true }) === false && C({ previous: false, optedOut: true }) === false);

  // ── FIXTURES, AND THE STAFF PATH ───────────────────────────────────────────────────────────────
  const zzOwner = await prisma.user.findFirst({ where: { group_id: ZZ, email: 'owner@zzgategarage.test' }, select: { id: true, name: true } });
  const site = await zzSite(prisma);
  const email = `robin-${uniq()}${MARK}`;
  const mobile = `4477004${String(Math.floor(Math.random() * 1e5)).padStart(5, '0')}`;
  const cust = (await prisma.customer.create({ data: { group_id: ZZ, name: 'Robin Staff', email, phone: mobile, phone_e164: mobile }, select: { id: true } })).id;
  made.customers.push(cust);
  const veh = (await prisma.vehicle.create({ data: { group_id: ZZ, registration: `SP${uniq().toUpperCase().slice(0, 5)}`, make: MAKE, model: 'Fixture' }, select: { id: true } })).id;
  made.vehicles.push(veh);
  await prisma.vehicleOwnership.create({ data: { vehicle_id: veh, customer_id: cust, is_current: true } });
  const card = (await prisma.jobCard.create({ data: { group_id: ZZ, site_id: site.id, vehicle_id: veh, status: 'draft' }, select: { id: true } })).id;
  made.cards.push(card);
  const csrfRes = await fetch(`${B}/api/auth/csrf`);
  const csrfToken = (await csrfRes.json()).csrfToken;
  const csrfCookie = (csrfRes.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const cred = await fetch(`${B}/api/auth/callback/credentials`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', cookie: csrfCookie },
    body: new URLSearchParams({ email: 'owner@zzgategarage.test', password: 'GateGarage!2026', csrfToken, json: 'true' }) });
  const session = /next-auth\.session-token=[^;]+/.exec((cred.headers.getSetCookie?.() ?? []).join('; '))?.[0] ?? '';
  check('signed in as ZZ\'s owner', !!session);
  const save = async (owner) => { const r = await fetch(`${B}/api/jobcard-details`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: session }, body: JSON.stringify({ jobCardId: card, owner, source: 'details-form' }) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const cols = () => prisma.customer.findUnique({ where: { id: cust }, select: { name: true, sms_opt_out: true, email_opt_out: true, sms_marketing_opt_out: true, email_marketing_opt_out: true } });
  const last = async () => (await prisma.contactPreferenceEvent.findMany({ where: { customer_id: cust }, orderBy: { seq: 'desc' }, take: 1 }))[0] ?? null;

  // ── 2. "NO REMINDERS OR OFFERS", FROM THE FORM ─────────────────────────────────────────────────
  console.log('\n— staff record "no reminders or offers" from the owner panel —');
  const s1 = await save({ email_marketing_opt_out: true });
  const e1 = await last();
  check('ticking it records the refusal, by the signed-in staff member, and needs no reason', s1.status === 200 && (await cols()).email_marketing_opt_out === true
    && e1?.via === 'staff' && e1?.actor_user_id === zzOwner.id && e1?.scope === 'marketing', `HTTP ${s1.status}`);

  // ── 3. SWITCHING IT BACK ON NEEDS A REASON — AND A REFUSAL SAVES NOTHING ───────────────────────
  console.log('\n— switching reminders and offers back on needs a reason —');
  const s2 = await save({ name: 'Robin Renamed', email_marketing_opt_out: false });
  const c2 = await cols();
  check('unticking it with NO reason is refused, and says what to do', s2.status === 409 && s2.body.code === 'optin_needs_a_reason' && /Say why/.test(s2.body.message ?? ''), `${s2.status} ${s2.body.code}: ${s2.body.message ?? ''}`);
  check('  …and NOTHING in that save was kept — not even the name change beside it', c2.email_marketing_opt_out === true && c2.name === 'Robin Staff',
    'one transaction: a refused preference does not leave half a save behind');
  const s3 = await save({ email_marketing_opt_out: false, preference_reason: '  Asked at the counter for MOT reminders again ' });
  const e3 = await last();
  check('with a reason it is recorded, the reason kept with the change', s3.status === 200 && (await cols()).email_marketing_opt_out === false && e3?.reason === 'Asked at the counter for MOT reminders again',
    e3?.reason ?? `HTTP ${s3.status}`);

  // ── 4. UNDOING THE CUSTOMER'S OWN UNSUBSCRIBE ──────────────────────────────────────────────────
  console.log('\n— undoing the customer\'s own unsubscribe needs a reason —');
  const reminder = await N.sendNotification({ groupId: ZZ, template: 'mot_due', channel: 'email', recipient: email, data: { garageName: 'ZZ Gate Garage', registration: 'SP1', expiryDate: '1 October 2026', garagePhone: '01384 000000' } });
  made.logs.push(reminder.notificationId);
  const tok = (await prisma.notificationLog.findUnique({ where: { id: reminder.notificationId }, select: { unsubscribe_token: true } })).unsubscribe_token;
  const un = await CP.unsubscribeByLink(tok, prisma);
  check('the customer unsubscribes themselves, with the link', un.ok && (await cols()).email_marketing_opt_out === true && (await last())?.via === 'customer_link');
  const s4 = await save({ email_marketing_opt_out: false, preference_reason: '' });
  check('staff clearing it with no reason is refused — as undoing the CUSTOMER\'s own choice', s4.status === 409 && s4.body.code === 'undoing_their_own_opt_out_needs_a_reason'
    && /stopped these messages themselves/.test(s4.body.message ?? '') && (await cols()).email_marketing_opt_out === true, `${s4.status} ${s4.body.code}`);
  const s5 = await save({ email_marketing_opt_out: false, preference_reason: 'Rang us and asked to hear about offers again' });
  check('  …and allowed with one', s5.status === 200 && (await cols()).email_marketing_opt_out === false && (await last())?.reason === 'Rang us and asked to hear about offers again');

  // ── 5. UNDOING A CARRIER STOP ──────────────────────────────────────────────────────────────────
  console.log('\n— undoing a STOP their phone network recorded needs a reason —');
  const stopped = await prisma.notificationLog.create({ data: { group_id: ZZ, scope: 'tenant', channel: 'sms', template: 'invoice_pay_link', provider: 'twilio', status: 'failed', recipient: mobile, error: 'twilio 21610' }, select: { id: true } });
  made.logs.push(stopped.id);
  const cs = await CP.recordCarrierStop(stopped.id, prisma);
  check('a carrier STOP marks no texts at all', cs.recorded && (await cols()).sms_opt_out === true && (await last())?.via === 'carrier_stop');
  const s6 = await save({ sms_opt_out: null });
  check('staff unticking "no SMS" after a STOP, with no reason, is refused — and says whose "no" it was', s6.status === 409 && s6.body.code === 'undoing_their_own_opt_out_needs_a_reason'
    && /phone network/.test(s6.body.message ?? '') && (await cols()).sms_opt_out === true, s6.body.message ?? `HTTP ${s6.status}`);
  const s7 = await save({ sms_opt_out: null, preference_reason: 'Texted START to the network; confirmed at the desk' });
  check('  …and allowed with one', s7.status === 200 && (await cols()).sms_opt_out === null && (await last())?.reason === 'Texted START to the network; confirmed at the desk');

  // ── 6. THE CONTROL: A STAFF-SET "NO" IS STAFF'S TO UNDO ─────────────────────────────────────────
  const s8 = await save({ email_opt_out: true });
  const s9 = await save({ email_opt_out: null });
  check('staff undoing a "no email" STAFF set needs no reason — unchanged', s8.status === 200 && s9.status === 200 && (await cols()).email_opt_out === null,
    'the discriminator: the new rule fires on WHOSE "no" it was, not on every clearing');

  // ── 7. WHERE EACH ANSWER CAME FROM, FOR THE PANEL ───────────────────────────────────────────────
  console.log('\n— the owner panel is told where each answer came from —');
  const src = await CP.latestPreferenceSources(cust, prisma);
  check('each preference\'s latest source: who, when, what it did, and the reason',
    src['email/marketing']?.via === 'staff' && src['email/marketing']?.by === zzOwner.name && src['email/marketing']?.reason === 'Rang us and asked to hear about offers again' && src['email/marketing']?.optedOut === false
    && src['sms/all']?.via === 'staff' && src['sms/all']?.optedOut === null && src['email/all']?.via === 'staff',
    JSON.stringify(src['email/marketing']));
  const pageData = code(readFileSync('lib/jobcard-page-data.ts', 'utf8'));
  check('  …and the card builder passes them to the panel, read in the existing wave (not after it)',
    /ownerId \? latestPreferenceSources\(ownerId\) : Promise\.resolve\(\{\}\)/.test(pageData) && keyRegex('preferenceSources', 'ownerPrefSources,').test(pageData));
  const form = code(readFileSync('components/jobcard/CustomerDetailsForm.tsx', 'utf8'));
  check('the panel has the controls, the source lines, and asks for the reason before the server does',
    /data-testid="mkt-sms"/.test(form) && /data-testid="mkt-email"/.test(form) && /data-testid="pref-reason"/.test(form)
    && /pref-source-/.test(form) && /if \(needsReason && !prefReason\.trim\(\)\)/.test(form));

  // ── 8. THE POSITIVE CASE, SAME RUN ─────────────────────────────────────────────────────────────
  console.log('\n— after staff record "no reminders or offers": quotes and invoices still go —');
  const s10 = await save({ sms_marketing_opt_out: true, email_marketing_opt_out: true });
  check('staff record "no reminders or offers" on both channels', s10.status === 200 && (await cols()).sms_marketing_opt_out === true && (await cols()).email_marketing_opt_out === true);
  const data = { garageName: 'ZZ Gate Garage', registration: 'SP1', expiryDate: '1 October 2026', link: 'https://greasedesk.com/c/x', total: '£90.00', expiryDays: 14, garagePhone: '01384 000000' };
  const send = async (template, channel, to) => { const r = await N.sendNotification({ groupId: ZZ, template, channel, recipient: to, data }); if (r.notificationId) made.logs.push(r.notificationId); return r; };
  const service = await Promise.all([send('quote_ready', 'email', email), send('invoice_document', 'email', email), send('quote_ready', 'sms', mobile)]);
  check('a quote and an invoice STILL reach them', service.every((r) => r.skipCode === 'not_configured'), service.map((r) => r.skipCode).join(' / '));
  const mk = await Promise.all([send('mot_due', 'email', email), send('mot_due', 'sms', mobile)]);
  check('  …while reminders do not', mk.every((r) => r.skipCode === 'opted_out_marketing'), mk.map((r) => r.skipCode).join(' / '));

  const mm = await prisma.$queryRawUnsafe(`SELECT contact_preference_mismatch($1) AS m`, cust);
  check('every change agrees with its history', mm[0].m === null, mm[0].m ?? 'agrees');
} catch (e) {
  check('gate run completed', false, describeError(e));
} finally {
  try {
    if (made.cards.length) await prisma.jobCard.deleteMany({ where: { id: { in: made.cards } } });
    if (made.vehicles.length) await prisma.vehicle.deleteMany({ where: { id: { in: made.vehicles } } });
    if (made.customers.length) await prisma.customer.deleteMany({ where: { id: { in: made.customers } } }); // first: events cite messages
    await prisma.notificationLog.deleteMany({ where: { OR: [{ id: { in: made.logs.filter(Boolean) } }, { recipient: { endsWith: MARK } }] } });
    check('teardown removed every fixture, history with it', (await prisma.customer.count({ where: { id: { in: made.customers } } })) === 0);
  } catch (e) { check('teardown completed', false, describeError(e)); }
  await prisma.$disconnect();
}
console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
process.exit(out.includes('F') ? 1 : 0);
