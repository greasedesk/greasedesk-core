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
import { prisma } from '../lib/db.ts';
import { Prisma } from '@prisma/client';
import { freezeQuoteVersion } from '../lib/quote-version.ts';
import { acceptQuote } from '../lib/quote-acceptance.ts';
import { issueInvoiceForCard } from '../lib/invoice-issue.ts';
import { recordPayment } from '../lib/payments.ts';
import { fulfilCardPayment, closeCardPayment, CARD_METHOD_LABEL } from '../lib/card-payment-fulfil.ts';

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const STAMP = `ZZ-FULFIL-${Date.now()}`;
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const gbp = (p) => `£${(p / 100).toFixed(2)}`;

const fixtures = [];
async function invoiceFixture(label, unitPrice) {
  const site = await prisma.site.findFirst({ where: { group_id: ZZ }, select: { id: true } });
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
} catch (e) {
  check('run completed', false, String(e?.message ?? e).slice(0, 300));
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
