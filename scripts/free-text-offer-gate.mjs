/**
 * File: scripts/free-text-offer-gate.mjs
 * STAFF DECLARE WHETHER A MESSAGE IS A REMINDER OR OFFER — AND THE DECLARATION IS THE RECORD.
 * @gate-requires: server, db
 *
 * Step 5 of the tenant unsubscribe (owner, 2026-09-11): a tick on the compose box, unticked by
 * default; the API refuses a send that declares neither; ticked sends `free_text_offer` (marketing:
 * the way out, and refused to someone who said no reminders or offers); unticked sends
 * `free_text_note`; the old `free_text` keeps its own meaning for the messages sent before the
 * question existed, and nothing sends it any more.
 *
 * ── THE DEV SERVER CAN SEND REAL EMAIL ──────────────────────────────────────────────────────────
 * Its .env carries a live email key, so EVERY send through the HTTP API here goes by TEXT (no SMS
 * provider on this machine): an allowed one stops before any provider, a refused one earlier. The
 * email-specific clauses — the offer's footer and token — run in THIS process, which has no email key.
 *
 * ── POSITIVE CASE IN THE SAME RUN ───────────────────────────────────────────────────────────────
 * To the same customer, who asked for no reminders or offers by text: the unticked note GOES, the
 * ticked offer is REFUSED. A send path that refused all free text would fail the first.
 */
import './_gate-preflight.mjs';
import './_ts.mjs';
process.env.RESEND_API_KEY = '';
const { gatePrisma, describeError, declineToRun, gateOrigin, zzSite, ZZ_GROUP } = await import('./_gate-preflight.mjs');
const { randomUUID } = await import('node:crypto');
const { readFileSync, readdirSync } = await import('node:fs');
const { join } = await import('node:path');
const N = await import('../lib/notify.ts');
const T = await import('../lib/notification-templates.ts');
const CP = await import('../lib/contact-preferences.ts');
const { keyRegex } = await import('../lib/anchored-match.ts');
if (N.channelConfigured('email') || N.channelConfigured('sms')) declineToRun('a message provider is configured in this process — refusing to run a gate that sends to fixtures');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const code = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const prisma = await gatePrisma();
const ZZ = ZZ_GROUP;
const MARK = '@free-text-offer-gate.invalid';
const MAKE = 'FreeTextGate';
const B = gateOrigin();
const made = { customers: [], vehicles: [], cards: [], logs: [] };
const uniq = () => randomUUID().slice(0, 8);

{
  const planted = await prisma.customer.create({ data: { group_id: ZZ, name: 'Planted leftover', email: `planted-${uniq()}${MARK}` }, select: { id: true } });
  await prisma.jobCard.deleteMany({ where: { group_id: ZZ, vehicle: { make: MAKE } } });
  await prisma.vehicle.deleteMany({ where: { group_id: ZZ, make: MAKE } });
  await prisma.customer.deleteMany({ where: { group_id: ZZ, email: { endsWith: MARK } } });
  await prisma.notificationLog.deleteMany({ where: { group_id: ZZ, OR: [{ recipient: { endsWith: MARK } }, { recipient: { startsWith: '4477005' } }] } });
  check('a killed run\'s fixtures are swept first', (await prisma.customer.count({ where: { OR: [{ id: planted.id }, { email: { endsWith: MARK } }] } })) === 0);
}

try {
  const zzOwner = await prisma.user.findFirst({ where: { group_id: ZZ, email: 'owner@zzgategarage.test' }, select: { id: true } });
  const site = await zzSite(prisma);
  const email = `sam-${uniq()}${MARK}`;
  const mobile = `4477005${String(Math.floor(Math.random() * 1e5)).padStart(5, '0')}`;
  const cust = (await prisma.customer.create({ data: { group_id: ZZ, name: 'Sam Offer', email, phone: mobile, phone_e164: mobile }, select: { id: true } })).id;
  made.customers.push(cust);
  const veh = (await prisma.vehicle.create({ data: { group_id: ZZ, registration: `FT${uniq().toUpperCase().slice(0, 5)}`, make: MAKE, model: 'Fixture' }, select: { id: true } })).id;
  made.vehicles.push(veh);
  await prisma.vehicleOwnership.create({ data: { vehicle_id: veh, customer_id: cust, is_current: true } });
  const card = (await prisma.jobCard.create({ data: { group_id: ZZ, site_id: site.id, vehicle_id: veh, status: 'draft' }, select: { id: true } })).id;
  made.cards.push(card);
  // "No reminders or offers by TEXT" — through the one writer.
  const pref = await CP.recordContactPreference({ groupId: ZZ, customerId: cust, channel: 'sms', scope: 'marketing', optedOut: true, via: 'staff', actorUserId: zzOwner.id }, prisma);
  check('the customer has asked for no reminders or offers by text', pref.ok && pref.changed);

  const csrfRes = await fetch(`${B}/api/auth/csrf`);
  const csrfToken = (await csrfRes.json()).csrfToken;
  const csrfCookie = (csrfRes.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const cred = await fetch(`${B}/api/auth/callback/credentials`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', cookie: csrfCookie },
    body: new URLSearchParams({ email: 'owner@zzgategarage.test', password: 'GateGarage!2026', csrfToken, json: 'true' }) });
  const session = /next-auth\.session-token=[^;]+/.exec((cred.headers.getSetCookie?.() ?? []).join('; '))?.[0] ?? '';
  check('signed in as ZZ\'s owner', !!session);
  const post = (payload) => fetch(`${B}/api/messages/send`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: session }, body: JSON.stringify({ jobCardId: card, channel: 'sms', ...payload }) });
  const lastRow = async () => prisma.notificationLog.findFirst({ where: { recipient: mobile }, orderBy: { created_at: 'desc' }, select: { id: true, template: true, status: true, error: true, body: true } });

  // ── 1. A DECLARATION, EVERY TIME ───────────────────────────────────────────────────────────────
  console.log('\n— the API refuses a message that declares neither —');
  const threadsBefore = await prisma.messageThread.count({ where: { customer_id: cust } });
  const none = await post({ body: 'Your car is ready' });
  const noneJson = await none.json().catch(() => ({}));
  check('no declaration → refused, and says what to declare', none.status === 400 && noneJson.code === 'offer_undeclared' && /reminder or offer/.test(noneJson.message ?? ''), `${none.status} ${noneJson.code}`);
  const stringy = await post({ body: 'Your car is ready', offer: 'no' });
  check('  …and "no" as a string is not a declaration either', stringy.status === 400, 'exactly true or false — absence is not assumed to mean no');
  check('  …nothing was created by either — not a message, not a conversation', !(await lastRow()) && (await prisma.messageThread.count({ where: { customer_id: cust } })) === threadsBefore,
    'refused before the thread is made');

  // ── 2. THE POSITIVE CASE AND THE REFUSAL, SAME RUN, SAME CUSTOMER ──────────────────────────────
  console.log('\n— unticked, it goes; ticked, it is refused to someone who said no —');
  const note = await post({ body: 'Your car is ready for collection', offer: false });
  const noteJson = await note.json().catch(() => ({}));
  const noteRow = await lastRow(); if (noteRow) made.logs.push(noteRow.id);
  // READ FROM THE RECORD, not the HTTP status: with no SMS provider here, an allowed send is answered
  // 502 ("not accepted"); what matters is that it got PAST the preference check to the provider stage.
  check('an UNTICKED message reaches this customer — the preference check let it through', noteJson.code !== 'suppressed' && noteRow?.template === 'free_text_note'
    && /provider not configured|allowance/.test(noteRow?.error ?? '') && !/reminders or offers|opted out/.test(noteRow?.error ?? ''),
    `${noteRow?.template}: ${noteRow?.status} (${noteRow?.error ?? 'no error'}) — stopped only at the provider stage`);
  const offer = await post({ body: '20% off brake pads this month', offer: true });
  const offerJson = await offer.json().catch(() => ({}));
  const offerRow = await lastRow(); if (offerRow) made.logs.push(offerRow.id);
  check('a TICKED message is refused, as the customer\'s marketing choice', offerRow?.template === 'free_text_offer' && offerRow?.status === 'skipped' && /no reminders or offers/.test(offerRow?.error ?? ''),
    `${offerRow?.template}: ${offerRow?.status} (${offerRow?.error})`);
  check('  …and staff are told WHICH refusal, in the shared sentence — not "opted out of sms"',
    offer.status === 409 && offerJson.reason === 'opted_out_marketing' && /reminders or offers by text/.test(offerJson.message ?? '') && /Quotes and invoices still reach them/.test(offerJson.message ?? '')
    && !/opted out of sms/.test(offerJson.message ?? ''), offerJson.message ?? `HTTP ${offer.status}`);
  check('  …and what staff DECLARED is on the row, with the words they wrote', offerRow?.body === '20% off brake pads this month' && noteRow?.body === 'Your car is ready for collection',
    'the record that protects the garage later: we cannot police the words, but the declaration is kept');

  // ── 3. THE OFFER CARRIES THE WAY OUT; THE NOTE DOES NOT (in this process — no email key) ───────
  console.log('\n— by email, an offer carries the way out and a note does not —');
  const data = { garageName: 'ZZ Gate Garage', greeting: 'Hello Sam', body: 'A winter check offer' };
  const eOffer = await N.sendNotification({ groupId: ZZ, template: 'free_text_offer', channel: 'email', recipient: email, data });
  const eNote = await N.sendNotification({ groupId: ZZ, template: 'free_text_note', channel: 'email', recipient: email, data });
  made.logs.push(...[eOffer.notificationId, eNote.notificationId].filter(Boolean));
  const tok = async (id) => (await prisma.notificationLog.findUnique({ where: { id }, select: { unsubscribe_token: true } }))?.unsubscribe_token ?? null;
  check('an offer by email is rendered with its unsubscribe link (the sender refuses one without)', eOffer.skipCode === 'not_configured' && !!(await tok(eOffer.notificationId)),
    `${eOffer.skipCode} — past the sender's "no link, no send" check`);
  check('  …a note by email carries none', eNote.skipCode === 'not_configured' && (await tok(eNote.notificationId)) === null);
  check('  …because the offer template carries the footer and the note does not',
    T.NOTIFICATION_TEMPLATES.free_text_offer.email({ ...data, unsubscribeUrl: 'https://x.test/unsubscribe/y' }).html.includes('https://x.test/unsubscribe/y')
    && !/Unsubscribe|UNSUBSCRIBE/.test(T.NOTIFICATION_TEMPLATES.free_text_note.email(data).html));

  // ── 4. THE OLD MEANING STAYS ITS OWN ───────────────────────────────────────────────────────────
  console.log('\n— the messages sent before the question keep their own meaning —');
  const reg = T.NOTIFICATION_TEMPLATES;
  check('offer is marketing, note is not, and the old free_text is neither reclassified nor marketing',
    reg.free_text_offer.marketing === true && !reg.free_text_note.marketing && !reg.free_text.marketing && /before reminders and offers were declared/.test(reg.free_text.label), reg.free_text.label);
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(d, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [join(d, e.name)] : []);
  const senders = ['lib', 'pages', 'components'].flatMap(walk).filter((f) => keyRegex('template', "'free_text'").test(code(readFileSync(f, 'utf8'))));
  check('nothing sends the old free_text any more', senders.length === 0, senders.join(', ') || 'no `template: \'free_text\'` anywhere in lib, pages or components');
  check('  …and the scan can see one — the API\'s own new line is found by the same shape',
    keyRegex('template', /offer \? 'free_text_offer' : 'free_text_note'/).test(code(readFileSync('pages/api/messages/send.ts', 'utf8'))),
    'a search that reports none must first find a known case (verify-search-finds-known-case)');
  check('the old rows are untouched', (await prisma.notificationLog.count({ where: { template: 'free_text', created_at: { gte: new Date(Date.now() - 60_000) } } })) === 0,
    'no free_text row written in this run');

  // ── 5. THE TICK ────────────────────────────────────────────────────────────────────────────────
  console.log('\n— the compose box —');
  const cv = code(readFileSync('components/messages/ConversationView.tsx', 'utf8'));
  check('the tick starts UNTICKED, sends its answer on both routes, and resets after every send',
    /const \[offer, setOffer\] = useState\(false\);/.test(cv) && (cv.match(keyRegex('body', 'text, channel, offer }', 'g')) ?? []).length === 2
    && /setText\(''\); setOffer\(false\);/.test(cv) && /data-testid="compose-offer"/.test(cv),
    'each message is declared on its own, never inherited from the last');
} catch (e) {
  check('gate run completed', false, describeError(e));
} finally {
  try {
    if (made.cards.length) await prisma.jobCard.deleteMany({ where: { id: { in: made.cards } } });
    if (made.vehicles.length) await prisma.vehicle.deleteMany({ where: { id: { in: made.vehicles } } });
    await prisma.messageThread.deleteMany({ where: { customer_id: { in: made.customers } } });
    if (made.customers.length) await prisma.customer.deleteMany({ where: { id: { in: made.customers } } });
    await prisma.notificationLog.deleteMany({ where: { OR: [{ id: { in: made.logs } }, { recipient: { endsWith: MARK } }, { recipient: { startsWith: '4477005' }, group_id: ZZ }] } });
    check('teardown removed every fixture', (await prisma.customer.count({ where: { id: { in: made.customers } } })) === 0);
  } catch (e) { check('teardown completed', false, describeError(e)); }
  await prisma.$disconnect();
}
console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
process.exit(out.includes('F') ? 1 : 0);
