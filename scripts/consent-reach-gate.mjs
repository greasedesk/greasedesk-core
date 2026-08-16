/**
 * File: scripts/consent-reach-gate.mjs
 * Gate for the consent bar: it must not cover what the page puts at the bottom.
 *
 * ── THE ASSERTION THAT MATTERS ──────────────────────────────────────────────────────────────────
 * The Pay button is clicked WITHOUT dismissing the banner first. pay-refusal-gate currently has to
 * accept cookies before it can click, and that workaround IS the defect: a customer following a pay
 * link met a bar over the button — 216px on desktop, 268px on a phone, 724px (89% of the screen)
 * once the categories expanded in place. Playwright's actionability check refuses the click for the
 * same reason a thumb misses it, so an unforced click is a faithful test.
 *
 * Both viewports, because the failure was far worse on the phone and a desktop-only check would
 * have called it fixed.
 *
 * ── AND CONSENT MUST STILL WORK ─────────────────────────────────────────────────────────────────
 * The cheap way to pass the first half is to put the page above the bar, which buries the consent
 * controls instead — trading an unreachable Pay button for an unreachable Reject. So Accept, Reject
 * and Manage are each asserted clickable, at both sizes, and Reject is asserted no harder to reach
 * than Accept (ICO).
 *
 * ── FIXTURES ────────────────────────────────────────────────────────────────────────────────────
 * ZZ only: one ProviderConnection and one pay link, both removed in the finally. Refuses to start if
 * ZZ already has a connection. The served build runs a DELIBERATELY INVALID Stripe key so the
 * preconditions pass and the button renders without any real charge being possible.
 */
import './_ts.mjs';
const { prisma } = await import('../lib/db.ts');
const { buildInvoiceDoc } = await import('../lib/invoice-doc.ts');
const { balanceOwedPennies } = await import('../lib/invoice.ts');
const { mintInvoicePayLink } = await import('../lib/invoice-pay-link.ts');
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const INV = 'b5c2ccd2-7b07-40e7-9228-067b25171750';
const B = process.env.GATE_BASE ?? 'http://localhost:3112';
const VIEWPORTS = [['desktop', 1280, 800], ['mobile', 375, 812]];
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };

// ── THE PAY LIMITER IS A SHARED, TIME-WINDOWED RESOURCE ─────────────────────────────────────────
// Clicking Pay spends from `pay:ip:` — 10 an hour, and this gate spends one per viewport on the same
// loopback address every other pay gate uses. Left behind, that budget makes the NEXT gate fail with
// a 429 that looks like an endpoint defect; it did exactly that to payment-intent-gate on the run
// before this line existed. Scoped by time so it releases only what this run took.
const startedAt = new Date();

let connId = null;
let linkId = null;
let browser = null;
try {
  const stale = await prisma.providerConnection.count({ where: { group_id: ZZ } });
  if (stale) throw new Error(`REFUSING: ZZ already has ${stale} ProviderConnection row(s)`);
  connId = (await prisma.providerConnection.create({
    data: {
      group_id: ZZ, provider: 'stripe', external_id: 'acct_gatefixture', livemode: false,
      charges_enabled: true, payouts_enabled: true, requirements_due: [], connected_at: new Date(),
      capabilities: { card_payments: 'active', transfers: 'active' },
    }, select: { id: true },
  })).id;

  const doc = await buildInvoiceDoc(INV, ZZ);
  const inv = await prisma.invoice.findUnique({ where: { id: INV }, select: { amount_paid_pennies: true } });
  const total = doc.vatRegistered ? doc.totals.grossPennies : doc.totals.netPennies;
  const link = await mintInvoicePayLink({
    doc, groupId: ZZ, recipient: 'gate', createdByUserId: null,
    balancePennies: balanceOwedPennies(inv, total),
  });
  if (!link) throw new Error('mintInvoicePayLink refused — no link to test with');
  linkId = link.id;
  const payUrl = link.url.replace(/^https?:\/\/[^/]+/, B);

  browser = await chromium.launch({ channel: 'chrome' });

  for (const [label, width, height] of VIEWPORTS) {
    console.log(`\n— ${label} ${width}×${height} —`);
    // A FRESH CONTEXT each time: consent is persisted, and a reused profile would have decided
    // already, which is precisely the state where there is no banner and nothing to prove.
    const page = await (await browser.newContext({ viewport: { width, height } })).newPage();
    await page.goto(payUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="consent-banner"]', { timeout: 25000 });

    const strip = await page.locator('[data-testid="consent-banner"]').boundingBox();
    // Per-viewport, because the honest design is two rows on a phone: a true single line at 375px
    // means truncating the sentence, and the cookie-policy link lives at the end of it. Both are a
    // long way under what they replaced (216 desktop / 268 mobile / 724 expanded).
    const CEILING = label === 'mobile' ? 120 : 88;
    check(`${label}: the resting bar is a strip`, strip.height <= CEILING,
      `${Math.round(strip.height)}px, ${Math.round(strip.height / height * 100)}% of the viewport (ceiling ${CEILING})`);

    const reserved = await page.evaluate(() => getComputedStyle(document.body).paddingBottom);
    check(`${label}: the page reserves it`, parseFloat(reserved) >= strip.height - 1,
      `body padding-bottom ${reserved} vs strip ${Math.round(strip.height)}px`);

    // ── THE ONE THAT MATTERS ────────────────────────────────────────────────────────────────
    await page.waitForSelector('[data-testid="pay-start"]', { timeout: 20000 });
    // SCROLL TO THE END, not merely into view. scrollIntoViewIfNeeded stops the moment the element
    // is inside the viewport — which, with a fixed bar, is a position where it is still underneath
    // one. That is what the reserved padding exists to fix, and measuring before the scroll had
    // finished tested the scroller rather than the fix. (My first run failed here on mobile.)
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(400);
    const pay = await page.locator('[data-testid="pay-start"]').boundingBox();
    check(`${label}: the Pay button clears the bar at full scroll`, pay.y + pay.height <= strip.y + 1,
      `button ends at ${Math.round(pay.y + pay.height)}, bar starts at ${Math.round(strip.y)}`);
    // Geometry is the reason; THIS is the fact. No force, no dismissal — if anything covers it,
    // Playwright's actionability check fails exactly as a real tap would.
    const clicked = await page.locator('[data-testid="pay-start"]').click({ timeout: 12000 }).then(() => true).catch(() => false);
    check(`${label}: and it is CLICKABLE with the banner still up`, clicked,
      'no dismissal, no force — the workaround pay-refusal-gate needed is gone');
    await page.waitForSelector('[data-testid="pay-error"]', { timeout: 30000 }).catch(() => {});

    // ── CONSENT MUST NOT HAVE BEEN BURIED TO ACHIEVE IT ─────────────────────────────────────
    for (const id of ['consent-accept', 'consent-reject', 'consent-manage']) {
      const box = await page.locator(`[data-testid="${id}"]`).boundingBox();
      const onScreen = box && box.y >= 0 && box.y + box.height <= height && box.x >= 0;
      const hittable = await page.locator(`[data-testid="${id}"]`).click({ trial: true, timeout: 6000 }).then(() => true).catch(() => false);
      check(`${label}: ${id.replace('consent-', '')} is on screen and hittable`, !!onScreen && hittable,
        onScreen ? '' : 'off-viewport');
    }
    const acc = await page.locator('[data-testid="consent-accept"]').boundingBox();
    const rej = await page.locator('[data-testid="consent-reject"]').boundingBox();
    check(`${label}: Reject is no harder to reach than Accept`,
      Math.abs(acc.y - rej.y) < 4 && Math.abs(acc.height - rej.height) < 4,
      'same row, same height — ICO says reject must be no harder than accept');

    // ── THE MODAL, WHICH IS ALLOWED TO COVER THINGS ─────────────────────────────────────────
    await page.click('[data-testid="consent-manage"]');
    await page.waitForSelector('[data-testid="consent-modal"]', { timeout: 10000 });
    check(`${label}: categories open as a modal, not by growing the bar`,
      (await page.locator('[data-testid="consent-banner"]').boundingBox()).height <= CEILING,
      'the 724px phone banner was this expansion happening in place');
    check(`${label}: and the reserved space did not grow with it`,
      Math.abs(parseFloat(await page.evaluate(() => getComputedStyle(document.body).paddingBottom)) - strip.height) < 2,
      'a transient, user-opened dialog is not something the page reserves room for');
    // A consent dialog with no way out but a choice is its own dark pattern.
    await page.locator('[data-testid="consent-modal"] .absolute.inset-0').click({ position: { x: 5, y: 5 } });
    await page.waitForSelector('[data-testid="consent-modal"]', { state: 'detached', timeout: 8000 });
    check(`${label}: the modal closes without forcing a choice`, true);

    // ── AND THE SPACE IS RELEASED ONCE THEY CHOOSE ──────────────────────────────────────────
    await page.click('[data-testid="consent-reject"]');
    await page.waitForSelector('[data-testid="consent-banner"]', { state: 'detached', timeout: 10000 });
    await page.waitForTimeout(300);
    check(`${label}: choosing releases the reserved space`,
      parseFloat(await page.evaluate(() => getComputedStyle(document.body).paddingBottom)) < 1,
      'otherwise every public page keeps a strip of dead air for the session');
    await page.context().close();
  }
} catch (e) {
  check('run completed', false, String(e?.message ?? e).slice(0, 300));
} finally {
  await browser?.close().catch(() => {});
  if (linkId) {
    const d = await prisma.customerMagicLink.deleteMany({ where: { id: linkId } });
    check('teardown removed the gate’s pay link', d.count === 1);
  }
  if (connId) {
    const d = await prisma.providerConnection.deleteMany({ where: { id: connId } });
    check('teardown removed the fixture connection', d.count === 1);
  }
  check('ZZ has no connection row again', (await prisma.providerConnection.count({ where: { group_id: ZZ } })) === 0);
  check('and no payment was created', (await prisma.payment.count({ where: { group_id: ZZ, provider: 'stripe' } })) === 0);
  const released = await prisma.authRateLimit.deleteMany({
    where: { key: { startsWith: 'pay:' }, created_at: { gte: startedAt } },
  });
  check('teardown cleared this run’s limiter budget', true,
    `${released.count} token(s) released — or the next pay gate 429s and looks broken`);
  console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
  await prisma.$disconnect();
  process.exit(out.includes('F') ? 1 : 0);
}
