/**
 * File: scripts/contact-preferences-gate.mjs
 * A CUSTOMER'S CONTACT PREFERENCES MOVE THROUGH ONE WRITER, AND EVERY CHANGE LEAVES ITS RECORD.
 * @gate-requires: server, db
 *
 * Step 1 of the tenant unsubscribe (owner decision B, 2026-09-10): the separate marketing opt-out,
 * the ContactPreferenceEvent history, and lib/contact-preferences as the only writer. Nothing reads
 * the marketing columns and nothing sends a link yet — steps 3 and 4.
 *
 * ── WHAT IS PROVED, AND AGAINST WHAT ────────────────────────────────────────────────────────────
 *   1. The DATABASE refuses every wrong shape — one table of cases, each probed in its own rolled-
 *      back transaction — and the pure rule (lib/contact-preference-rules) gives the same answer for
 *      the same case. Two implementations of one rule, compared, so neither can drift alone.
 *   2. The writer, on a throwaway ZZ customer: a change records exactly one event; a no-op records
 *      none; a refusal never reaches the database (so it cannot poison the caller's transaction);
 *      another tenant's customer is never written; racing writers produce one event.
 *   3. The STAFF path, reached the way staff reach it: signed in as ZZ's owner, over HTTP, through
 *      /api/jobcard-details. The history names that user; a preference-only edit is still audited.
 *   4. THE CROSS-CHECK — the reason this gate can see a second writer at all. A source scan cannot:
 *      `select: { sms_opt_out: true }` and `data: { sms_opt_out: true }` look the same, and the old
 *      staff code wrote through a computed key (`next[k]`) that no scan sees. So instead every
 *      customer in the database is checked: each preference column must equal its latest event
 *      (NULL with none). A column moved by anything other than the writer disagrees with its
 *      history, however it was written — proved by writing one directly and watching it get caught.
 *
 * Fixtures are on ZZ, marked by the address domain @contact-preferences-gate.invalid and the vehicle
 * make ContactPrefGate — unique to this gate — and removed by their own ids. A killed run's leftovers
 * are swept at the next start, and one is PLANTED each run so the sweep is proved, not assumed
 * (teardown-will-not-run). AuditLog rows the API writes stay, as they always do.
 */
import './_gate-preflight.mjs';
import './_ts.mjs';
const { gatePrisma, describeError, gateOrigin, zzSite, ZZ_GROUP } = await import('./_gate-preflight.mjs');
const { randomUUID } = await import('node:crypto');
const { readFileSync } = await import('node:fs');
const R = await import('../lib/contact-preference-rules.ts');
const CP = await import('../lib/contact-preferences.ts');
const { keyRegex } = await import('../lib/anchored-match.ts');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const code = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const prisma = await gatePrisma();
const ZZ = ZZ_GROUP;
const MARK = '@contact-preferences-gate.invalid';
const MAKE = 'ContactPrefGate';
const B = gateOrigin();
const made = { customers: [], vehicles: [], cards: [] };
const uniq = () => randomUUID().slice(0, 8);

// ── 0. A KILLED EARLIER RUN'S FIXTURES GO FIRST — AND ONE IS PLANTED SO THAT IS PROVED ──────────
{
  const earlier = await prisma.customer.count({ where: { group_id: ZZ, email: { endsWith: MARK } } });
  const planted = await prisma.customer.create({ data: { group_id: ZZ, name: 'Planted leftover', email: `planted-${uniq()}${MARK}` }, select: { id: true } });
  await prisma.jobCard.deleteMany({ where: { group_id: ZZ, vehicle: { make: MAKE } } });
  await prisma.vehicle.deleteMany({ where: { group_id: ZZ, make: MAKE } });
  await prisma.customer.deleteMany({ where: { group_id: ZZ, email: { endsWith: MARK } } }); // events cascade
  const left = await prisma.customer.count({ where: { OR: [{ id: planted.id }, { group_id: ZZ, email: { endsWith: MARK } }] } });
  check('a killed run\'s fixtures are swept before this run makes its own', left === 0,
    `${earlier} from an earlier run, plus one planted exactly as a killed run leaves it — ${left === 0 ? 'none left' : `${left} STILL HERE`}`);
}

const newCustomer = async (label) => {
  const c = await prisma.customer.create({ data: { group_id: ZZ, name: `Pref Gate ${label}`, email: `${label}-${uniq()}${MARK}`, phone: '07700 900456', phone_e164: '447700900456' }, select: { id: true } });
  made.customers.push(c.id);
  return c.id;
};
const cols = (id) => prisma.customer.findUnique({ where: { id }, select: { sms_opt_out: true, email_opt_out: true, sms_marketing_opt_out: true, email_marketing_opt_out: true, opt_out_updated_at: true } });
const events = (id) => prisma.contactPreferenceEvent.findMany({ where: { customer_id: id }, orderBy: { seq: 'asc' } });
// A WRITER THAT THROWS IS A RED, NOT A CRASH. A crash ends the run, and the clauses after it — the
// cross-check among them — would never get the chance to say what they see.
const record = (c) => CP.recordContactPreference(c).catch((e) => ({ ok: false, refusal: `THREW ${describeError(e).slice(0, 90)}` }));

try {
  const logRow = await prisma.notificationLog.findFirst({ where: { group_id: ZZ }, select: { id: true } });
  const zzOwner = await prisma.user.findFirst({ where: { group_id: ZZ, email: 'owner@zzgategarage.test' }, select: { id: true } });
  check('the gate has a ZZ message to cite and ZZ\'s owner to act as', !!logRow && !!zzOwner,
    'a link or carrier change must name a real message; a staff change a real user');

  // ── 1. THE DATABASE REFUSES EVERY WRONG SHAPE, AND THE PURE RULE AGREES ───────────────────────
  console.log('\n— the database refuses every wrong shape, and the pure rule gives the same answer —');
  const probeCust = await newCustomer('probe');
  const S = (o) => ({ channel: 'email', scope: 'marketing', via: 'staff', previous: null, optedOut: true, reason: null, actorUserId: zzOwner.id, notificationLogId: null, ...o });
  const L = { actorUserId: null, notificationLogId: logRow.id };
  const CASES = [
    ['a staff opt-out of marketing, no reason needed', S({}), null],
    ['a staff opt-in to marketing WITH a reason', S({ previous: true, optedOut: false, reason: 'Asked at the counter for reminders again' }), null],
    ['the customer\'s link opting out of marketing', S({ via: 'customer_link', ...L }), null],
    ['a carrier STOP on all texts', S({ via: 'carrier_stop', channel: 'sms', scope: 'all', ...L }), null],
    ['staff unticking "no email at all" back to no record', S({ scope: 'all', previous: true, optedOut: null }), null],
    ['a channel that does not exist', S({ channel: 'fax' }), 'ContactPreferenceEvent_channel_chk'],
    ['a scope that does not exist', S({ scope: 'everything' }), 'ContactPreferenceEvent_scope_chk'],
    // ONE RULE BROKEN PER CASE. The first version gave the robot a staff member too, broke two
    // constraints, and Postgres named the other one — the case proved nothing about _via_chk.
    ['an author that does not exist', S({ via: 'robot', ...L }), 'ContactPreferenceEvent_via_chk'],
    ['a staff change naming no staff member', S({ actorUserId: null }), 'ContactPreferenceEvent_actor_chk'],
    ['a staff change citing a message', S({ notificationLogId: logRow.id }), 'ContactPreferenceEvent_message_chk'],
    ['a link change citing no message', S({ via: 'customer_link', actorUserId: null }), 'ContactPreferenceEvent_message_chk'],
    ['a link change naming a staff member', S({ via: 'customer_link', notificationLogId: logRow.id }), 'ContactPreferenceEvent_actor_chk'],
    ['a link OPTING IN to marketing', S({ via: 'customer_link', ...L, previous: true, optedOut: false }), 'ContactPreferenceEvent_source_chk'],
    ['a link stopping EVERYTHING', S({ via: 'customer_link', ...L, scope: 'all' }), 'ContactPreferenceEvent_source_chk'],
    ['a carrier STOP on email', S({ via: 'carrier_stop', ...L, scope: 'all' }), 'ContactPreferenceEvent_source_chk'],
    ['a carrier STOP on marketing only', S({ via: 'carrier_stop', ...L, channel: 'sms' }), 'ContactPreferenceEvent_source_chk'],
    ['marketing returned to no record', S({ previous: true, optedOut: null }), 'ContactPreferenceEvent_marketing_definite_chk'],
    ['a staff opt-in to marketing with NO reason', S({ previous: true, optedOut: false }), 'ContactPreferenceEvent_optin_reason_chk'],
    ['  …or a reason of only spaces', S({ previous: true, optedOut: false, reason: '   ' }), 'ContactPreferenceEvent_optin_reason_chk'],
    ['a reason longer than 500 characters', S({ reason: 'x'.repeat(501) }), 'ContactPreferenceEvent_reason_chk'],
    ['an "event" that changes nothing', S({ previous: true, optedOut: true }), 'ContactPreferenceEvent_change_chk'],
  ];
  // ONE PROBE PER TRANSACTION, each rolled back — a caught violation poisons the transaction it is in.
  const probe = (c) => prisma.$transaction(async (tx) => {
    try {
      await tx.$executeRawUnsafe(`INSERT INTO "ContactPreferenceEvent" (id, group_id, customer_id, channel, scope, previous, opted_out, via, reason, actor_user_id, notification_log_id)
        VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        ZZ, probeCust, c.channel, c.scope, c.previous, c.optedOut, c.via, c.reason, c.actorUserId, c.notificationLogId);
    } catch (e) { throw new Error(`ROLLBACK refused ${((e.meta?.message ?? e.message).match(/ContactPreferenceEvent_\w+/) ?? ['(no constraint named)'])[0]}`); }
    throw new Error('ROLLBACK accepted');
  }).catch((e) => String(e.message));
  let dbRight = 0, agree = 0; const wrong = [];
  for (const [name, c, expect] of CASES) {
    const got = await probe(c);
    const dbOk = expect === null ? got === 'ROLLBACK accepted' : got === `ROLLBACK refused ${expect}`;
    if (dbOk) dbRight++; else wrong.push(`${name}: expected ${expect ?? 'accepted'}, got ${got}`);
    // The pure rule mirrors every CHECK except _change_chk, which the writer meets by recording nothing.
    if (expect !== 'ContactPreferenceEvent_change_chk') {
      const pure = R.preferenceRefusal(c);
      if ((pure === null) === (expect === null)) agree++; else wrong.push(`${name}: pure rule said ${pure ?? 'accept'}, database ${expect ?? 'accepted'}`);
    }
  }
  const pureCases = CASES.filter(([, , e]) => e !== 'ContactPreferenceEvent_change_chk').length;
  check(`the database accepts the ${CASES.filter(([, , e]) => e === null).length} right shapes and refuses each wrong one BY NAME`, dbRight === CASES.length,
    wrong.length ? wrong.join(' | ') : `${CASES.length} cases, each probed in its own rolled-back transaction`);
  check('  …and the pure rule gives the same answer on every one', agree === pureCases, `${agree} of ${pureCases}`);
  // The message a piece of consent evidence points at cannot be deleted from under it.
  const heldMessage = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`INSERT INTO "ContactPreferenceEvent" (id, group_id, customer_id, channel, scope, previous, opted_out, via, notification_log_id)
      VALUES (gen_random_uuid()::text, $1, $2, 'email', 'marketing', NULL, true, 'customer_link', $3)`, ZZ, probeCust, logRow.id);
    try { await tx.$executeRawUnsafe(`DELETE FROM "NotificationLog" WHERE id = $1`, logRow.id); }
    catch (e) { throw new Error(`ROLLBACK refused ${((e.meta?.message ?? e.message).match(/ContactPreferenceEvent_\w+/) ?? ['?'])[0]}`); }
    throw new Error('ROLLBACK deleted');
  }).catch((e) => String(e.message));
  check('the message a link change cites cannot be deleted from under it', heldMessage === 'ROLLBACK refused ContactPreferenceEvent_notification_log_id_fkey',
    `${heldMessage} — rolled back; the consent evidence keeps what it points at`);

  // ── 2. THE WRITER ─────────────────────────────────────────────────────────────────────────────
  console.log('\n— the one writer, on a throwaway customer —');
  const cust = await newCustomer('writer');
  const staff = (o) => ({ groupId: ZZ, customerId: cust, channel: 'email', scope: 'marketing', via: 'staff', actorUserId: zzOwner.id, ...o });
  const w1 = await record(staff({ optedOut: true }));
  const c1 = await cols(cust); const e1 = await events(cust);
  check('a staff opt-out of marketing email moves the column', w1.ok && w1.changed && c1.email_marketing_opt_out === true, JSON.stringify(w1));
  check('  …and records exactly one event, saying who and from what', e1.length === 1 && e1[0].previous === null && e1[0].opted_out === true
    && e1[0].via === 'staff' && e1[0].actor_user_id === zzOwner.id && e1[0].notification_log_id === null && e1[0].scope === 'marketing' && e1[0].channel === 'email',
    e1[0] ? `${e1[0].previous} → ${e1[0].opted_out}, by ${e1[0].via} ${e1[0].actor_user_id?.slice(0, 8)}` : 'no event');
  check('  …in the customer\'s own tenant', e1[0]?.group_id === ZZ);
  check('  …and it did NOT touch "no email at all"', c1.email_opt_out === null && c1.sms_opt_out === null,
    'the whole point of B: a marketing opt-out never stops a quote or an invoice');
  const stamp1 = c1.opt_out_updated_at?.getTime();
  const w2 = await record(staff({ optedOut: true }));
  const c2 = await cols(cust);
  check('the same change again records NOTHING', w2.ok && w2.changed === false && (await events(cust)).length === 1 && c2.opt_out_updated_at?.getTime() === stamp1,
    'an event is a change; the timestamp does not move on a no-op either');
  const w3 = await record(staff({ optedOut: false }));
  check('a staff opt-in with no reason is REFUSED by the writer', !w3.ok && w3.refusal === 'optin_needs_a_reason'
    && (await cols(cust)).email_marketing_opt_out === true && (await events(cust)).length === 1, JSON.stringify(w3));
  // THE POISONED-TRANSACTION FACT: the refusal must never reach the database, because the staff
  // form's transaction carries the customer's other edits. Refuse, then write, in ONE transaction.
  const sameTx = await prisma.$transaction(async (tx) => {
    const refused = await CP.setContactPreference(tx, staff({ optedOut: false }));
    const after = await CP.setContactPreference(tx, staff({ channel: 'sms', optedOut: true }));
    return { refused, after };
  }).catch((e) => ({ error: describeError(e) }));
  check('  …in code, before the database — the same transaction goes on working', !sameTx.error && !sameTx.refused.ok && sameTx.after.ok && sameTx.after.changed,
    sameTx.error ?? 'refused, then a valid change committed in the same transaction');
  const w5 = await record(staff({ optedOut: false, reason: '   Asked at the counter for MOT reminders again  ' }));
  const e5 = (await events(cust)).at(-1);
  check('an opt-in WITH a reason is recorded, the reason trimmed', w5.ok && w5.changed && (await cols(cust)).email_marketing_opt_out === false
    && e5?.reason === 'Asked at the counter for MOT reminders again' && e5?.previous === true, e5?.reason ?? 'no event');
  const w6 = await record({ groupId: ZZ, customerId: cust, channel: 'email', scope: 'marketing', optedOut: true, via: 'customer_link', notificationLogId: logRow.id });
  const e6 = (await events(cust)).at(-1);
  check('the customer\'s own link opts out of marketing, citing its message', w6.ok && e6?.via === 'customer_link' && e6?.notification_log_id === logRow.id && e6?.actor_user_id === null);
  const w7 = await record({ groupId: ZZ, customerId: cust, channel: 'sms', scope: 'all', optedOut: true, via: 'carrier_stop', notificationLogId: logRow.id });
  const c7 = await cols(cust);
  check('a carrier STOP stops ALL texts', w7.ok && c7.sms_opt_out === true && (await events(cust)).at(-1)?.scope === 'all');
  check('  …and nothing yet has touched "no email at all"', c7.email_opt_out === null, 'four changes to three columns; the fourth never moved');
  const before8 = (await events(cust)).length;
  const w8 = await record(staff({ groupId: randomUUID(), optedOut: false, reason: 'x' }));
  check('another tenant\'s claim on this customer writes NOTHING', !w8.ok && w8.refusal === 'not_found' && (await events(cust)).length === before8,
    'the customer is looked up within the caller\'s tenant; outside it, it does not exist');
  // RACING WRITERS, FORCED — NOT HOPED FOR. The first version fired two writers with Promise.all and
  // they never overlapped: the second began after the first had committed, so removing the pre-state
  // condition (the thing this exists to test) left it GREEN. Now the overlap is constructed:
  //   A writes and holds its transaction open; B starts, reads the COMMITTED value (still "no
  //   record"), and blocks on A's row lock at its update — which the gate WAITS FOR by watching
  //   pg_stat_activity, a condition, never a sleep; only then does A commit.
  // With the condition, B's update finds the value moved, re-reads, and records nothing. Without it,
  // B writes a second event claiming a `previous` the column no longer held.
  const racer = await newCustomer('race');
  const change = { groupId: ZZ, customerId: racer, channel: 'email', scope: 'marketing', optedOut: true, via: 'staff', actorUserId: zzOwner.id };
  let releaseA, aWrote;
  const aHeld = new Promise((r) => { releaseA = r; });
  const aDone = new Promise((r) => { aWrote = r; });
  const txA = prisma.$transaction(async (tx) => { const r = await CP.setContactPreference(tx, change); aWrote(r); await aHeld; return r; }, { timeout: 60000 })
    .catch((e) => ({ ok: false, refusal: `THREW ${describeError(e).slice(0, 80)}` }));
  await aDone;
  const txB = record(change);
  const blockedBy = Date.now() + 30000;
  let blocked = false;
  while (!blocked && Date.now() < blockedBy) {
    const w = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE 'UPDATE %Customer%'`);
    blocked = w[0].n > 0;
  }
  releaseA();
  const race = [await txA, await txB];
  const raceEvents = await events(racer);
  check('B really was waiting on A when A committed', blocked,
    blocked ? 'seen in pg_stat_activity: a Customer UPDATE waiting on a lock' : 'B never blocked within 30s — the clause below would prove nothing');
  check('two writers racing to record one change produce ONE event', raceEvents.length === 1 && race.every((r) => r.ok) && race.filter((r) => r.changed).length === 1,
    `${raceEvents.length} event(s); ${race.map((r) => (r.ok ? (r.changed ? 'changed' : 'no-op') : r.refusal)).join(' + ')}`);

  // ── 3. THE STAFF PATH, AS STAFF REACH IT ──────────────────────────────────────────────────────
  console.log('\n— the staff form reaches the writer —');
  const site = await zzSite(prisma);
  const owned = await newCustomer('staff');
  const veh = await prisma.vehicle.create({ data: { group_id: ZZ, registration: `CP${uniq().toUpperCase().slice(0, 5)}`, make: MAKE, model: 'Fixture' }, select: { id: true } });
  made.vehicles.push(veh.id);
  await prisma.vehicleOwnership.create({ data: { vehicle_id: veh.id, customer_id: owned, is_current: true } });
  const card = await prisma.jobCard.create({ data: { group_id: ZZ, site_id: site.id, vehicle_id: veh.id, status: 'draft' }, select: { id: true } });
  made.cards.push(card.id);
  const csrfRes = await fetch(`${B}/api/auth/csrf`);
  const csrfToken = (await csrfRes.json()).csrfToken;
  const csrfCookie = (csrfRes.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const cred = await fetch(`${B}/api/auth/callback/credentials`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', cookie: csrfCookie },
    body: new URLSearchParams({ email: 'owner@zzgategarage.test', password: 'GateGarage!2026', csrfToken, json: 'true' }),
  });
  const session = /next-auth\.session-token=[^;]+/.exec((cred.headers.getSetCookie?.() ?? []).join('; '))?.[0] ?? null;
  check('signed in as ZZ\'s owner', !!session, `HTTP ${cred.status}`);
  const save = (owner) => fetch(`${B}/api/jobcard-details`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: session ?? '' },
    body: JSON.stringify({ jobCardId: card.id, owner, source: 'details-form' }) });
  const auditsBefore = await prisma.auditLog.count({ where: { group_id: ZZ, action: 'owner.edited', entity_id: card.id } });
  const s1 = await save({ sms_opt_out: true });
  const se1 = await events(owned);
  check('ticking "no texts" in the staff form records it through the writer', s1.status === 200 && (await cols(owned)).sms_opt_out === true
    && se1.length === 1 && se1[0].via === 'staff' && se1[0].actor_user_id === zzOwner.id && se1[0].scope === 'all' && se1[0].channel === 'sms',
    `HTTP ${s1.status}; ${se1.length} event(s), by ${se1[0]?.actor_user_id === zzOwner.id ? 'the signed-in owner' : se1[0]?.actor_user_id}`);
  const s2 = await save({ sms_opt_out: null });
  const se2 = await events(owned);
  check('  …and unticking it records the return to NO RECORD', s2.status === 200 && (await cols(owned)).sms_opt_out === null
    && se2.length === 2 && se2[1].previous === true && se2[1].opted_out === null, `${se2.length} event(s)`);
  const audits = await prisma.auditLog.findMany({ where: { group_id: ZZ, action: 'owner.edited', entity_id: card.id }, select: { diff_json: true } });
  check('a preference-only edit is still AUDITED as an owner edit', audits.length - auditsBefore === 2 && audits.every((a) => JSON.stringify(a.diff_json).includes('sms_opt_out')),
    `${audits.length - auditsBefore} owner.edited row(s) — moving the write out of \`next\` must not drop the audit`);

  // ── 4. THE CROSS-CHECK: EVERY COLUMN EQUALS ITS HISTORY ───────────────────────────────────────
  console.log('\n— every customer\'s preferences equal their history —');
  const disagreeing = () => prisma.$queryRawUnsafe(`
    WITH latest AS (
      SELECT DISTINCT ON (customer_id, channel, scope) customer_id, channel, scope, opted_out
      FROM "ContactPreferenceEvent" ORDER BY customer_id, channel, scope, seq DESC)
    SELECT c.id, c.group_id, v.channel, v.scope, v.colval, l.opted_out AS history
    FROM "Customer" c
    CROSS JOIN LATERAL (VALUES ('email', 'all', c.email_opt_out), ('sms', 'all', c.sms_opt_out),
                               ('email', 'marketing', c.email_marketing_opt_out), ('sms', 'marketing', c.sms_marketing_opt_out)) AS v(channel, scope, colval)
    LEFT JOIN latest l ON l.customer_id = c.id AND l.channel = v.channel AND l.scope = v.scope
    WHERE v.colval IS DISTINCT FROM l.opted_out`);
  const everyone = await prisma.customer.count();
  const bad = await disagreeing();
  check('every customer in the database agrees with their history', bad.length === 0,
    bad.length ? bad.slice(0, 5).map((b) => `${b.id.slice(0, 8)} ${b.channel}/${b.scope}: column ${b.colval}, history ${b.history}`).join(' | ') : `${everyone} customers, all tenants, read-only`);
  // THE POSITIVE CASE: a second writer — here, a direct update, the shape notify-scope-gate uses on
  // its fixture — must be CAUGHT. Otherwise "no disagreement" is also what a blind check reports.
  await prisma.customer.update({ where: { id: cust }, data: { email_opt_out: true } });
  const caught = (await disagreeing()).filter((b) => b.id === cust);
  check('  …and a column moved WITHOUT the writer is caught', caught.length === 1 && caught[0].channel === 'email' && caught[0].scope === 'all',
    caught.length ? `email/all: column true, history ${caught[0].history} — found however it was written` : 'NOT caught');
  await prisma.customer.update({ where: { id: cust }, data: { email_opt_out: null } });
  check('  …and agrees again once it is put back', (await disagreeing()).filter((b) => b.id === cust).length === 0);

  // ── 5. THE STAFF API NO LONGER WRITES THE COLUMNS ITSELF ──────────────────────────────────────
  const api = code(readFileSync('pages/api/jobcard-details.ts', 'utf8'));
  check('the staff API hands preferences to the writer, not to its own update',
    /setContactPreference\(tx, \{/.test(api) && !/next\[k\] = norm/.test(api) && keyRegex('via', "'staff', actorUserId: user.id as string").test(api),
    'the old `next[k] = norm` is exactly the computed-key write no scan could see; the cross-check above is what would see its return');
} catch (e) {
  check('gate run completed', false, describeError(e));
} finally {
  try {
    if (made.cards.length) await prisma.jobCard.deleteMany({ where: { id: { in: made.cards } } });
    if (made.vehicles.length) await prisma.vehicle.deleteMany({ where: { id: { in: made.vehicles } } });
    if (made.customers.length) await prisma.customer.deleteMany({ where: { id: { in: made.customers } } });
    const left = await prisma.customer.count({ where: { id: { in: made.customers } } })
      + await prisma.contactPreferenceEvent.count({ where: { customer_id: { in: made.customers } } });
    check('teardown removed every fixture, and their history with them', left === 0, `${made.customers.length} customers, ${made.cards.length} card(s)`);
  } catch (e) { check('teardown completed', false, describeError(e)); }
  await prisma.$disconnect();
}

console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
process.exit(out.includes('F') ? 1 : 0);
