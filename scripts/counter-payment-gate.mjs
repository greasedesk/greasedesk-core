/**
 * File: scripts/counter-payment-gate.mjs
 * The counter mark-paid, end to end, through a real click. Cash, card machine, bank transfer —
 * the payment type a garage uses most, and until now the least covered.
 *
 * ── WHY IT EXISTS ───────────────────────────────────────────────────────────────────────────────
 * This is the path that wrote a null site onto EVERY counter payment. `pages/api/jobcard-status`
 * selected the invoice without `site_id`, `siteId: inv.site_id ?? null` read the unselected field as
 * undefined, and one such row dropped £2,485.43 — 27% of a real August — out of the revenue tile.
 *
 * Its only cover was poisoned-transaction-gate READING the file, plus the type-checker. Neither is
 * cover: it was proven this morning that a forgotten `select` still COMPILES, because `prisma` is
 * exported as `any`. A guard that provably does not bite on the actual defect is not a guard. And
 * both the select and the tenant guard on this path changed on the same day.
 *
 * ── WHAT IT PROVES, THROUGH THE UI ──────────────────────────────────────────────────────────────
 *   1. the Payment row carries the INVOICE'S SITE, not a null;
 *   2. the invoice reconciles — the cache equals the ledger, and the status moves;
 *   3. the job card moves to paid;
 *   4. revenue counts it in the month the money moved, and NOT in the month before;
 *   5. the endpoint refuses cleanly for a caller with no tenant.
 *
 * ── FIXTURES ────────────────────────────────────────────────────────────────────────────────────
 * ZZ only. The invoice's own payment state is CAPTURED AND RESTORED, never recomputed — the
 * asymmetry that once left a live invoice reading 27000 against a real 12000. An INSTANT method is
 * chosen deliberately: only `succeeded` counts as revenue, so a windowed method would make check 4
 * vacuous.
 */
import './_gate-preflight.mjs';
const { serverReady, describeError } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { prisma } = await import('../lib/db.ts');
const { receivedInPeriod } = await import('../lib/payments.ts');
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');
const bcrypt = (await import('bcryptjs')).default;

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const B = process.env.GATE_BASE ?? 'http://localhost:3000';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const P = (p) => `£${(p / 100).toFixed(2)}`;

let invId = null, cardId = null, before = null, cardBefore = null, browser = null;
let madePaymentIds = [], groupless = null;

try {
  // ── A CARD WITH AN ISSUED, UNPAID INVOICE ──────────────────────────────────────────────────
  const inv = await prisma.invoice.findFirst({
    where: { group_id: ZZ, series: 'chargeable', status: 'issued', lines: { some: {} } },
    select: { id: true, job_card_id: true, site_id: true, invoice_number: true, amount_paid_pennies: true,
      status: true, paid_at: true, date_paid: true, confirm_due_at: true, payment_method_id: true, payment_method_snapshot: true },
    orderBy: { created_at: 'desc' },
  });
  if (!inv) throw new Error('no issued unpaid ZZ invoice with lines');
  invId = inv.id; cardId = inv.job_card_id; before = inv;
  cardBefore = (await prisma.jobCard.findUnique({ where: { id: cardId }, select: { status: true } })).status;
  if (cardBefore !== 'invoiced') throw new Error(`fixture card is '${cardBefore}', need 'invoiced'`);

  // INSTANT only: `processing` rows are deliberately excluded from revenue, so a windowed method
  // would let check 4 pass without proving anything.
  const method = await prisma.paymentMethod.findFirst({
    where: { group_id: ZZ, behaviour: 'instant' }, select: { id: true, name: true },
  });
  if (!method) throw new Error('no INSTANT payment method on ZZ — check 4 would be vacuous');

  // The month the money moves. Deliberately NOT today: the date is chosen so the assertion is about
  // the DOCUMENT date the garage picked, not about "now" happening to fall in the right month.
  const now = new Date();
  const payMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 12));
  const iso = payMonth.toISOString().slice(0, 10);
  const monthFrom = new Date(Date.UTC(payMonth.getUTCFullYear(), payMonth.getUTCMonth(), 1));
  const monthTo = new Date(Date.UTC(payMonth.getUTCFullYear(), payMonth.getUTCMonth() + 1, 1));
  const prevFrom = new Date(Date.UTC(payMonth.getUTCFullYear(), payMonth.getUTCMonth() - 1, 1));
  const siteIds = (await prisma.site.findMany({ where: { group_id: ZZ }, select: { id: true } })).map((s) => s.id);
  const revBefore = await receivedInPeriod(prisma, { groupId: ZZ, siteIds, from: monthFrom, to: monthTo });
  const prevBefore = await receivedInPeriod(prisma, { groupId: ZZ, siteIds, from: prevFrom, to: monthFrom });
  console.log(`\n  invoice ${inv.invoice_number}, paying ${iso} by ${method.name} (instant)`);

  // ── 5a. UNAUTHENTICATED IS REFUSED, BEFORE ANY CLICKING ────────────────────────────────────
  console.log('\n— it refuses a caller with no tenant —');
  const anon = await fetch(`${B}/api/jobcard-status`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobCardId: cardId, to: 'paid', paymentMethodId: method.id, datePaid: iso }),
  });
  check('an unauthenticated mark-paid is 401', anon.status === 401, `HTTP ${anon.status}`);
  check('and it wrote nothing', (await prisma.invoice.findUnique({ where: { id: invId }, select: { status: true } })).status === 'issued');

  // A user with NO TENANT is the case requireTenantApi exists for. Operators have no User row, so
  // the only way to make one is to create it.
  //
  // THE PASSWORD MUST BE CORRECT. The first version of this check used a junk hash, so the login
  // failed on the CREDENTIAL and the assertion passed without ever exercising the tenant rule —
  // an assertion satisfied by a broken fixture, for the second time today. The hash is real, and
  // bcrypt.compare is asserted below, so the ONLY thing left to refuse on is the missing tenant.
  const PW = 'GatelessUser!2026';
  groupless = await prisma.user.create({
    data: { email: `counter-gate-notenant-${Date.now()}@example.com`, name: 'No Tenant', role: 'ADMIN',
      passwordHash: bcrypt.hashSync(PW, 10), group_id: null, site_id: null },
    select: { id: true, email: true, passwordHash: true },
  });
  check('the fixture password is genuinely correct', bcrypt.compareSync(PW, groupless.passwordHash),
    'so a refusal below can only be about the missing tenant, not the credential');

  // Proper next-auth credentials post: csrf token AND its cookie, or the callback rejects on CSRF
  // and we would again be proving the wrong thing.
  const csrfRes = await fetch(`${B}/api/auth/csrf`);
  const csrfToken = (await csrfRes.json()).csrfToken;
  const csrfCookie = (csrfRes.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const cred = await fetch(`${B}/api/auth/callback/credentials`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', cookie: csrfCookie },
    body: new URLSearchParams({ email: groupless.email, password: PW, csrfToken, json: 'true' }),
  });
  const setCookies = (cred.headers.getSetCookie?.() ?? []).join('; ');
  const sessionCookie = /next-auth\.session-token=([^;]+)/.exec(setCookies)?.[0] ?? null;

  if (!sessionCookie) {
    // Refused at authenticate — the outer layer of the same rule.
    check('a groupless user is refused a session at all', true, `HTTP ${cred.status}, no session cookie issued`);
  } else {
    // It authenticated. Then the guard is what must stop it — which is the case requireTenantApi
    // was written for, reached for real rather than reasoned about.
    const asGroupless = await fetch(`${B}/api/jobcard-status`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', cookie: sessionCookie },
      body: JSON.stringify({ jobCardId: cardId, to: 'paid', paymentMethodId: method.id, datePaid: iso }),
    });
    check('a groupless SESSION is refused by requireTenantApi', asGroupless.status === 401,
      `HTTP ${asGroupless.status} — authenticated, no tenant, refused at the guard`);
    check('and it wrote nothing either', (await prisma.invoice.findUnique({ where: { id: invId }, select: { status: true } })).status === 'issued');
  }

  // ── THE REAL CLICK ─────────────────────────────────────────────────────────────────────────
  console.log('\n— marked paid at the counter, through the UI —');
  // The dev server disposes inactive pages and serves 404s while it rebuilds one; a gate that
  // drives a page that was never served dies as a bare selector timeout 25s later. Warm it and
  // say so — see serverReady in _gate-preflight.
  const ready = await serverReady();
  check('the dev server serves pages before we drive it', ready.ok, `HTTP ${ready.status} after ${ready.attempts} attempt(s)`);
  browser = await chromium.launch({ channel: 'chrome' });
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${B}/admin/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', 'owner@zzgategarage.test');
  await page.fill('input[type="password"]', 'GateGarage!2026');
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }), page.click('button[type="submit"]')]);

  await page.goto(`${B}/admin/jobcards/${cardId}?tab=invoice`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="invoice-mark-paid"]', { timeout: 30000 });
  await page.locator('[data-testid="invoice-mark-paid"]').first().click();
  await page.waitForSelector('[data-testid="pay-confirm"]', { timeout: 20000 });
  await page.selectOption('[data-testid="pay-method"]', method.id);
  await page.fill('[data-testid="pay-date"]', iso);
  await page.locator('[data-testid="pay-confirm"]').click();
  // Wait for the write, not for a spinner: the row is the outcome.
  for (let i = 0; i < 40; i++) {
    const p = await prisma.payment.findFirst({ where: { invoice_id: invId }, select: { id: true } });
    if (p) break;
    await page.waitForTimeout(500);
  }

  const pay = await prisma.payment.findFirst({
    where: { invoice_id: invId },
    select: { id: true, site_id: true, group_id: true, amount_pennies: true, status: true, provider: true,
      collected_at: true, payment_method_snapshot: true },
  });
  if (pay) madePaymentIds.push(pay.id);
  check('a Payment row was written', !!pay, pay ? `${pay.provider}/${pay.status} ${P(pay.amount_pennies)}` : 'NONE — the click did not reach the ledger');

  // ── 1. THE DEFECT ──────────────────────────────────────────────────────────────────────────
  check('it carries the INVOICE’S SITE, not a null', !!pay && pay.site_id === inv.site_id,
    pay ? `payment.site_id=${pay.site_id ?? 'NULL'} invoice.site_id=${inv.site_id}` : '—');
  check('and the tenant is right', !!pay && pay.group_id === ZZ);
  check('the collected date is the DOCUMENT date the garage picked', !!pay && pay.collected_at.toISOString().slice(0, 10) === iso,
    pay ? pay.collected_at.toISOString().slice(0, 10) : '—');

  // ── 2. THE INVOICE RECONCILES ──────────────────────────────────────────────────────────────
  const after = await prisma.invoice.findUnique({
    where: { id: invId }, select: { status: true, amount_paid_pennies: true, payment_method_snapshot: true },
  });
  check('the invoice is paid', after.status === 'paid', after.status);
  check('the cache equals the ledger', !!pay && after.amount_paid_pennies === pay.amount_pennies,
    `cache ${P(after.amount_paid_pennies ?? 0)} vs ledger ${pay ? P(pay.amount_pennies) : '—'}`);
  check('the method is snapshotted on both', after.payment_method_snapshot === method.name && pay?.payment_method_snapshot === method.name);

  // ── 3. THE CARD MOVES ──────────────────────────────────────────────────────────────────────
  check('the job card moved to paid', (await prisma.jobCard.findUnique({ where: { id: cardId }, select: { status: true } })).status === 'paid');

  // ── 4. REVENUE, IN THE RIGHT MONTH ─────────────────────────────────────────────────────────
  const revAfter = await receivedInPeriod(prisma, { groupId: ZZ, siteIds, from: monthFrom, to: monthTo });
  const prevAfter = await receivedInPeriod(prisma, { groupId: ZZ, siteIds, from: prevFrom, to: monthFrom });
  check('revenue rises by exactly the payment, in the month it moved',
    !!pay && revAfter.receivedPennies - revBefore.receivedPennies === pay.amount_pennies,
    `${P(revBefore.receivedPennies)} → ${P(revAfter.receivedPennies)}`);
  check('the month BEFORE does not move', prevAfter.receivedPennies === prevBefore.receivedPennies,
    'a closed month does not move because something was recorded today');
  check('it is attributed to the invoice’s site',
    (revAfter.perSite.find((s) => s.siteId === inv.site_id)?.receivedPennies ?? 0)
      - (revBefore.perSite.find((s) => s.siteId === inv.site_id)?.receivedPennies ?? 0) === (pay?.amount_pennies ?? -1));
  // Discriminating: the naive scope that lost the August money would have found it too — because
  // site_id is now correct. So assert the CAUSE, not just the effect.
  const naive = await prisma.payment.aggregate({
    where: { group_id: ZZ, site_id: { in: siteIds }, status: 'succeeded', collected_at: { gte: monthFrom, lt: monthTo } },
    _sum: { amount_pennies: true },
  });
  check('the check is discriminating — a null site would have been invisible here',
    (naive._sum.amount_pennies ?? 0) >= (pay?.amount_pennies ?? 0),
    'this query is the one that silently dropped £2,485.43; with a correct site it now finds the row');
} catch (e) {
  check('run completed', false, describeError(e).slice(0, 300));
} finally {
  await browser?.close().catch(() => {});
  if (madePaymentIds.length) {
    const d = await prisma.payment.deleteMany({ where: { id: { in: madePaymentIds } } });
    check('teardown removed the fixture payment', d.count === madePaymentIds.length, `${d.count} of ${madePaymentIds.length}`);
  }
  if (groupless) {
    await prisma.user.delete({ where: { id: groupless.id } }).catch(() => {});
    check('teardown removed the groupless fixture user', (await prisma.user.count({ where: { id: groupless.id } })) === 0);
  }
  if (invId && before) {
    // CAPTURED AND RESTORED, never recomputed.
    await prisma.invoice.update({
      where: { id: invId },
      data: { status: before.status, paid_at: before.paid_at, date_paid: before.date_paid, confirm_due_at: before.confirm_due_at,
        amount_paid_pennies: before.amount_paid_pennies, payment_method_id: before.payment_method_id,
        payment_method_snapshot: before.payment_method_snapshot },
    });
    const now2 = await prisma.invoice.findUnique({ where: { id: invId }, select: { status: true, amount_paid_pennies: true } });
    check('teardown restored the invoice exactly', now2.status === before.status && now2.amount_paid_pennies === before.amount_paid_pennies,
      `${before.status}/${JSON.stringify(before.amount_paid_pennies)} → ${now2.status}/${JSON.stringify(now2.amount_paid_pennies)}`);
  }
  if (cardId && cardBefore) {
    await prisma.jobCard.update({ where: { id: cardId }, data: { status: cardBefore } });
    check('teardown restored the job card status', (await prisma.jobCard.findUnique({ where: { id: cardId }, select: { status: true } })).status === cardBefore);
  }
  check('no fixture payment survives', (await prisma.payment.count({ where: { id: { in: madePaymentIds } } })) === 0);
  console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
  await prisma.$disconnect();
  process.exit(out.includes('F') ? 1 : 0);
}
