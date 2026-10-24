/**
 * File: scripts/no-charge-gate.mjs
 * @gate-requires: db, server
 *
 * CLOSING A JOB CARD AS NO CHARGE.
 *
 * ── THE DEFECT THIS EXISTS FOR ──────────────────────────────────────────────────────────────────
 * Some cards exist only to direct a mechanic and hold intake: a comeback, a courtesy car, an
 * inspection that did not convert. The only way to FINISH a card was to invoice it, so TMBS spent
 * chargeable invoice number 100003331 on a £0 document with no lines. A number out of a gapless
 * statutory series, consumed to close a card that was never going to be billed.
 *
 * Every clause below is about something that must NOT happen: no number consumed, no payment row,
 * no revenue, no STANDARD user doing it unless the tenant said so, no closing over an invoice that
 * already exists. Absence is hard to assert honestly, so each one measures the thing it denies
 * BEFORE and AFTER and compares — never "is zero now", which is also true of a gate that did
 * nothing at all.
 *
 * FIXTURES ON ZZ ONLY, by this gate's own prefix, swept before and after and REGISTERED with
 * onTeardown so the runner's cap cannot leave them behind.
 */
import './_gate-preflight.mjs';
const { gatePrisma, describeError, ZZ_GROUP, gateOrigin, serverReady, onTeardown } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { chromium } = await import('/Users/hugh/Developer/greasedesk-core/node_modules/playwright-core/index.mjs');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const R = '/Users/hugh/Developer/greasedesk-core';
const PREFIX = 'ZZNC';

let prisma; let browser = null;
const sweep = async () => {
  if (!prisma) return 0;
  const cards = (await prisma.jobCard.findMany({ where: { group_id: ZZ_GROUP, vehicle: { registration: { startsWith: PREFIX } } }, select: { id: true } })).map((c) => c.id);
  if (cards.length) {
    const invs = (await prisma.invoice.findMany({ where: { job_card_id: { in: cards } }, select: { id: true } })).map((i) => i.id);
    if (invs.length) {
      await prisma.payment.deleteMany({ where: { invoice_id: { in: invs } } }).catch(() => {});
      await prisma.invoiceLine.deleteMany({ where: { invoice_id: { in: invs } } }).catch(() => {});
      await prisma.invoice.deleteMany({ where: { id: { in: invs } } });
    }
    await prisma.auditLog.deleteMany({ where: { entity: 'job_card', entity_id: { in: cards } } }).catch(() => {});
    await prisma.jobCardItem.deleteMany({ where: { job_card_id: { in: cards } } });
    await prisma.jobCard.deleteMany({ where: { id: { in: cards } } });
  }
  await prisma.vehicle.deleteMany({ where: { group_id: ZZ_GROUP, registration: { startsWith: PREFIX } } }).catch(() => {});
  // The signed-in STANDARD fixture. Sessions first — a User row with a live session left behind is
  // a login this gate created and nobody owns.
  const users = (await prisma.user.findMany({ where: { group_id: ZZ_GROUP, email: { startsWith: PREFIX.toLowerCase() } }, select: { id: true } })).map((u) => u.id);
  if (users.length) {
    await prisma.session.deleteMany({ where: { userId: { in: users } } }).catch(() => {});
    await prisma.account.deleteMany({ where: { userId: { in: users } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: users } } }).catch(() => {});
  }
  return (await prisma.customer.deleteMany({ where: { group_id: ZZ_GROUP, name: { startsWith: PREFIX } } })).count;
};

/** The tenant toggle is global to ZZ, so it is restored whatever happens — a gate that leaves a
 *  permission flipped silently changes what every later gate is allowed to do. */
let permWas = null;
const restorePerm = async () => {
  if (!prisma || permWas === null) return;
  await prisma.group.update({ where: { id: ZZ_GROUP }, data: { perm_standard_no_charge: permWas } }).catch(() => {});
};

try {
  prisma = await gatePrisma();
  onTeardown(sweep); onTeardown(restorePerm);
  await sweep();
  const ready = await serverReady();
  check('the dev server serves pages before we drive it', ready.ok, `HTTP ${ready.status} after ${ready.attempts} attempt(s)`);

  const NC = await import(`${R}/lib/no-charge.ts`);
  const ST = await import(`${R}/lib/jobcard-status.ts`);
  const site = await prisma.site.findFirst({ where: { group_id: ZZ_GROUP }, select: { id: true } });
  const owner = await prisma.user.findFirst({ where: { group_id: ZZ_GROUP }, select: { id: true } });
  permWas = (await prisma.group.findUnique({ where: { id: ZZ_GROUP }, select: { perm_standard_no_charge: true } }))?.perm_standard_no_charge ?? false;

  let n = 0;
  const mkCard = async (status = 'in_progress', withLine = true) => {
    n += 1;
    const cust = await prisma.customer.create({ data: { group_id: ZZ_GROUP, site_id: site.id, name: `${PREFIX} cust ${n}` }, select: { id: true } });
    const veh = await prisma.vehicle.create({ data: { group_id: ZZ_GROUP, registration: `${PREFIX}${n}`, registration_normalized: `${PREFIX}${n}` }, select: { id: true } });
    const card = await prisma.jobCard.create({ data: {
      group_id: ZZ_GROUP, site_id: site.id, customer_id: cust.id, vehicle_id: veh.id,
      status, stage_details_done: true }, select: { id: true } });
    if (withLine) await prisma.jobCardItem.create({ data: { job_card_id: card.id, item_type: 'labour', description: `${PREFIX} diagnosis`, qty: 1, unit_price: 60, vat_rate: 20, vat_amount: 12, position: 0 } });
    return card.id;
  };

  browser = await chromium.launch({ channel: 'chrome' });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${gateOrigin()}/admin/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', 'owner@zzgategarage.test');
  await page.fill('input[type="password"]', 'GateGarage!2026');
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }), page.click('button[type="submit"]')]);
  const post = (body) => page.evaluate(async (b) => {
    const r = await fetch('/api/jobcard-status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(b) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, body);

  // ── 1. NO INVOICE NUMBER IS CONSUMED ────────────────────────────────────────────────────────
  // THE DEFECT, NAMED. The counter is tenant-wide and gapless, so this is measured as a BEFORE and
  // AFTER on InvoiceSequence.last_value, not as "the card has no invoice" — a closure that drew a
  // number and then failed to attach it would pass the weaker test and still have spent one.
  console.log('\n— the number that must not be spent —');
  // ONE ROW PER TENANT with a counter per series as its own COLUMN — there is no `series` column
  // to filter on, and `last_value` IS the chargeable counter. I wrote this as a findFirst on a
  // series that does not exist and Prisma refused it; worth naming, because a `findFirst` with a
  // bad filter that happened to be ignored would have compared a number to itself and passed.
  const seqBefore = await prisma.invoiceSequence.findUnique({ where: { group_id: ZZ_GROUP }, select: { last_value: true } });
  const cardA = await mkCard();
  const closeA = await post({ jobCardId: cardA, to: 'no_charge', noChargeReason: 'goodwill' });
  check('a card closes as no charge', closeA.status === 200, `${closeA.status} ${JSON.stringify(closeA.body).slice(0, 110)}`);
  const seqAfter = await prisma.invoiceSequence.findUnique({ where: { group_id: ZZ_GROUP }, select: { last_value: true } });
  check('  …and the chargeable counter has NOT moved',
    Number(seqAfter?.last_value ?? -1) === Number(seqBefore?.last_value ?? -2),
    `${seqBefore?.last_value} → ${seqAfter?.last_value}`);
  check('  …and no invoice row exists for the card at all',
    (await prisma.invoice.count({ where: { job_card_id: cardA } })) === 0);

  // ── 2. NO PAYMENT ROW ───────────────────────────────────────────────────────────────────────
  // Counted tenant-wide before and after, because a payment attached to the WRONG invoice is still
  // a payment this closure caused, and a card-scoped count would not see it.
  console.log('\n— and the payment that must not be written —');
  const payBefore = await prisma.payment.count({ where: { invoice: { group_id: ZZ_GROUP } } });
  const cardB = await mkCard();
  await post({ jobCardId: cardB, to: 'no_charge', noChargeReason: 'warranty' });
  check('no payment row is written anywhere on the tenant',
    (await prisma.payment.count({ where: { invoice: { group_id: ZZ_GROUP } } })) === payBefore,
    `${payBefore} before, ${await prisma.payment.count({ where: { invoice: { group_id: ZZ_GROUP } } })} after`);

  // ── 3. A REASON IS REQUIRED ─────────────────────────────────────────────────────────────────
  console.log('\n— a reason, and a reason this system knows —');
  const cardC = await mkCard();
  // ASSERT THE CODE, NOT JUST THE STATUS. Written as `status === 400` this clause could not be
  // made to fail: deleting the missing-reason branch entirely still returns 400, because an
  // absent reason is also not a KNOWN one and the next branch catches it. The two are different
  // mistakes with different sentences — "choose a reason" against "that is not a reason" — and
  // the code is what distinguishes them.
  const noReason = await post({ jobCardId: cardC, to: 'no_charge' });
  check('closing with NO reason is refused, AS a missing reason',
    noReason.status === 400 && noReason.body?.code === 'reason_required',
    `${noReason.status} ${noReason.body?.code ?? '(no code)'} — ${noReason.body?.message ?? ''}`);
  const badReason = await post({ jobCardId: cardC, to: 'no_charge', noChargeReason: 'because I felt like it' });
  check('  …and a reason outside the list is refused as an UNKNOWN one',
    badReason.status === 400 && badReason.body?.code === 'reason_unknown',
    `${badReason.status} ${badReason.body?.code ?? '(no code)'}`);
  check('  …and the card is untouched by either refusal',
    (await prisma.jobCard.findUnique({ where: { id: cardC }, select: { status: true } }))?.status === 'in_progress');
  check('the reason is stored as a KEY, not as English',
    (await prisma.jobCard.findUnique({ where: { id: cardA }, select: { no_charge_reason: true } }))?.no_charge_reason === 'goodwill',
    'an English string here cannot be translated, counted, or renamed without a migration');

  // ── 4. THE PERMISSION IS ENFORCED ON THE SERVER ─────────────────────────────────────────────
  // Driven as a STANDARD user against the API directly, never by looking at the screen: a hidden
  // button is not a guard, and this is the clause that says so.
  console.log('\n— a STANDARD user, with the toggle off —');
  /**
   * A STANDARD USER WHO CAN SIGN IN. ZZ has none standing, and job-clock-gate's technique — create
   * one with no password — cannot drive an authenticated request. The hash is COPIED from the
   * owner row rather than invented, so this gate never holds, derives or prints a credential; it
   * reuses one the tenant already has. Swept with everything else.
   */
  const ownerRow = await prisma.user.findFirst({ where: { group_id: ZZ_GROUP, is_owner: true }, select: { passwordHash: true, site_id: true } })
    ?? await prisma.user.findFirst({ where: { group_id: ZZ_GROUP, role: 'ADMIN' }, select: { passwordHash: true, site_id: true } });
  const std = ownerRow?.passwordHash
    ? await prisma.user.create({ data: {
        group_id: ZZ_GROUP, site_id: ownerRow.site_id ?? site.id, email: `${PREFIX.toLowerCase()}-standard@zzgategarage.test`,
        name: `${PREFIX} standard`, role: 'STANDARD', is_active: true, passwordHash: ownerRow.passwordHash },
        select: { id: true, email: true } })
    : null;
  /**
   * AND AN ASSIGNMENT TO THE SITE. Visibility.siteIds is built from `site_assignments`, not from
   * User.site_id — so a user with the column set and no join row can reach nothing, and the
   * permission would refuse for a reason that has nothing to do with the toggle. The
   * discriminator below is what caught this: the toggle went ON and the answer stayed 403.
   */
  if (std) await prisma.userSite.create({ data: { user_id: std.id, site_id: site.id } }).catch(() => {});
  check('premise: a STANDARD user exists to drive this with', !!std,
    std ? std.email : 'NO owner/admin row with a password to copy — the clauses below would assert nothing');
  if (std) {
    await prisma.group.update({ where: { id: ZZ_GROUP }, data: { perm_standard_no_charge: false } });
    const sctx = await browser.newContext();
    const sp = await sctx.newPage();
    await sp.goto(`${gateOrigin()}/admin/login`, { waitUntil: 'domcontentloaded' });
    await sp.fill('input[type="email"]', std.email);
    await sp.fill('input[type="password"]', 'GateGarage!2026');
    await Promise.all([sp.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }), sp.click('button[type="submit"]')]);
    const spost = (b) => sp.evaluate(async (x) => {
      const r = await fetch('/api/jobcard-status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(x) });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    }, b);
    const cardD = await mkCard();
    const denied = await spost({ jobCardId: cardD, to: 'no_charge', noChargeReason: 'goodwill' });
    check('the API REFUSES a STANDARD user while the toggle is off', denied.status === 403, `${denied.status} ${denied.body?.message ?? ''}`);
    check('  …and the card did not move', (await prisma.jobCard.findUnique({ where: { id: cardD }, select: { status: true } }))?.status === 'in_progress');
    // THE DISCRIMINATOR. Without it the refusal above could be a 403 for any reason at all —
    // a broken session, a site they cannot reach — and the toggle would be proving nothing.
    await prisma.group.update({ where: { id: ZZ_GROUP }, data: { perm_standard_no_charge: true } });
    const allowed = await spost({ jobCardId: cardD, to: 'no_charge', noChargeReason: 'goodwill' });
    check('  …and ACCEPTS the same user once the tenant turns it on', allowed.status === 200,
      `${allowed.status} ${JSON.stringify(allowed.body).slice(0, 90)} — otherwise the 403 above was about something else`);
    await prisma.group.update({ where: { id: ZZ_GROUP }, data: { perm_standard_no_charge: permWas } });
    await sctx.close();
  }

  // ── 4b. AND THE TOGGLE CAN BE SWITCHED ON WITHOUT A DATABASE WRITE ──────────────────────────
  // A permission nobody can reach from a screen is the built-and-unread pattern again: enforced,
  // correct, and unusable. So this drives the REAL Settings screen as an admin, then has the
  // STANDARD user close a card — the whole path a garage owner would actually walk.
  if (std) {
    console.log('\n— switching it on from the screen —');
    await prisma.group.update({ where: { id: ZZ_GROUP }, data: { perm_standard_no_charge: false } });
    await page.goto(`${gateOrigin()}/admin/settings/permissions`, { waitUntil: 'domcontentloaded' });
    const toggle = page.locator('button[role="switch"][aria-label="Mechanics can close a job as no charge"]');
    const onScreen = await toggle.waitFor({ state: 'visible', timeout: 30000 }).then(() => true).catch(() => false);
    check('the toggle is ON THE SETTINGS SCREEN, beside the others', onScreen,
      onScreen ? 'found by its label' : `NOT RENDERED — switches present: ${(await page.locator('button[role="switch"]').count())}`);
    if (onScreen) {
      check('  …and it is off to begin with', (await toggle.getAttribute('aria-checked')) === 'false');
      await toggle.click();
      await page.locator('button:has-text("Save")').first().click().catch(() => {});
      const saved = await (async () => {
        const end = Date.now() + 20000;
        for (;;) {
          const g = await prisma.group.findUnique({ where: { id: ZZ_GROUP }, select: { perm_standard_no_charge: true } });
          if (g?.perm_standard_no_charge) return true;
          if (Date.now() > end) return false;
          await new Promise((r) => setTimeout(r, 250));
        }
      })();
      check('  …and saving it reaches the database', saved, saved ? 'perm_standard_no_charge = true' : 'the switch moved but nothing was stored');

      // THE WHOLE POINT: the mechanic can now do the thing.
      const sctx2 = await browser.newContext();
      const sp2 = await sctx2.newPage();
      await sp2.goto(`${gateOrigin()}/admin/login`, { waitUntil: 'domcontentloaded' });
      await sp2.fill('input[type="email"]', std.email);
      await sp2.fill('input[type="password"]', 'GateGarage!2026');
      await Promise.all([sp2.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }), sp2.click('button[type="submit"]')]);
      const cardG = await mkCard();
      const asStd = await sp2.evaluate(async (b) => {
        const r = await fetch('/api/jobcard-status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(b) });
        return { status: r.status, body: await r.json().catch(() => ({})) };
      }, { jobCardId: cardG, to: 'no_charge', noChargeReason: 'comeback_rework' });
      check('A MECHANIC CAN THEN CLOSE A CARD, end to end from the screen', asStd.status === 200,
        `${asStd.status} ${JSON.stringify(asStd.body).slice(0, 110)}`);
      check('  …and the card is closed, with the reason stored as a key',
        (await prisma.jobCard.findUnique({ where: { id: cardG }, select: { status: true, no_charge_reason: true, no_charge_by: true } }))?.no_charge_reason === 'comeback_rework');
      await sctx2.close();
    }
    await prisma.group.update({ where: { id: ZZ_GROUP }, data: { perm_standard_no_charge: permWas } });
  }

  // ── 5. NOT OVER AN INVOICE THAT EXISTS ──────────────────────────────────────────────────────
  // ANY invoice row, voided included (owner, 2026-10-24). A void RETIRES the number and RETAINS
  // the document under VATREC5010, and a card whose invoice was voided is exactly the one somebody
  // will try to close as no-charge to tidy up — which would make the void look like it never was.
  console.log('\n— a card that has already been invoiced —');
  const { issueInvoiceForCard } = await import(`${R}/lib/invoice-issue.ts`);
  const cardE = await mkCard('in_progress');
  let invId = null;
  await prisma.$transaction(async (tx) => { invId = await issueInvoiceForCard(tx, cardE, ZZ_GROUP); }, { timeout: 30000 });
  const inv = await prisma.invoice.findUnique({ where: { id: invId }, select: { invoice_number: true } });
  const overInvoice = await post({ jobCardId: cardE, to: 'no_charge', noChargeReason: 'goodwill' });
  check('closing a card that has an invoice is refused', overInvoice.status === 409 || overInvoice.status === 400, `${overInvoice.status}`);
  check('  …and the refusal NAMES the invoice number',
    String(overInvoice.body?.message ?? '').includes(String(inv.invoice_number)),
    `"${String(overInvoice.body?.message ?? '').slice(0, 120)}" should contain ${inv.invoice_number}`);
  const voided = await prisma.invoice.update({ where: { id: invId }, data: { status: 'void' } }).then(() => true).catch(() => false);
  if (voided) {
    const overVoid = await post({ jobCardId: cardE, to: 'no_charge', noChargeReason: 'goodwill' });
    check('  …and still refused when that invoice has been VOIDED', overVoid.status === 409 || overVoid.status === 400,
      `${overVoid.status} — the document is retained, so the card is not uninvoiced`);
  }

  // ── 6. REOPEN IS RECORDED, AND RESTORES WHAT WAS THERE ──────────────────────────────────────
  // Not a fixed status: the card goes back to what it held. Asserted from a card closed out of
  // `declined`, because a reopen-to-`in_progress` default would look right on every other card.
  console.log('\n— reopening —');
  const cardF = await mkCard('declined');
  await post({ jobCardId: cardF, to: 'no_charge', noChargeReason: 'inspection_for_quote' });
  check('a declined card closes as no charge', (await prisma.jobCard.findUnique({ where: { id: cardF }, select: { status: true } }))?.status === 'no_charge');
  check('  …recording the status it held', (await prisma.jobCard.findUnique({ where: { id: cardF }, select: { no_charge_prior_status: true } }))?.no_charge_prior_status === 'declined');
  const reopen = await post({ jobCardId: cardF, to: 'reopen_no_charge' });
  check('it reopens', reopen.status === 200, `${reopen.status} ${JSON.stringify(reopen.body).slice(0, 90)}`);
  check('  …to the status it HELD, not to a fixed one',
    (await prisma.jobCard.findUnique({ where: { id: cardF }, select: { status: true } }))?.status === 'declined',
    'a card closed out of `declined` must not reopen into `in_progress`');
  const rows = await prisma.auditLog.findMany({ where: { entity: 'job_card', entity_id: cardF }, orderBy: { created_at: 'asc' }, select: { action: true, user_id: true, diff_json: true } });
  check('both the close AND the reopen are in the card’s event log',
    rows.some((r) => r.action === 'jobcard.no_charge_closed') && rows.some((r) => r.action === 'jobcard.no_charge_reopened'),
    rows.map((r) => r.action).join(', ') || '(no rows)');
  check('  …each naming who did it', rows.filter((r) => String(r.action).startsWith('jobcard.no_charge')).every((r) => !!r.user_id));
  // EVERY CYCLE, not just the last. This is why the reopened_at/by columns were dropped: a second
  // close would have overwritten the first, and the thing being counted later is the CYCLES.
  await post({ jobCardId: cardF, to: 'no_charge', noChargeReason: 'goodwill' });
  const rows2 = await prisma.auditLog.findMany({ where: { entity: 'job_card', entity_id: cardF, action: 'jobcard.no_charge_closed' } });
  check('a SECOND close is a second row, not an overwrite', rows2.length === 2, `${rows2.length} close row(s) after closing twice`);

  // ── 6b. THE CUSTOMER'S LINK DIES, AND REOPENING DOES NOT REVIVE IT ─────────────────────────
  // Closing is as final for the customer as cancelling: a dead card still serving a live quote is
  // how a declined job kept an acceptable link. quote-closure-gate demands that every terminal
  // status account for the link; this one proves the behaviour end to end AND proves the harder
  // half — that reopening gives the garage its card back WITHOUT handing the customer back an
  // offer they can still accept. If the quote is still wanted, a new version has to be sent.
  //
  // Asserted rather than reasoned: `revoked_at` has two writers today and neither clears it, but
  // "nothing un-revokes" is a property of the code as it stands, not a guarantee, and it is
  // exactly the sort that stops being true quietly.
  console.log('\n— and the link the customer is holding —');
  const { createMagicLink, resolveMagicLink } = await import(`${R}/lib/magic-link.ts`);
  const cardH = await mkCard('quoted');
  const linkH = await createMagicLink({ groupId: ZZ_GROUP, jobCardId: cardH, purpose: 'quote_view', recipient: 'zznc@example.invalid', baseUrl: gateOrigin() });
  const liveBefore = await resolveMagicLink(linkH.rawToken);
  check('premise: the customer is holding a LIVE quote link', liveBefore.ok === true,
    liveBefore.ok ? 'resolves' : `already ${liveBefore.reason} — the clauses below would prove nothing`);

  await post({ jobCardId: cardH, to: 'no_charge', noChargeReason: 'inspection_only' });
  const afterClose = await resolveMagicLink(linkH.rawToken);
  check('closing as no charge REVOKES it', afterClose.ok === false && afterClose.reason === 'revoked',
    `${afterClose.ok ? 'still live' : afterClose.reason}`);
  check('  …naming no_charge as the reason, not a borrowed one',
    afterClose.ok === false && afterClose.revokedReason === 'no_charge', String(afterClose.revokedReason));

  const reopenH = await post({ jobCardId: cardH, to: 'reopen_no_charge' });
  check('the card reopens', reopenH.status === 200, `${reopenH.status}`);
  check('  …and the link STAYS DEAD — reopening is not re-offering',
    (await resolveMagicLink(linkH.rawToken)).ok === false,
    'the garage gets its card back; the customer does not get an acceptable offer back');
  check('  …so a quote that is still wanted must be SENT AGAIN',
    (await prisma.customerMagicLink.count({ where: { job_card_id: cardH, revoked_at: null } })) === 0,
    'no live link survives the cycle, so the only way to an offer is a new version');

  // ── 7. NOT REVENUE, AND NOT WORK IN PROGRESS ────────────────────────────────────────────────
  // Measured through the LIBRARIES the dashboard and the WIP tile actually call, not by reasoning
  // about which query would match. The card carries a £60 line precisely so that a reader which
  // counted it would be visibly wrong rather than coincidentally zero.
  console.log('\n— and it is not money —');
  const { wipCardsWhere } = await import(`${R}/lib/wip.ts`);
  const inWip = await prisma.jobCard.count({ where: { AND: [wipCardsWhere([site.id]), { id: cardA }] } });
  check('a no-charge card is NOT work in progress', inWip === 0, `${inWip} — it carries a £60 line, so a reader that counted it would show £60`);
  const { WIP_STATUSES } = await import(`${R}/lib/wip.ts`);
  check('  …and no-charge is excluded from every status list that drives money',
    !WIP_STATUSES.includes('no_charge') && !ST.INVOICE_DONE_STATUSES.includes('no_charge') && !ST.QUOTE_DONE_STATUSES.includes('no_charge'),
    `WIP=${WIP_STATUSES.includes('no_charge')} INVOICE_DONE=${ST.INVOICE_DONE_STATUSES.includes('no_charge')} QUOTE_DONE=${ST.QUOTE_DONE_STATUSES.includes('no_charge')}`);
  // I FIRST WROTE THIS CLAUSE THE OTHER WAY ROUND — asserting the slot is FREED — and the module's
  // own comment corrected it: FREES_THE_SLOT is the OCCUPANCY question, and on a no-charge card
  // the car came in and the work was done. A free inspection that freed its own slot would make
  // the day look emptier than it was, which is the opposite of what counting unpaid time is for.
  check('  …the slot stays OCCUPIED, because the work happened',
    !ST.FREES_THE_SLOT.includes('no_charge'),
    'the lift was used; only the bill is missing');
  check('  …it still RENDERS on the diary, as a no-show does',
    !ST.HIDDEN_FROM_DIARY.includes('no_charge'),
    'hiding it would conceal the hours it actually cost');
  check('  …and its slot reads as history, so it cannot be dragged',
    ST.SLOT_IS_HISTORY.includes('no_charge'));
  check('  …and it is `settled`, not `unpaid` — nothing is owed',
    ST.paymentState('no_charge') === 'settled', ST.paymentState('no_charge'));

  // ── 8. THE DECLINED CARD SUGGESTS THE RIGHT REASON ──────────────────────────────────────────
  console.log('\n— what it offers you —');
  check('a declined card suggests inspection_for_quote', NC.suggestedReason({ status: 'declined' }) === 'inspection_for_quote');
  check('  …and any other card suggests nothing, rather than guessing',
    NC.suggestedReason({ status: 'in_progress' }) === null,
    'a defaulted reason on every card is a reason nobody chose');
} catch (e) {
  console.log(`\n✗ THREW: ${String(e?.stack ?? e).slice(0, 700)}`);
  out.push('F');
} finally {
  await browser?.close().catch(() => {});
  await restorePerm();
  const left = await sweep().catch(() => -1);
  check('teardown removed every fixture row (ZZ only)', left >= 0, left < 0 ? 'the sweep threw — check ZZ for ZZNC by hand' : `${left} customer(s) removed`);
  console.log(`\n${out.filter((x) => x === 'F').length} failures of ${out.length}`);
  await prisma?.$disconnect();
  process.exit(out.includes('F') ? 1 : 0);
}
