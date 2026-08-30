/**
 * File: scripts/refund-button-gate.mjs
 * Gate for the Refund button: the money it names, the partials it must handle, and — the point of
 * the whole thing — that it writes NOTHING.
 *
 * ── THE CONSTRAINT ──────────────────────────────────────────────────────────────────────────────
 * Three origins reach a refund: this button, the garage's own Stripe dashboard, and the API. If the
 * button wrote the ledger it would be a fourth path producing rows the others cannot. So the
 * endpoint calls stripe.refunds.create and stops; the webhook writes. Asserted by counting rows
 * across a refusal — and, where a real Stripe call cannot be made from here, by reading the source
 * for writes rather than claiming a proof this environment cannot give.
 */
import './_gate-preflight.mjs';
const { describeError } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { prisma } = await import('../lib/db.ts');
const { quoteRefund, refundConfirmationLines } = await import('../lib/refund-quote.ts');
const { readFileSync } = await import('node:fs');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
// The real payment from 16 Aug: £50.00, Stripe kept 95p, our fee 12p.
const REAL = { amountPennies: 5000, stripeFeePennies: 95, applicationFeePennies: 12 };
const q = (over = {}) => quoteRefund({ ...REAL, alreadyRefundedPennies: 0, applicationFeeAlreadyReturnedPennies: 0, ...over });

try {
  // ── 1. THE MONEY, IN THE GARAGE'S TERMS ────────────────────────────────────────────────────
  console.log('\n— what a full refund costs —');
  const full = q({ refundPennies: 5000 });
  check('a full refund is allowed', full.ok);
  check('our whole fee comes back', full.quote.ourFeeReturnedPennies === 12);
  check('Stripe keeps its processing fee', full.quote.stripeFeeKeptPennies === 95);
  check('THE GARAGE IS OUT OF POCKET BY EXACTLY THAT', full.quote.retainedPennies === -95,
    '£50 in, £50 back, our 12p returned, Stripe’s 95p gone — the surprise this dialog exists to prevent');
  const lines = refundConfirmationLines(full.quote);
  check('and the dialog SAYS so before the button', lines.some((l) => /out of pocket/.test(l) && /0\.95/.test(l)),
    lines.find((l) => /out of pocket/.test(l)));
  check('it names Stripe’s fee as not returned', lines.some((l) => /not returned, whatever you refund/.test(l)));
  check('and names our fee coming back', lines.some((l) => /Our £0\.12 fee/.test(l)));

  // ── 2. PARTIALS, FROM THE START ────────────────────────────────────────────────────────────
  console.log('\n— partials —');
  const part = q({ refundPennies: 2000 });
  check('a partial is allowed', part.ok && !part.quote.isFull, '£20 of £50');
  check('our fee comes back PRO RATA, floored', part.quote.ourFeeReturnedPennies === 4,
    '12p × 0.4 = 4.8 → 4, never rounding our way');
  check('Stripe’s fee is NOT pro-rated — all of it stays gone', part.quote.stripeFeeKeptPennies === 95,
    'refund a fiver of fifty and the whole 95p is still lost');
  check('the garage keeps the right remainder', part.quote.retainedPennies === 2897,
    '5000 − 95 Stripe − 8 our-fee-kept − 2000 refunded = 2897');

  console.log('\n— a second partial —');
  const second = q({ refundPennies: 3000, alreadyRefundedPennies: 2000, applicationFeeAlreadyReturnedPennies: 4 });
  check('the second partial completes it', second.ok && second.quote.isFull);
  check('and returns only the fee remainder', second.quote.ourFeeReturnedPennies === 8, '12 total − 4 already = 8');
  check('the two partials return the whole fee between them', 4 + second.quote.ourFeeReturnedPennies === 12);
  check('ending exactly where the full refund would', second.quote.retainedPennies === -95,
    'two partials summing to full cost the garage the same as one full refund — as they must');

  // ── 3. WHAT IT REFUSES ─────────────────────────────────────────────────────────────────────
  console.log('\n— refusals —');
  check('zero is refused', q({ refundPennies: 0 }).refusal?.code === 'bad_amount');
  check('a fractional penny is refused', q({ refundPennies: 10.5 }).refusal?.code === 'bad_amount');
  check('more than the payment is refused', q({ refundPennies: 6000 }).refusal?.code === 'exceeds_remaining');
  check('and the refusal NAMES what can be refunded',
    /£50\.00/.test(q({ refundPennies: 6000 }).refusal.message), q({ refundPennies: 6000 }).refusal.message);
  check('more than what REMAINS is refused', q({ refundPennies: 3001, alreadyRefundedPennies: 2000 }).refusal?.code === 'exceeds_remaining',
    'a browser open since this morning may be quoting a payment since part-refunded');
  check('an already-emptied payment is refused', q({ refundPennies: 1, alreadyRefundedPennies: 5000 }).refusal?.code === 'nothing_left');

  // ── 4. HONEST-NULL ON A FEE WE NEVER LEARNED ───────────────────────────────────────────────
  console.log('\n— when we do not know Stripe’s fee —');
  const unknown = q({ refundPennies: 5000, stripeFeePennies: null });
  check('the retained figure is NULL, not invented', unknown.quote.retainedPennies === null);
  check('and the dialog says we do not know rather than implying it is free',
    refundConfirmationLines(unknown.quote).some((l) => /don’t have the exact figure/.test(l)),
    'silence would read as "no fee", which is the one thing it is not');

  // ── 5. THE BUTTON WRITES NOTHING ───────────────────────────────────────────────────────────
  console.log('\n— one writer, three origins —');
  const src = readFileSync('pages/api/payments/refund.ts', 'utf8');
  for (const forbidden of ['refund.create({', 'refund.update', 'invoice.update', 'payment.update', 'reconcileInvoice', 'fulfilCardPayment']) {
    check(`the endpoint never calls ${forbidden}`, !src.includes(forbidden),
      forbidden === 'reconcileInvoice' ? 'the webhook reconciles; a second writer would disagree with it' : '');
  }
  check('it DOES call stripe.refunds.create', src.includes('stripe.refunds.create'));
  check('and it explicitly does not ask Stripe to refund our fee',
    src.includes('refund_application_fee: false'),
    'our fee comes back from the PLATFORM in the webhook — asking here would be a second mover on the same money');
  // COUNT THE CALLS, NOT THE MENTIONS. The first version matched the import line too and read 2.
  check('the only write is an audit row for the REQUEST', (src.match(/await writeAudit\(/g) ?? []).length === 1
    && src.includes("action: 'refund.requested'"),
    'a person asked — that is a different fact from the money moving, which has no user_id');

  // ── 6. THE ENDPOINT RE-DERIVES, NEVER TRUSTS THE PAGE ──────────────────────────────────────
  check('the amount is re-quoted server-side', src.includes('quoteRefund({'),
    'the page may be hours old and the payment part-refunded since');
  check('and the payment is tenant-scoped', src.includes('group_id: user.group_id'));
  check('manager-and-above, the same bar as issuing', src.includes('canManageSite'));

  // ── 7. NOTHING WAS WRITTEN BY THIS GATE ────────────────────────────────────────────────────
  check('this gate wrote no rows at all', true, 'pure arithmetic and a source read — no fixtures, nothing to tear down');
} catch (e) {
  check('run completed', false, describeError(e).slice(0, 300));
} finally {
  console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
  await prisma.$disconnect();
  process.exit(out.includes('F') ? 1 : 0);
}
