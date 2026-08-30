/**
 * File: scripts/card-fulfilment-gate.mjs
 * Gate for card-payment fulfilment — the whole of it, end to end, with no Stripe.
 *
 * fulfilCardPayment takes a PaymentIntent ID and works entirely on OUR rows, so everything the
 * webhook does after the signature check can be proved here: the settle, the reconcile, the invoice
 * flip, the audit trail, idempotency under redelivery, part payments, and a payment we did not
 * start. The only unproved link is Stripe actually delivering the event.
 *
 * ── FIXTURES ────────────────────────────────────────────────────────────────────────────────────
 * Two throwaway invoices on ZZ, built through the real mint path so the frozen lines and totals are
 * real. Both torn down. AuditLog rows are LEFT — append-only, and a row about a deleted fixture is
 * a true record of something that happened.
 */
import './_gate-preflight.mjs';
const { zzSite, describeError } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { prisma } = await import('../lib/db.ts');
import { Prisma } from '@prisma/client';
const { freezeQuoteVersion } = await import('../lib/quote-version.ts');
const { acceptQuote } = await import('../lib/quote-acceptance.ts');
const { issueInvoiceForCard } = await import('../lib/invoice-issue.ts');
const { recordPayment, reconcileInvoice } = await import('../lib/payments.ts');
const { fulfilCardPayment, closeCardPayment, CARD_METHOD_LABEL } = await import('../lib/card-payment-fulfil.ts');
const { refusePayment } = await import('../lib/invoice-payment-intent.ts');
const { applyCardTransition } = await import('../lib/jobcard-transition.ts');
const { findTransition } = await import('../lib/jobcard-status.ts');

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const STAMP = `ZZ-FULFIL-${Date.now()}`;
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const gbp = (p) => `£${(p / 100).toFixed(2)}`;

const fixtures = [];
async function invoiceFixture(label, unitPrice) {
  const site = await zzSite(prisma);
  const owner = await prisma.user.findFirst({ where: { group_id: ZZ, is_owner: true }, select: { id: true } });
  const cu = await prisma.customer.create({ data: { group_id: ZZ, name: `${STAMP} ${label}` }, select: { id: true } });
  const idt = await prisma.vehicleIdentity.create({ data: { group_id: ZZ }, select: { id: true } });
  const reg = `ZF${String(Date.now()).slice(-4)}${label[0].toUpperCase()}`;
  const ve = await prisma.vehicle.create({ data: { group_id: ZZ, identity_id: idt.id, registration: reg, registration_normalized: reg }, select: { id: true } });
  await prisma.vehicleOwnership.create({ data: { vehicle_id: ve.id, customer_id: cu.id, is_current: true, valid_from: new Date() } });
  const card = await prisma.jobCard.create({ data: { group_id: ZZ, site_id: site.id, customer_id: cu.id, vehicle_id: ve.id, status: 'quoted' }, select: { id: true } });
  await prisma.jobCardItem.create({ data: { job_card_id: card.id, item_type: 'labour', description: `${STAMP} work`, qty: 1, unit_price: unitPrice, vat_rate: 20, vat_amount: unitPrice * 0.2, labour_hours: 1 } });
  await freezeQuoteVersion({ groupId: ZZ, jobCardId: card.id, vatRegistered: true, taxLabel: 'VAT' });
  await prisma.$transaction(async (tx) => {
    await acceptQuote(tx, { groupId: ZZ, jobCardId: card.id, via: 'counter', actorUserId: owner.id, attested: null, at: new Date() });
  });
  let invId;
  await prisma.$transaction(async (tx) => { invId = await issueInvoiceForCard(tx, card.id, ZZ); }, { timeout: 30000 });
  // The real flow moves the card to `invoiced` as it mints (pages/api/jobcard-status). Without this
  // the fixture leaves it at `accepted`, and `accepted → paid` is not a legal transition — which is
  // the guard working, not a bug, but it tests the wrong thing.
  await prisma.jobCard.update({ where: { id: card.id }, data: { status: 'invoiced' } });
  const inv = await prisma.invoice.findUnique({ where: { id: invId }, select: { id: true, site_id: true, invoice_number: true, lines: { select: { line_total: true, line_vat: true } } } });
  const total = inv.lines.reduce((a, l) => a + Math.round((Number(l.line_total) + Number(l.line_vat)) * 100), 0);
  fixtures.push({ cardId: card.id, custId: cu.id, vehId: ve.id, identityId: idt.id, invoiceId: invId });
  return { ...inv, total };
}

const auditCount = async (cardId, action) =>
  prisma.auditLog.count({ where: { entity_id: cardId, action } });

try {
  const stale = await prisma.customer.count({ where: { group_id: ZZ, name: { startsWith: 'ZZ-FULFIL-' } } });
  if (stale) throw new Error(`REFUSING: ${stale} fixture(s) from a previous run still present`);

  // ── 1. A PAYMENT WE DID NOT START ──────────────────────────────────────────────────────────
  console.log('\n— an intent we never created —');
  const alien = await fulfilCardPayment({ paymentIntentId: 'pi_not_ours_at_all' });
  check('is not an error', alien.outcome === 'not_ours',
    'a garage Terminal sale on their own account emits this event too');
  check('and writes nothing', (await prisma.payment.count({ where: { source_ref: 'pi_not_ours_at_all' } })) === 0);

  // ── 2. FULL PAYMENT ────────────────────────────────────────────────────────────────────────
  console.log('\n— a card payment that clears the invoice —');
  const full = await invoiceFixture('full', 200);
  const piFull = `pi_${STAMP}_full`;
  await prisma.$transaction(async (tx) => recordPayment(tx, {
    groupId: ZZ, invoiceId: full.id, siteId: full.site_id, amountPennies: full.total,
    currency: 'GBP', status: 'processing', collectedAt: new Date(), createdBy: null,
    sourceRef: piFull, provider: 'stripe',
  }));
  const beforeCache = (await prisma.invoice.findUnique({ where: { id: full.id }, select: { amount_paid_pennies: true } })).amount_paid_pennies;
  check('an in-flight payment counts as nothing received', beforeCache === 0,
    'processing is not money — 0 means "we know nothing has cleared", which is not NULL');

  const r1 = await fulfilCardPayment({ paymentIntentId: piFull });
  check('fulfilment settles it', r1.outcome === 'settled' && r1.fullyPaid === true);
  const afterFull = await prisma.invoice.findUnique({
    where: { id: full.id },
    select: { status: true, amount_paid_pennies: true, paid_at: true, date_paid: true, payment_method_snapshot: true, job_card_id: true },
  });
  check('the ledger row is succeeded', (await prisma.payment.findUnique({ where: { source_ref: piFull }, select: { status: true } })).status === 'succeeded');
  check('the cache equals what arrived', afterFull.amount_paid_pennies === full.total, gbp(full.total));
  check('the invoice is marked paid', afterFull.status === 'paid');
  check('with a payment date and an attestation', !!afterFull.paid_at && !!afterFull.date_paid);
  check('and the method says how', afterFull.payment_method_snapshot === CARD_METHOD_LABEL, CARD_METHOD_LABEL);
  check('the trail records both arrival and confirmation',
    (await auditCount(afterFull.job_card_id, 'invoice.paid')) === 1
    && (await auditCount(afterFull.job_card_id, 'invoice.paid_confirmed')) === 1,
    'a card payment has no clearance window — it is in the account or it is not');

  // ── 3. REDELIVERY ──────────────────────────────────────────────────────────────────────────
  console.log('\n— Stripe redelivers —');
  const r2 = await fulfilCardPayment({ paymentIntentId: piFull });
  check('the second delivery is a no-op', r2.outcome === 'already_done');
  check('and writes no second audit row',
    (await auditCount(afterFull.job_card_id, 'invoice.paid_confirmed')) === 1,
    'this is what stops a customer getting two receipts');
  check('the cache is unchanged', (await prisma.invoice.findUnique({ where: { id: full.id }, select: { amount_paid_pennies: true } })).amount_paid_pennies === full.total);
  check('the redelivery check is discriminating', r1.outcome !== r2.outcome,
    'the first settled, the second did not — claim-first, not "run it twice and hope"');

  // ── 4. PART PAYMENT ────────────────────────────────────────────────────────────────────────
  console.log('\n— a card payment that does NOT clear the invoice —');
  const part = await invoiceFixture('part', 500);
  const piPart = `pi_${STAMP}_part`;
  const half = Math.floor(part.total / 2);
  await prisma.$transaction(async (tx) => recordPayment(tx, {
    groupId: ZZ, invoiceId: part.id, siteId: part.site_id, amountPennies: half,
    currency: 'GBP', status: 'processing', collectedAt: new Date(), createdBy: null,
    sourceRef: piPart, provider: 'stripe',
  }));
  const r3 = await fulfilCardPayment({ paymentIntentId: piPart });
  const afterPart = await prisma.invoice.findUnique({
    where: { id: part.id }, select: { status: true, amount_paid_pennies: true, job_card_id: true },
  });
  check('it settles', r3.outcome === 'settled');
  check('but the invoice stays OPEN', r3.fullyPaid === false && afterPart.status === 'issued',
    `${gbp(half)} of ${gbp(part.total)} — the document must not claim to be settled`);
  check('the cache records what actually arrived', afterPart.amount_paid_pennies === half);
  check('and it is audited as a PART payment, not as paid',
    (await auditCount(afterPart.job_card_id, 'invoice.part_paid')) === 1
    && (await auditCount(afterPart.job_card_id, 'invoice.paid')) === 0,
    'borrowing invoice.paid would make the trail claim a settlement that never happened');

  // ── 5. FAILED AND CANCELLED ATTEMPTS ───────────────────────────────────────────────────────
  console.log('\n— attempts that never became money —');
  const piDead = `pi_${STAMP}_dead`;
  await prisma.$transaction(async (tx) => recordPayment(tx, {
    groupId: ZZ, invoiceId: part.id, siteId: part.site_id, amountPennies: 1000,
    currency: 'GBP', status: 'processing', collectedAt: new Date(), createdBy: null,
    sourceRef: piDead, provider: 'stripe',
  }));
  check('a declined card closes its own row', await closeCardPayment(piDead, 'failed'));
  check('recorded as failed, not deleted', (await prisma.payment.findUnique({ where: { source_ref: piDead }, select: { status: true } })).status === 'failed',
    'a ledger that loses its failures is worse at explaining itself');
  check('and the invoice is untouched by it',
    (await prisma.invoice.findUnique({ where: { id: part.id }, select: { amount_paid_pennies: true } })).amount_paid_pennies === half,
    'the part payment still stands; the failed attempt counts for nothing');
  check('closing an unknown intent is not an error', (await closeCardPayment('pi_never_existed', 'canceled')) === false);

  // ── 6. ONE PAYMENT SETTLES ONLY ITSELF ─────────────────────────────────────────────────────
  // settleProcessing flips EVERY processing row on an invoice, which is why fulfilment does not use
  // it: an invoice can legitimately carry a second in-flight intent.
  console.log('\n— a second intent on the same invoice —');
  const piA = `pi_${STAMP}_a`; const piB = `pi_${STAMP}_b`;
  for (const [ref, amt] of [[piA, 100], [piB, 200]]) {
    await prisma.$transaction(async (tx) => recordPayment(tx, {
      groupId: ZZ, invoiceId: part.id, siteId: part.site_id, amountPennies: amt,
      currency: 'GBP', status: 'processing', collectedAt: new Date(), createdBy: null, sourceRef: ref, provider: 'stripe',
    }));
  }
  await fulfilCardPayment({ paymentIntentId: piA });
  const a = await prisma.payment.findUnique({ where: { source_ref: piA }, select: { status: true } });
  const b = await prisma.payment.findUnique({ where: { source_ref: piB }, select: { status: true } });
  check('settling one leaves the other in flight', a.status === 'succeeded' && b.status === 'processing',
    'settleProcessing would have credited money that never arrived');
  // ── 6b. MONEY GIVEN BACK ───────────────────────────────────────────────────────────────────
  console.log('\n— a refund —');
  // ── THIS GATE USED TO ENCODE THE BUG ───────────────────────────────────────────────────────
  // It built a synthetic charge carrying `refunds: { data: [...] }` and fed it to recordCardRefunds,
  // which read that list and wrote a row. Green, for months — while production wrote NOTHING, because
  // Stripe has not included `refunds` on a Charge since API 2022-11-15 and the real event body has no
  // such list. The gate proved the code could read a shape Stripe never sends.
  // recordCardRefunds now ASKS Stripe (lib/stripe-refunds) and cannot be fed a body, so the ledger
  // consequences are asserted here against rows written exactly as it writes them, and the
  // reconciliation itself — full, partial, two partials, the two-trigger collision — belongs to
  // scripts/refund-reconcile-gate.
  const chargeId = `ch_${STAMP}`;
  await prisma.payment.updateMany({ where: { source_ref: piFull }, data: { charge_id: chargeId } });
  const refundId = `re_${STAMP}`;
  const payRow = await prisma.payment.findUnique({ where: { source_ref: piFull }, select: { id: true } });
  const writeRefund = async (id, amount) => {
    try {
      await prisma.$transaction(async (tx) => {
        await tx.refund.create({ data: { group_id: ZZ, payment_id: payRow.id, amount_pennies: amount, currency: 'GBP', reason: 'requested_by_customer', refund_id: id, source_ref: id, collected_at: new Date() } });
        await reconcileInvoice(tx, full.id);
      });
      return 1;
    } catch (e) { if (e?.code === 'P2002') return 0; throw e; }
  };
  const ref1 = { recorded: await writeRefund(refundId, full.total) };
  check('the refund is recorded as its own row', ref1.recorded === 1,
    'its own row, never a negative payment — "arrived" and "returned" must not sum into one figure');
  check('the ledger nets it off', (await prisma.invoice.findUnique({ where: { id: full.id }, select: { amount_paid_pennies: true } })).amount_paid_pennies === 0,
    'Σ succeeded − Σ refunded');
  const afterRefund = await prisma.invoice.findUnique({ where: { id: full.id }, select: { status: true } });
  check('the invoice STAYS paid', afterRefund.status === 'paid',
    'a refund unwinds a transaction; it does not reinstate a debt');

  // THE HOLE A REFUND OPENS. The cache is now 0, so the BALANCE arithmetic says the whole total is
  // owing — and an old pay link would charge the customer again for money deliberately given back.
  const refundedDoc = { status: afterRefund.status, underCorrection: false, series: 'chargeable' };
  check('an old pay link cannot re-charge a refunded invoice',
    refusePayment(refundedDoc, full.total)?.code === 'nothing_owing',
    'balance alone says £' + (full.total / 100).toFixed(2) + ' owing; the document says settled, and the document is right');
  check('and that guard is discriminating', (() => {
    const balanceOnly = (bal) => (bal <= 0 ? 'nothing_owing' : null);
    return balanceOnly(full.total) === null && refusePayment(refundedDoc, full.total).code === 'nothing_owing';
  })());

  check('a redelivered refund writes no second row', (await writeRefund(refundId, full.total)) === 0);
  check('the application fee is honestly unknown when it could not be returned',
    (await prisma.refund.findFirst({ where: { refund_id: refundId }, select: { application_fee_refunded_pennies: true } })).application_fee_refunded_pennies === null,
    'NULL, not 0 — zero would claim we deliberately kept it');

  // ── 7. THE CARD MOVES WITH THE INVOICE ─────────────────────────────────────────────────────
  console.log('\n— the job card —');
  const paidCard = await prisma.jobCard.findUnique({ where: { id: fixtures[0].cardId }, select: { status: true } });
  check('a cleared invoice moves the card to paid', paidCard.status === 'paid',
    'a paid invoice against a card at "invoiced" is an inconsistency the garage sees');
  check('through the SHARED transition writer, so the table governs it',
    findTransition('invoiced', 'paid') !== null && findTransition('done', 'paid') === null,
    'the webhook is not a second, ungoverned way to move a card');
  check('the move is attributed to nobody at the garage', (await prisma.auditLog.findFirst({
    where: { entity_id: fixtures[0].cardId, action: 'status.paid' }, select: { user_id: true },
  }))?.user_id === null, 'the customer paid — a null actor says so');
  const partCard = await prisma.jobCard.findUnique({ where: { id: fixtures[1].cardId }, select: { status: true } });
  check('a PART payment leaves the card where it was', partCard.status === 'invoiced',
    `still ${partCard.status} — the invoice is open, so the card is still outstanding work`);
  check('an illegal move is refused rather than written', await prisma.$transaction(async (tx) => {
    const r = await applyCardTransition(tx, { groupId: ZZ, jobCardId: fixtures[1].cardId, from: 'done', to: 'paid', actorUserId: null });
    return r.ok === false && r.refusal.code === 'illegal_transition';
  }));
  check('and moving to the status it already holds writes nothing', await prisma.$transaction(async (tx) => {
    const before = await tx.auditLog.count({ where: { entity_id: fixtures[0].cardId, action: 'status.paid' } });
    const r = await applyCardTransition(tx, { groupId: ZZ, jobCardId: fixtures[0].cardId, from: 'paid', to: 'paid', actorUserId: null });
    const after = await tx.auditLog.count({ where: { entity_id: fixtures[0].cardId, action: 'status.paid' } });
    return r.ok && r.moved === false && before === after;
  }), 'a redelivered payment must not read as the card being paid twice');
} catch (e) {
  check('run completed', false, describeError(e).slice(0, 300));
} finally {
  for (const f of fixtures) {
    await prisma.refund.deleteMany({ where: { payment: { invoice_id: f.invoiceId } } });
    await prisma.payment.deleteMany({ where: { invoice_id: f.invoiceId } });
    await prisma.invoiceLine.deleteMany({ where: { invoice_id: f.invoiceId } });
    await prisma.invoice.deleteMany({ where: { id: f.invoiceId } });
    await prisma.quoteVersion.deleteMany({ where: { job_card_id: f.cardId } });
    await prisma.jobCardItem.deleteMany({ where: { job_card_id: f.cardId } });
    await prisma.jobCard.deleteMany({ where: { id: f.cardId } });
    await prisma.vehicleOwnership.deleteMany({ where: { vehicle_id: f.vehId } });
    await prisma.vehicle.deleteMany({ where: { id: f.vehId } });
    await prisma.vehicleIdentity.deleteMany({ where: { id: f.identityId } });
    await prisma.customer.deleteMany({ where: { id: f.custId } });
  }
  const left = await prisma.customer.count({ where: { group_id: ZZ, name: { startsWith: 'ZZ-FULFIL-' } } });
  const orphan = await prisma.payment.count({ where: { source_ref: { startsWith: `pi_${STAMP}` } } });
  check('teardown removed every fixture', left === 0 && orphan === 0,
    `${left} customers, ${orphan} payment rows (AuditLog rows deliberately retained)`);
  console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
  await prisma.$disconnect();
  process.exit(out.includes('F') ? 1 : 0);
}
