/**
 * File: scripts/pay-predicate-gate.mjs
 * @gate-requires: db
 * WHOSE FAULT IT IS, AND WHAT THE SHARED PREDICATE COVERS. Split out of pay-refusal-gate on
 * 2026-09-12 for a reason worth keeping:
 *
 * That gate's header states its premise — "the served build runs with a DELIBERATELY INVALID Stripe
 * key" — and never CHECKED it. When the key left this environment altogether, every clause that went
 * through payPreconditions began failing on `not_configured`: red for an environment reason, with
 * red text that named the symptom and not the requirement. A documented premise is not an asserted
 * one, and an unasserted premise fails as a lie about the code.
 *
 * So the assertions that need NO key live here and run every time. READ-ONLY: no ProviderConnection,
 * no magic link, no browser, nothing to tear down. The key-dependent leg stays in pay-refusal-gate,
 * which now declines to run when its premise is absent and says what it needs.
 *
 * The fee behaviour is proved against feeForPayment, which needs only the database; that the
 * PREDICATE reaches it and converts its throw into a refusal is proved by the unconfigured refusal
 * (a real ordering claim) and by reading the predicate's own source. The ok:true path needs a key
 * and is asserted wherever one exists — named here rather than faked.
 */
import './_gate-preflight.mjs';
const { describeError } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { prisma } = await import('../lib/db.ts');
const { isStripeError, classifyStripeError } = await import('../lib/stripe-errors.ts');
const { payPreconditions, canOfferCardPayment, refusePayment } = await import('../lib/invoice-payment-intent.ts');
const { feeForPayment } = await import('../lib/application-fee.ts');
const { readFileSync: readSrc } = await import('node:fs');
// KEY MATCHERS COME FROM ONE PLACE. A hand-written /code: 'no_rate'/ matches the substring and
// not the key, which is how a clause ends up true about the wrong object — anchored-match-gate
// caught this one the minute it was written.
const { hasKey } = await import('../lib/anchored-match.ts');
const { buildInvoiceDoc } = await import('../lib/invoice-doc.ts');
const { balanceOwedPennies } = await import('../lib/invoice.ts');

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const INV = 'b5c2ccd2-7b07-40e7-9228-067b25171750';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };

try {
  // ── 1. WHOSE FAULT IS IT? ──────────────────────────────────────────────────────────────────
  console.log('\n— our exceptions vs Stripe’s —');
  check('a plain Error is not a Stripe error', isStripeError(new Error('boom')) === false);
  const prismaish = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
  check('nor is a Prisma error', isStripeError(prismaish) === false,
    'this is the shape that was being logged as paymentIntents.create');
  check('a Stripe SDK error is', isStripeError({ type: 'StripeInvalidRequestError' }) === true);
  check('and the test is on the TYPE, not the presence of a code', isStripeError({ code: 'card_declined' }) === false,
    'a `code` alone belongs to plenty of things that are not Stripe');

  const asStripe = classifyStripeError(prismaish);
  check('classifying our own error yields UNKNOWN, non-retryable', asStripe.code === 'unknown' && asStripe.retryable === false,
    `${asStripe.code}/retryable=${asStripe.retryable} — the old path sent this to the customer as Stripe’s answer`);
  check('and it invents no Stripe message', asStripe.stripeMessage === null && asStripe.requestId === null,
    'honest-null: Stripe never answered, so there is nothing of Stripe’s to quote');

  // ── 2. THE FEE IS INSIDE THE SHARED PREDICATE ──────────────────────────────────────────────
  console.log('\n— what the predicate covers —');
  const doc = await buildInvoiceDoc(INV, ZZ);
  const inv = await prisma.invoice.findUnique({ where: { id: INV }, select: { amount_paid_pennies: true } });
  const total = doc.vatRegistered ? doc.totals.grossPennies : doc.totals.netPennies;
  const balance = balanceOwedPennies(inv, total);
  check('the fixture invoice has something to pay', refusePayment(doc, balance) === null && balance > 0, `£${(balance / 100).toFixed(2)}`);

  /**
   * ── WHAT THIS ENVIRONMENT CAN AND CANNOT PROVE (corrected 2026-09-12) ─────────────────────────
   * These four clauses used to call payPreconditions and require ok === true. There is no
   * STRIPE_SECRET_KEY in this environment, so its FIRST branch returns `not_configured` and every
   * one of them was asserting a state the fixture cannot reach — they were red for as long as the
   * keys have been absent, and red for a reason that says nothing about the code. free-not-checkout
   * -gate had already met this exact wall and written down the remedy: drive the layer that needs
   * no key, and say plainly which leg is left unproven.
   *
   * So: the FEE BEHAVIOUR is proved against feeForPayment, which needs only the database. The
   * INTEGRATION claim — that payPreconditions reaches that resolver and converts its throw into a
   * refusal — is proved two ways that are honest here: the unconfigured refusal itself (asserting
   * the env check comes first, which is a real ordering claim), and a source assertion that the
   * call and its catch sit INSIDE the predicate. What is NOT proved locally is the ok:true path;
   * that needs a key and is only exercised where one exists.
   */
  const fee = await feeForPayment(prisma, { groupId: ZZ, country: 'GB', currency: 'GBP', at: new Date(), amountPennies: balance });
  check('GBP resolves a fee, from the resolver the predicate uses', typeof fee.feePennies === 'number' && fee.feePennies >= 0 && !!fee.rateId,
    `${fee.feePennies}p, rate ${String(fee.rateId).slice(0, 8)}`);

  // THE CASE THAT USED TO ESCAPE. No rate exists for GB/EUR, so the fee resolution THROWS — which
  // the endpoint met as an exception and the page could not see at all.
  let eurThrew = null;
  try { await feeForPayment(prisma, { groupId: ZZ, country: 'GB', currency: 'EUR', at: new Date(), amountPennies: balance }); }
  catch (e) { eurThrew = describeError(e); }   // describeError, not the bare-message idiom: a message-less error must still name its class
  check('a currency with NO rate THROWS in the resolver', eurThrew !== null,
    eurThrew ? eurThrew.slice(0, 70) : 'resolved a fee for a currency with no rate — a zero fee looks like a working integration');
  check('  …and the discriminator: the same resolver answers GBP', !!fee.rateId && eurThrew !== null,
    'GBP resolves, EUR throws — one resolver, two answers, so neither result is a constant');

  // …AND THE PREDICATE TURNS THAT THROW INTO A REFUSAL THE PAGE CAN SEE. Source, because the
  // behavioural leg needs a key; a comment claiming it would expire silently (see impossibility-claims).
  const payerSrc = readSrc('lib/invoice-payment-intent.ts', 'utf8');
  const predicate = payerSrc.slice(payerSrc.indexOf('export async function payPreconditions'),
    payerSrc.indexOf('export async function canOfferCardPayment'));
  check('the fee resolution is INSIDE the predicate, with its throw caught', /feeForPayment\(/.test(predicate)
    && /catch\s*\(/.test(predicate) && hasKey(predicate, 'code', "'no_rate'"),
    'the original defect was the fee sitting outside it entirely');
  check('  …and the page asks the predicate rather than re-deciding', /return \(await payPreconditions\(args\)\)\.ok/.test(payerSrc),
    'a button that appears and then refuses reads as a broken product');

  // THE UNCONFIGURED ANSWER IS ITSELF AN ASSERTION. A customer in an environment with no keys must
  // get one sentence, not a crash — and this proves the env check precedes the garage's own state.
  const unconfigured = await payPreconditions({ groupId: ZZ, doc, balancePennies: balance });
  const keyPresent = !!process.env.STRIPE_SECRET_KEY;
  check(keyPresent ? 'with a key present, GBP resolves through the predicate' : 'with NO key, the predicate refuses not_configured — it does not throw',
    keyPresent ? (unconfigured.ok === true && typeof unconfigured.feePennies === 'number')
           : (unconfigured.ok === false && unconfigured.refusal.code === 'not_configured'),
    keyPresent ? `ok=${unconfigured.ok}` : `refused ${unconfigured.refusal?.code} — and this clause flips to the ok:true assertion the moment a key exists`);
  check('  …and the PAGE is told the same thing, through the same predicate',
    (await canOfferCardPayment({ groupId: ZZ, doc, balancePennies: balance })) === unconfigured.ok,
    'the page and the endpoint must not disagree, whichever answer the environment gives');


  // A DOCUMENT refusal is settled too, and must say so — and the ORDER is the assertion: never
  // "card payments aren’t switched on" about an invoice that is already paid.
  const paid = await prisma.invoice.findFirst({ where: { group_id: ZZ, status: 'paid' }, select: { id: true } });
  if (paid) {
    const paidDoc = await buildInvoiceDoc(paid.id, ZZ);
    const r = refusePayment(paidDoc, 0);
    check('a settled invoice refuses on the DOCUMENT, before any configuration', r?.code === 'nothing_owing',
      'and this one holds with or without a key, which is the point of it living here');
  } else {
    check('a paid ZZ invoice exists to prove document-order', false, 'none — UNPROVEN');
  }
} catch (e) {
  check('run completed', false, describeError(e).slice(0, 300));
} finally {
  console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
  await prisma.$disconnect();
  process.exit(out.includes('F') ? 1 : 0);
}
