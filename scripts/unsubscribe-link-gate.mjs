/**
 * File: scripts/unsubscribe-link-gate.mjs
 * A GARAGE'S CUSTOMER CAN STOP ITS REMINDERS AND OFFERS THEMSELVES — AND STILL GETS THEIR INVOICE.
 * @gate-requires: server, db
 *
 * Step 4 of the tenant unsubscribe (owner decision B): the token on the send row, the footer, the
 * RFC 8058 headers, the page and the one-click POST.
 *
 * ── THE CLAUSE THAT MATTERS, AGAIN ──────────────────────────────────────────────────────────────
 * After the customer unsubscribes, a QUOTE and an INVOICE still reach them — asserted in the SAME
 * run as the refusal that follows it. An unsubscribe that stopped everything would pass every other
 * clause here (marketing-optout-gate's S2 is the proof that this happens, not a hypothesis).
 *
 * ── HOW A SEND IS SEEN WITHOUT BEING MADE ───────────────────────────────────────────────────────
 * No provider in this process: an allowed send is rendered — token and all — and stops at
 * `not_configured`; a refused one stops earlier with its own code. The token is minted before
 * rendering, so the real minting path is driven, not a copy of it.
 *
 * NOT DRIVEN: a real mail client's one-click and the real headers on the wire (no provider). The
 * header VALUES are asserted from the one builder the sender uses; the POST they point at is driven
 * for real, in exactly the RFC 8058 shape.
 *
 * Fixtures: ZZ, and one customer on ZZUS (US-GD2175) holding the same address, all marked by the
 * domain @unsubscribe-link-gate.invalid and the vehicle make UnsubGate; swept first, one planted.
 */
import './_gate-preflight.mjs';
import './_ts.mjs';
process.env.RESEND_API_KEY = '';
const { gatePrisma, describeError, declineToRun, gateOrigin, erOrigin, repOrigin, ZZ_GROUP } = await import('./_gate-preflight.mjs');
const { randomUUID } = await import('node:crypto');
const { readFileSync } = await import('node:fs');
const http = await import('node:http');
const N = await import('../lib/notify.ts');
const T = await import('../lib/notification-templates.ts');
const U = await import('../lib/unsubscribe-links.ts');
if (N.channelConfigured('email') || N.channelConfigured('sms')) declineToRun('a message provider is configured in this process — refusing to run a gate that sends to fixtures');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const code = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const prisma = await gatePrisma();
const ZZ = ZZ_GROUP;
const MARK = '@unsubscribe-link-gate.invalid';
const MAKE = 'UnsubGate';
const B = gateOrigin();
const made = { customers: [], vehicles: [], logs: [] };
const uniq = () => randomUUID().slice(0, 8);

{
  const planted = await prisma.customer.create({ data: { group_id: ZZ, name: 'Planted leftover', email: `planted-${uniq()}${MARK}` }, select: { id: true } });
  await prisma.customer.deleteMany({ where: { email: { endsWith: MARK } } }); // first: events cite the messages
  await prisma.vehicle.deleteMany({ where: { group_id: ZZ, make: MAKE } });
  await prisma.notificationLog.deleteMany({ where: { OR: [{ recipient: { endsWith: MARK } }, { recipient: { startsWith: '4477006' } }] } });
  check('a killed run\'s fixtures are swept first', (await prisma.customer.count({ where: { OR: [{ id: planted.id }, { email: { endsWith: MARK } }] } })) === 0);
}

/** A request with an explicit Host, the way rep-host-gate asks each host. */
const ask = (host, path, method = 'GET') => new Promise((resolve) => {
  const u = new URL(B);
  const r = http.request({ hostname: u.hostname, port: u.port, path, method, headers: { Host: `${host}:${u.port}` } }, (res) => {
    let body = ''; res.on('data', (d) => { body += d; }); res.on('end', () => resolve({ status: res.statusCode, body }));
  });
  r.on('error', (e) => resolve({ status: 0, body: String(e) })); r.end();
});
const visibleText = (html) => html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&');

try {
  const zzus = await prisma.group.findUnique({ where: { ref: 'US-GD2175' }, select: { id: true } });
  const zz = await prisma.group.findUnique({ where: { id: ZZ }, select: { group_name: true, trading_name: true } });
  const garage = zz.trading_name || zz.group_name;
  const email = `dana-${uniq()}${MARK}`;
  const mobile = `4477006${String(Math.floor(Math.random() * 1e5)).padStart(5, '0')}`;
  check('the fixture address belongs to nobody else', (await prisma.customer.count({ where: { OR: [{ email: { equals: email, mode: 'insensitive' } }, { phone_e164: mobile }] } })) === 0);
  const cust = async (group, label, extra = {}) => { const c = await prisma.customer.create({ data: { group_id: group, name: `Unsub ${label}`, email, ...extra }, select: { id: true } }); made.customers.push(c.id); return c.id; };
  const dana = await cust(ZZ, 'Dana', { phone: mobile, phone_e164: mobile });
  const household = await cust(ZZ, 'household');                 // a second ZZ customer on the SAME address
  const elsewhere = zzus ? await cust(zzus.id, 'elsewhere') : null; // ANOTHER garage, the same address
  const veh = (await prisma.vehicle.create({ data: { group_id: ZZ, registration: `UN${uniq().toUpperCase().slice(0, 5)}`, make: MAKE, model: 'Fixture', mot_expiry: new Date(Date.now() + 9 * 86_400_000) }, select: { id: true } })).id;
  made.vehicles.push(veh);
  await prisma.vehicleOwnership.create({ data: { vehicle_id: veh, customer_id: dana, is_current: true } });

  const data = { garageName: garage, garagePhone: '01384 000000', customerName: 'Dana', registration: 'UN12 GTE', vehicleDesc: 'Fixture', expiryDate: '20 September 2026', link: 'https://greasedesk.com/c/x', total: '£100.00', expiryDays: 14 };
  const send = async (template, channel, recipient) => {
    const r = await N.sendNotification({ groupId: ZZ, template, channel, recipient, data });
    if (r.notificationId) made.logs.push(r.notificationId);
    return r;
  };
  const tokenOf = async (id) => (await prisma.notificationLog.findUnique({ where: { id }, select: { unsubscribe_token: true } }))?.unsubscribe_token ?? null;

  // ── 1. WHICH MESSAGES CARRY A WAY OUT ──────────────────────────────────────────────────────────
  console.log('\n— every marketing email carries a way out, and nothing else does —');
  const reminder = await send('mot_due', 'email', email);
  const token = await tokenOf(reminder.notificationId);
  check('an MOT reminder email is rendered with an unsubscribe token on its own send row', reminder.skipCode === 'not_configured' && !!token && U.UNSUBSCRIBE_TOKEN.test(token),
    `${reminder.skipCode}; token ${token ? `${token.length} chars` : 'MISSING'}`);
  const again = await send('mot_expired', 'email', email);
  const token2 = await tokenOf(again.notificationId);
  check('  …and every marketing email gets its OWN token', !!token2 && token2 !== token);
  const quote = await send('quote_ready', 'email', email);
  const textReminder = await send('mot_due', 'sms', mobile);
  check('a QUOTE email carries none', (await tokenOf(quote.notificationId)) === null, 'service mail is not marketing, and offers no way out of marketing it is not');
  check('  …nor does a text (its way out is the owner\'s decision, held)', (await tokenOf(textReminder.notificationId)) === null);

  const links = U.unsubscribeLinks(token);
  const html = T.NOTIFICATION_TEMPLATES.mot_due.email({ ...data, unsubscribeUrl: links.page }).html;
  check('the footer carries the link, names the garage, and says quotes and invoices still reach them',
    html.includes(links.page) && html.includes(garage.replace(/&/g, '&amp;')) && /quotes and invoices will still reach you/.test(html), links.page);
  check('  …on the EXPIRED reminder too', T.NOTIFICATION_TEMPLATES.mot_expired.email({ ...data, unsubscribeUrl: links.page }).html.includes(links.page));
  const noLink = T.NOTIFICATION_TEMPLATES.mot_due.email(data).html;
  check('a footer with NO link shows a visible fault — it never quietly leaves itself out', /UNSUBSCRIBE LINK MISSING/.test(noLink));
  const hdr = U.unsubscribeHeaders(links);
  check('the mail headers are RFC 8058\'s, pointing at the one-click endpoint',
    hdr['List-Unsubscribe'] === `<${links.oneClick}>` && hdr['List-Unsubscribe-Post'] === 'List-Unsubscribe=One-Click', hdr['List-Unsubscribe']);
  const notify = code(readFileSync('lib/notify.ts', 'utf8'));
  check('  …and the sender puts the link in the body AND the headers, and refuses a marketing email without it',
    /renderData = \{ \.\.\.renderData, unsubscribeUrl: links\.page \};/.test(notify) && /\.\.\.unsubscribeHeaders\(links\)/.test(notify)
    && /adapter\.send\(args\.recipient, \{ subject, body \}, emailOpts\)/.test(notify) && /if \(unsubscribeUrl && !body\.includes\(unsubscribeUrl\)\)/.test(notify));

  // ── 2. OPENING THE LINK DOES NOTHING ───────────────────────────────────────────────────────────
  console.log('\n— opening the link does nothing; the page speaks for the garage —');
  const prefs = (id) => prisma.customer.findUnique({ where: { id }, select: { email_opt_out: true, email_marketing_opt_out: true, sms_opt_out: true, sms_marketing_opt_out: true } });
  const events = (id) => prisma.contactPreferenceEvent.findMany({ where: { customer_id: id }, orderBy: { seq: 'asc' } });
  const page = await fetch(links.page.replace(/^https?:\/\/[^/]+/, B));
  const pageHtml = await page.text();
  const head = await fetch(links.page.replace(/^https?:\/\/[^/]+/, B), { method: 'HEAD' });
  check('the page opens, offering a button', page.status === 200 && /data-testid="unsubscribe-ready"/.test(pageHtml) && /data-testid="unsubscribe-confirm"/.test(pageHtml), `HTTP ${page.status}`);
  check('  …and OPENING it (and a HEAD, as a link previewer does) changed nothing', head.status < 500 && (await prefs(dana)).email_marketing_opt_out === null && (await events(dana)).length === 0,
    'mail scanners follow every link in an email');
  check('  …it names the GARAGE', visibleText(pageHtml).includes(garage), garage);
  check('  …and never GreaseDesk', !/greasedesk/i.test(visibleText(pageHtml)), 'the customer\'s relationship is with their garage');
  check('  …and never the address — not in the page, and not in its data', !pageHtml.toLowerCase().includes(email.toLowerCase()) && !pageHtml.includes(mobile),
    'a forwarded email must not tell its holder whose address it was');
  check('the endpoint refuses GET', (await fetch(`${B}/api/unsubscribe?t=${token}`)).status === 405 && (await events(dana)).length === 0);
  const ghost = 'A'.repeat(32);
  const unknownPage = await fetch(`${B}/unsubscribe/${ghost}`);
  check('a link we never sent is not recognised, and says so', unknownPage.status === 404 && /unsubscribe-unknown/.test(await unknownPage.text())
    && (await fetch(`${B}/api/unsubscribe?t=${ghost}`, { method: 'POST' })).status === 404);
  check('the other hosts do not serve it', (await ask(new URL(erOrigin()).hostname, `/unsubscribe/${token}`)).status === 404 && (await ask(new URL(repOrigin()).hostname, `/unsubscribe/${token}`)).status === 404,
    'the Engine Room and the rep portal are not where a garage\'s customer lands');

  // ── 3. THE ACT ─────────────────────────────────────────────────────────────────────────────────
  console.log('\n— the one-click POST stops reminders and offers, once —');
  // redirect: 'manual' — a mail client does not follow a redirect to a web page; the first version
  // followed it, landed on the page's 200, and passed a one-click that had been handled as a button.
  const oneClick = () => fetch(links.oneClick.replace(/^https?:\/\/[^/]+/, B), { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
  const p1 = await oneClick();
  const p1body = await p1.text();
  const [d1, h1] = await Promise.all([prefs(dana), prefs(household)]);
  check('a mail client\'s one-click POST (RFC 8058) is answered 200 itself — not sent to a web page', p1.status === 200 && p1body === 'Unsubscribed.',
    `HTTP ${p1.status} "${p1body.slice(0, 30)}"`);
  check('  …and marks "no reminders or offers by EMAIL" on the customer', d1.email_marketing_opt_out === true);
  check('  …and on everyone in that garage at the same address', h1.email_marketing_opt_out === true, 'the send path refuses on any row holding the address; the record must agree');
  const [ed, eh] = await Promise.all([events(dana), events(household)]);
  check('  …each through the one writer, as the customer\'s own act, citing the email it came in',
    [ed, eh].every((e) => e.length === 1 && e[0].via === 'customer_link' && e[0].scope === 'marketing' && e[0].channel === 'email'
      && e[0].notification_log_id === reminder.notificationId && e[0].actor_user_id === null));
  check('  …and NOTHING ELSE moved: not "no email at all", not texts', d1.email_opt_out === null && d1.sms_opt_out === null && d1.sms_marketing_opt_out === null && h1.email_opt_out === null);
  if (elsewhere) check('ANOTHER GARAGE\'s customer at the same address is untouched', (await prefs(elsewhere)).email_marketing_opt_out === null && (await events(elsewhere)).length === 0,
    'the link came from ZZ; their relationship with the other garage is their own');
  const p2 = await oneClick();
  const fromPage = await fetch(`${B}/api/unsubscribe?t=${encodeURIComponent(token)}`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: '' });
  check('repeating it — the mail client again, then the page\'s button — is harmless', p2.status === 200 && (await events(dana)).length === 1 && (await events(household)).length === 1,
    `${(await events(dana)).length} event(s) after three posts`);
  check('  …and the button lands back on the page', fromPage.status === 303 && fromPage.headers.get('location') === `/unsubscribe/${token}`, `${fromPage.status} → ${fromPage.headers.get('location')}`);
  const donePage = await (await fetch(links.page.replace(/^https?:\/\/[^/]+/, B))).text();
  check('  …which now says it is done, and still names the garage and not the address', /data-testid="unsubscribe-done"/.test(donePage) && visibleText(donePage).includes(garage) && !donePage.toLowerCase().includes(email.toLowerCase()));

  // ── 4. THE CLAUSE THAT MATTERS, IN THE SAME RUN ────────────────────────────────────────────────
  console.log('\n— and in the SAME run: their quote and their invoice still reach them —');
  const after = await Promise.all([send('quote_ready', 'email', email), send('invoice_document', 'email', email)]);
  check('a QUOTE and an INVOICE still reach the customer who unsubscribed', after.every((r) => r.skipCode === 'not_configured'),
    after.map((r) => r.skipCode).join(' / ') + ' — reached the provider stage, not refused');
  const refused = await send('mot_due', 'email', email);
  check('  …while the next REMINDER is refused, as their own choice', refused.skipCode === 'opted_out_marketing', refused.skipCode);
  check('  …and the link from an email did not stop their texts', (await send('mot_due', 'sms', mobile)).skipCode === 'not_configured',
    'it answered for the channel it came in on');

  const mm = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "Customer" c WHERE c.id = ANY($1::text[]) AND contact_preference_mismatch(c.id) IS NOT NULL`, made.customers);
  check('every fixture customer agrees with its history', mm[0].n === 0);
} catch (e) {
  check('gate run completed', false, describeError(e));
} finally {
  try {
    if (made.customers.length) await prisma.customer.deleteMany({ where: { id: { in: made.customers } } }); // first: events cite messages (NO ACTION)
    if (made.vehicles.length) await prisma.vehicle.deleteMany({ where: { id: { in: made.vehicles } } });
    if (made.logs.length) await prisma.notificationLog.deleteMany({ where: { id: { in: made.logs } } });
    const left = await prisma.customer.count({ where: { id: { in: made.customers } } }) + await prisma.notificationLog.count({ where: { id: { in: made.logs } } });
    check('teardown removed every fixture, history with it', left === 0, `${made.customers.length} customers, ${made.logs.length} messages`);
  } catch (e) { check('teardown completed', false, describeError(e)); }
  await prisma.$disconnect();
}
console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
process.exit(out.includes('F') ? 1 : 0);
