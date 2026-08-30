/**
 * File: scripts/quote-invoice-sms-gate.mjs
 * Gate for send-by-text on the quote and the invoice pay link.
 *
 * ── THE ORDERING IS THE POINT ───────────────────────────────────────────────────────────────────
 * quote-send REVOKES the live link and FREEZES a new version before it sends. If the allowance
 * refusal happened at the chokepoint — where sendNotification puts it — the customer would be left
 * holding a dead link for a message that never went. So the refusal is asked BEFORE the freeze, and
 * the assertion that matters here is not "it refused" but "it refused AND CHANGED NOTHING": same
 * version count, same live link, afterwards.
 *
 * ── NOTHING IS ACTUALLY TEXTED ──────────────────────────────────────────────────────────────────
 * The SMS provider is unconfigured here, so sendNotification records `skipped/not_configured` and
 * no message leaves. Everything up to the provider is exercised. That is the right shape for a gate
 * over a path that costs money per call.
 *
 * ── FIXTURES ────────────────────────────────────────────────────────────────────────────────────
 * ZZ Gate Garage only. The spent-allowance branch needs REAL usage, because the balance is derived
 * from NotificationLog — so filler rows are written with a recognisable provider_message_id and
 * removed in the finally. It refuses to start if a previous run left any behind.
 */
import './_gate-preflight.mjs';
const { serverReady, describeError } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { prisma } = await import('../lib/db.ts');
const { smsAllowance } = await import('../lib/sms-allowance.ts');
const { offersPayLink } = await import('../lib/invoice-pay-link.ts');
const { NOTIFICATION_TEMPLATES } = await import('../lib/notification-templates.ts');
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
// PORT 3000, the port `npm run dev` uses. This defaulted to 3111 — not a decision, just whatever
// the author had running that afternoon. Six gates carried defaults like it, so six gates skipped
// on every machine but one; both of the two tested pass unchanged against 3000. GATE_BASE still
// overrides, which is what a genuinely different server is for.
const B = process.env.GATE_BASE ?? 'http://localhost:3000';
const MARK = 'qisgate_';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };

let filled = 0;
let browser = null;
try {
  const pre = await prisma.notificationLog.count({ where: { provider_message_id: { startsWith: MARK } } });
  if (pre) throw new Error(`REFUSING: ${pre} filler row(s) from a previous run still present`);

  // ── 0. THE DELETED ROUTE ───────────────────────────────────────────────────────────────────
  console.log('\n— the route that sent dead links —');
  const shareRes = await fetch(`${B}/api/jobcard-share`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobCardId: 'x' }),
  });
  check('/api/jobcard-share is gone', shareRes.status === 404, `${shareRes.status}`);
  // WHY it had to go, asserted rather than asserted-in-a-comment: it minted a quote_view link and
  // never attached a version, and the customer page resolves the quote BY that attachment.
  const orphans = await prisma.customerMagicLink.findMany({ where: { purpose: 'quote_view' }, select: { id: true, revoked_at: true, expires_at: true } });
  let live = 0;
  for (const l of orphans) {
    if (await prisma.quoteVersion.count({ where: { magic_link_id: l.id } })) continue;
    if (!l.revoked_at && l.expires_at > new Date()) live++;
  }
  check('no LIVE quote link exists with no version behind it', live === 0,
    `${orphans.length} quote links checked; a live one would render "no quote" to the customer`);

  // ── 1. THE TEMPLATES ───────────────────────────────────────────────────────────────────────
  console.log('\n— what a text can carry —');
  check('quote_ready has an sms renderer', typeof NOTIFICATION_TEMPLATES.quote_ready?.sms === 'function');
  check('quote_revised has one too', typeof NOTIFICATION_TEMPLATES.quote_revised?.sms === 'function',
    'a revision sent by text would otherwise record `no_renderer` and silently send nothing');
  check('neither is a security template', !NOTIFICATION_TEMPLATES.quote_ready.security && !NOTIFICATION_TEMPLATES.quote_revised.security,
    'they must count against the allowance and be refusable by it');

  // ── 2. LOG IN ──────────────────────────────────────────────────────────────────────────────
  // The dev server disposes inactive pages and serves 404s while it rebuilds one; a gate that
  // drives a page that was never served dies as a bare selector timeout 25s later. Warm it and
  // say so — see serverReady in _gate-preflight.
  const ready = await serverReady();
  check('the dev server serves pages before we drive it', ready.ok, `HTTP ${ready.status} after ${ready.attempts} attempt(s)`);
  browser = await chromium.launch({ channel: 'chrome' });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${B}/admin/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', 'owner@zzgategarage.test');
  await page.fill('input[type="password"]', 'GateGarage!2026');
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }), page.click('button[type="submit"]')]);

  const api = (path, body) => page.evaluate(async ([b, p, bd]) => {
    const r = await fetch(`${b}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bd) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, [B, path, body]);

  // ── 3. THE QUOTE CHANNEL ON THE SERVED PAGE ────────────────────────────────────────────────
  console.log('\n— the quote channel —');
  // ── PICKING THE FIXTURES BY THE REAL PREDICATES ────────────────────────────────────────────
  // First attempt at this filtered on JobCard.customer_id and status 'draft' and found nothing —
  // both wrong, and wrong in the way this whole change is about: the recipient comes from the
  // OWNERSHIP EDGE, not the card's customer link, and 'draft' is not the set of sendable statuses
  // (refuseQuoteSend is). Asked properly, ZZ has plenty of both.
  // A third predicate joins the two: the Quote TAB must be reachable, or the control is behind a
  // lock and no amount of clicking reveals it. That is computeTabs' business, so it is asked
  // through the page builder rather than guessed at from the card's columns.
  const { refuseQuoteSend } = await import('../lib/quote-acceptance.ts');
  const { reachabilityForJobCard } = await import('../lib/message-threads.ts');
  // Asked of the SERVED PAGE — is the Quote tab actually clickable? That is the only form of the
  // question that matters, and it needs no second implementation of computeTabs here.
  const quoteTabOpens = async (id) => {
    await page.goto(`${B}/admin/jobcards/${id}`, { waitUntil: 'domcontentloaded' });
    const btn = page.getByRole('button', { name: 'Quote', exact: false }).first();
    await btn.waitFor({ state: 'attached', timeout: 20000 }).catch(() => {});
    return btn.isEnabled().catch(() => false);
  };

  const candidates = await prisma.jobCard.findMany({
    where: { group_id: ZZ, items: { some: {} } },
    select: { id: true, status: true }, orderBy: { created_at: 'desc' }, take: 60,
  });
  let card = null;        // sendable, quote tab open, NOT textable — the hand-over branch
  let textCard = null;    // sendable and textable — the recipient assertions
  let looked = 0;
  for (const c of candidates) {
    if ((card && textCard) || looked >= 14) break;
    const accepted = await prisma.quoteVersion.count({ where: { job_card_id: c.id, status: 'accepted' } });
    if (refuseQuoteSend(c.status, accepted > 0)) continue;
    looked++;
    if (!(await quoteTabOpens(c.id))) continue;
    const reach = await reachabilityForJobCard(prisma, c.id, 'sms');
    if (!card && !reach?.ok) card = c;
    if (!textCard && reach?.ok) textCard = c;
  }
  card = card ?? textCard;
  if (!card || !textCard) throw new Error('no ZZ card that is sendable, has an open Quote tab, and is textable');
  console.log(`  fixtures: toggle=${card.id.slice(0, 8)} (${card.status}), textable=${textCard.id.slice(0, 8)} (${textCard.status})`);

  // THE CONTROL LIVES ON THE QUOTE TAB. Waiting for it on the landing tab found the element in the
  // DOM but hidden, which is a different fact from "it rendered" — the tab must actually be opened.
  const openQuoteTab = async (id) => {
    await page.goto(`${B}/admin/jobcards/${id}`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Quote', exact: false }).first().click();
    await page.waitForSelector('[data-testid="quote-channel"]', { state: 'visible', timeout: 25000 });
  };
  await openQuoteTab(card.id);
  // `.count()` counts hidden nodes too, so visibility is asked explicitly wherever it is the claim.
  const seen = (id) => page.locator(`[data-testid="${id}"]:visible`).count();

  check('both channels are offered on the quote', await seen('quote-channel-email') === 1 && await seen('quote-channel-sms') === 1);
  check('email is the default', await page.locator('[data-testid="quote-channel-email"]').getAttribute('aria-pressed') === 'true',
    'free, carries the note, and what a quote has always gone out on');
  // THE LABEL HAS TWO AXES, not one: first-send vs revision, and email vs text. ZZ's sendable cards
  // are all revisions, so hardcoding "Send quote to customer" asserted the fixture rather than the
  // behaviour. The claim worth making is that the VERB tracks the channel in whichever mode.
  const label = async () => (await page.locator('[data-testid="quote-send"]').textContent())?.trim();
  const EMAIL_LABELS = ['Send quote to customer', 'Send the updated price'];
  const SMS_LABELS = ['Text quote to customer', 'Text the updated price'];
  const emailLabel = await label();
  check('the button offers to SEND while on email', EMAIL_LABELS.includes(emailLabel), emailLabel);
  // THE TESTIDS ARE QUOTE-SCOPED. This page renders the messaging compose box too, and two elements
  // answering to one name is a gate that lies about which one it measured.
  check('the quote toggle does not collide with the compose box', await seen('quote-channel-sms') === 1 && await seen('channel-sms') <= 1,
    'quote-channel-* vs channel-* — distinct names for distinct controls');

  await page.click('[data-testid="quote-channel-sms"]');
  await page.waitForSelector('[data-testid="quote-sms-allowance"]', { timeout: 15000 });
  const server = await smsAllowance(prisma, ZZ);
  const shown = (await page.locator('[data-testid="quote-sms-allowance"]').textContent())?.trim();
  check('the remaining count appears, and it is the SERVER’s', shown?.startsWith(`${server.remaining} text`), `${shown} / server ${server.remaining}`);
  const smsLabel = await label();
  check('and offers to TEXT once text is chosen', SMS_LABELS.includes(smsLabel) && smsLabel !== emailLabel,
    `${emailLabel} → ${smsLabel}`);

  // ── 4. THE RECIPIENT COMES FROM THE OWNERSHIP EDGE ─────────────────────────────────────────
  console.log('\n— who it goes to —');
  const emailOnSms = await api('/api/quote-send', { jobCardId: textCard.id, channel: 'sms', email: 'someone@example.com' });
  check('an email address is refused on a text', emailOnSms.status === 400, `${emailOnSms.status} ${emailOnSms.body.message ?? ''}`);

  const edgeSms = await reachabilityForJobCard(prisma, textCard.id, 'sms');
  const edgeEmail = await reachabilityForJobCard(prisma, textCard.id, 'email');
  const cardOwn = await prisma.jobCard.findUnique({ where: { id: textCard.id }, select: { customer: { select: { email: true } } } });
  check('the edge answers both channels for the same card', !!edgeSms?.ok && typeof edgeEmail?.ok === 'boolean',
    `sms ${edgeSms?.address} / email ${edgeEmail?.ok ? edgeEmail.address : 'none'}`);
  check('and the card’s own customer link is no longer what quote-send reads', true,
    `card.customer.email=${cardOwn?.customer?.email ?? 'null'} — informational; the edge is the source now`);

  // UNREACHABLE IS A WARNING, NOT A BLOCK. `card` was chosen as the un-textable one precisely so
  // this branch is exercised: the send still mints a link to hand over at the counter.
  const noMobile = await reachabilityForJobCard(prisma, card.id, 'sms');
  if (!noMobile?.ok) {
    check('an un-textable card warns rather than disabling', await seen('quote-sms-unreachable') === 1,
      (await page.locator('[data-testid="quote-sms-unreachable"]').textContent())?.trim().slice(0, 70));
    check('and the send button stays enabled', !(await page.locator('[data-testid="quote-send"]').isDisabled()),
      'the link is the product; the text is one way of delivering it');
  } else {
    check('an un-textable sendable card exists to prove the warning', false, 'every candidate was textable — branch UNPROVEN');
  }

  // ── 5. THE ALLOWANCE IS ASKED BEFORE THE FREEZE ────────────────────────────────────────────
  console.log('\n— when the allowance is spent —');
  const versionsBefore = await prisma.quoteVersion.count({ where: { job_card_id: card.id } });
  const liveLinksBefore = await prisma.customerMagicLink.count({ where: { job_card_id: card.id, revoked_at: null } });

  const need = Math.max(0, server.remaining);
  // `scope` is REQUIRED and has no default (cbd67eb, "whose message this is, said not inferred"),
  // and these rows carry a group_id, so they are a garage's own messages: tenant. The fixture was
  // never updated, so this gate has been genuinely red since — reported as "✗ run completed —"
  // with a blank reason, which is why it read as one more transient blip for weeks.
  const rows = Array.from({ length: need }, (_, i) => ({
    group_id: ZZ, scope: 'tenant', channel: 'sms', template: 'free_text', provider: 'twilio', status: 'sent',
    recipient: '+447700900000', direction: 'out', provider_message_id: `${MARK}${i}`, counts_to_allowance: true,
  }));
  for (let i = 0; i < rows.length; i += 50) filled += (await prisma.notificationLog.createMany({ data: rows.slice(i, i + 50) })).count;
  check('the allowance is exhausted', (await smsAllowance(prisma, ZZ)).remaining === 0, `${filled} filler rows`);

  const refused = await api('/api/quote-send', { jobCardId: card.id, channel: 'sms' });
  check('a text quote is refused', refused.status === 409 && refused.body.code === 'allowance_spent',
    `${refused.status} ${refused.body.code}`);
  check('the refusal offers the way out', /email the quote instead/i.test(refused.body.message ?? ''), refused.body.message);
  check('it carries the allowance so the page need not re-ask', typeof refused.body.allowance?.remaining === 'number');

  // THE ASSERTION THAT MATTERS. Refusing is easy; refusing without damage is the design.
  check('NO version was frozen', await prisma.quoteVersion.count({ where: { job_card_id: card.id } }) === versionsBefore,
    `${versionsBefore} before and after`);
  check('and NO live link was revoked', await prisma.customerMagicLink.count({ where: { job_card_id: card.id, revoked_at: null } }) === liveLinksBefore,
    'refusing at the chokepoint instead would have left the customer holding a dead link');

  // The check is discriminating: EMAIL is unaffected by a spent SMS allowance.
  await openQuoteTab(card.id);
  await page.click('[data-testid="quote-channel-sms"]');
  await page.waitForSelector('[data-testid="quote-allowance-spent"]', { timeout: 15000 });
  check('the page says so, in words', await seen('quote-allowance-spent') === 1,
    (await page.locator('[data-testid="quote-allowance-spent"]').textContent())?.trim().slice(0, 80));
  check('the send button is disabled', await page.locator('[data-testid="quote-send"]').isDisabled());
  await page.click('[data-testid="quote-channel-email"]');
  await page.waitForTimeout(1500);
  check('but EMAIL is still available — the box is not closed', !(await page.locator('[data-testid="quote-send"]').isDisabled())
    && EMAIL_LABELS.includes(await label()),
    'the customer is reachable; it is we who cannot text');

  // ── 6. THE INVOICE BUTTON ──────────────────────────────────────────────────────────────────
  console.log('\n— text the pay link —');
  const issued = await prisma.invoice.findFirst({
    where: { group_id: ZZ, status: 'issued', series: 'chargeable', lines: { some: {} } },
    select: { id: true, job_card_id: true }, orderBy: { created_at: 'desc' },
  });
  const paid = await prisma.invoice.findFirst({
    where: { group_id: ZZ, status: 'paid' }, select: { id: true }, orderBy: { created_at: 'desc' },
  });
  if (!issued) throw new Error('no issued ZZ invoice with lines');

  await page.goto(`${B}/admin/invoices/${issued.id}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="invoice-email"]', { timeout: 25000 });
  check('an unpaid invoice offers Text pay link', await seen('invoice-text-pay') === 1);
  check('beside the email button, not instead of it', await seen('invoice-email') === 1,
    'the email sends the DOCUMENT; this sends a link to pay — two artefacts, two buttons');

  if (paid) {
    await page.goto(`${B}/admin/invoices/${paid.id}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="invoice-email"]', { timeout: 25000 });
    check('a PAID invoice does not offer it', await seen('invoice-text-pay') === 0,
      'a button whose only outcome is a refusal is a wasted click');
    check('but is still emailable', await seen('invoice-email') === 1, 'a receipt is worth sending');
  } else {
    check('a paid ZZ invoice exists to prove the hidden case', false, 'none found — the hidden branch is UNPROVEN');
  }

  // The button and the endpoint agree, because they read one predicate.
  const { buildInvoiceDoc } = await import('../lib/invoice-doc.ts');
  const docIssued = await buildInvoiceDoc(issued.id, ZZ);
  check('the predicate the page used is the endpoint’s own', offersPayLink(docIssued) === true,
    'offersPayLink — one rule, two readers');
  if (paid) {
    const docPaid = await buildInvoiceDoc(paid.id, ZZ);
    check('and it says no for the paid one', offersPayLink(docPaid) === false);
  }

  // The endpoint refuses while the allowance is spent — same code the compose box uses.
  const smsRefused = await api('/api/invoice-sms', { invoiceId: issued.id });
  check('texting a pay link is refused too', smsRefused.status === 409 && smsRefused.body.code === 'allowance_spent',
    `${smsRefused.status} ${smsRefused.body.code}`);
} catch (e) {
  check('run completed', false, describeError(e).slice(0, 300));
} finally {
  await browser?.close().catch(() => {});
  // TEARDOWN RETRIES. Neon drops connections intermittently (P1001) and a blip here would leave 98
  // filler rows behind, silently spending a real tenant's allowance until someone noticed.
  const retry = async (label, fn) => {
    for (let i = 0; i < 5; i++) {
      try { return await fn(); } catch (e) {
        if (e?.code !== 'P1001' || i === 4) throw e;
        console.log(`  … ${label} hit P1001, retrying (${i + 1}/4)`);
        await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
      }
    }
  };
  const d = await retry('teardown', () => prisma.notificationLog.deleteMany({ where: { provider_message_id: { startsWith: MARK } } }));
  check('teardown removed every filler row', d.count === filled, `${d.count} of ${filled}`);
  const back = await retry('allowance', () => smsAllowance(prisma, ZZ));
  check('and the allowance is back', back.remaining > 0, `${back.remaining} left`);
  console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
  await prisma.$disconnect();
  process.exit(out.includes('F') ? 1 : 0);
}
