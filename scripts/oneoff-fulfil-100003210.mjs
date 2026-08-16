/**
 * File: scripts/oneoff-fulfil-100003210.mjs
 * ONE-OFF. Fulfil a real card payment on the LIVE customer tenant (TMBS, GB-GD1967) whose
 * payment_intent.succeeded was never delivered — the Connect endpoint was not subscribed to
 * payment_intent.* at the time, and the event cannot be replayed.
 *
 *   invoice  100003210   £50.00   169efe26-68a9-4b22-9f24-ef2a807d387b
 *   intent   pi_3U4zmDReZSnKwwOj1zF9hwuj   succeeded, amount_received 5000, livemode
 *   charge   ch_3U4zmDReZSnKwwOj1mY9loTk   application fee 12p collected
 *   account  acct_1U4cjoReZSnKwwOj
 *
 * ── THIS IS NOT A FIXTURE ───────────────────────────────────────────────────────────────────────
 * Every standing rule about ZZ-only fixtures exists to keep scripts away from exactly this tenant.
 * This one is deliberately pointed at it, so it is built to refuse rather than to proceed:
 *   • DRY RUN BY DEFAULT. Writes nothing unless FULFIL_APPLY=yes.
 *   • It re-reads every row and refuses unless the state still matches what was captured and
 *     reported. If anything moved since — a webhook landed late, someone marked it paid by hand —
 *     the safe answer is to stop and look, not to write over it.
 *   • It refuses any payment intent but this one.
 *   • It goes through fulfilCardPayment, the SAME chokepoint the webhook uses. Nothing here writes
 *     an invoice, a payment or a card status directly.
 *
 * ── THE TIMESTAMP IS PASSED, NEVER DEFAULTED ────────────────────────────────────────────────────
 * fulfilCardPayment stamps Payment.collected_at, Invoice.paid_at and Invoice.date_paid from `at`,
 * which defaults to NOW. Running this today with the default would record the money as arriving at
 * the moment of the repair rather than when the customer paid. date_paid is a VAT-relevant document
 * date. So `at` is supplied explicitly, and its provenance is stated below.
 */
import './_ts.mjs';
const { prisma } = await import('../lib/db.ts');
const { fulfilCardPayment } = await import('../lib/card-payment-fulfil.ts');
const { invoiceTotals } = await import('../lib/invoice.ts');

const PI = 'pi_3U4zmDReZSnKwwOj1zF9hwuj';
const INV = '169efe26-68a9-4b22-9f24-ef2a807d387b';
const GROUP = '854d38e7-6dd4-4836-af61-a0d169639a78';       // TMBS
const CARD = '24c0a3c0-1e71-48f6-9157-2213db779c29';

/**
 * WHEN THE MONEY ARRIVED — the CHARGE's own `created`, not an inference from the dashboard clock.
 *
 *   charge  ch_…1mY9loTk   created 1786870307  = 2026-08-16T08:51:47Z   ← this
 *   intent  pi_…1zF9hwuj   created 1786870245  = 2026-08-16T08:50:45Z   (matches the captured
 *                                                 Payment.collected_at to the second)
 *   fee     fee_…I2h13srL  created 1786870310  = 2026-08-16T08:51:50Z
 *
 * The three corroborate each other and bracket the authorisation to a 65-second window, which is
 * what a card payment looks like. fulfilCardPayment stamps Payment.collected_at, Invoice.paid_at
 * and Invoice.date_paid from this; date_paid is a VAT-relevant document date, so it is the charge's
 * timestamp or nothing. `at` is NEVER allowed to default to now on a repair — that would record the
 * money as arriving at the moment someone noticed it had not.
 */
const AT = new Date(1786870307 * 1000);

const APPLY = process.env.FULFIL_APPLY === 'yes';
const fail = (m) => { console.error(`\n✗ REFUSING: ${m}`); process.exit(1); };

try {
  // ── CAPTURE ────────────────────────────────────────────────────────────────────────────────
  const pay = await prisma.payment.findUnique({ where: { source_ref: PI } });
  const inv = await prisma.invoice.findUnique({
    where: { id: INV },
    select: {
      id: true, invoice_number: true, group_id: true, job_card_id: true, status: true,
      amount_paid_pennies: true, paid_at: true, date_paid: true, confirm_due_at: true,
      payment_method_snapshot: true, vat_registered_at_issue: true,
      lines: { select: { vat_rate: true, line_total: true, line_vat: true } },
    },
  });
  const card = await prisma.jobCard.findUnique({ where: { id: CARD }, select: { id: true, status: true } });
  const auditBefore = await prisma.auditLog.count({ where: { entity: 'job_card', entity_id: CARD } });

  // ── REFUSE UNLESS THE WORLD IS AS REPORTED ─────────────────────────────────────────────────
  if (!pay) fail('no Payment row for that intent');
  if (pay.source_ref !== PI) fail('wrong payment row');
  if (pay.invoice_id !== INV) fail(`payment belongs to invoice ${pay.invoice_id}, not ${INV}`);
  if (pay.group_id !== GROUP) fail('payment is not on the expected tenant');
  if (pay.status !== 'processing') fail(`payment is already '${pay.status}' — someone or something got there first; stop and look`);
  if (pay.amount_pennies !== 5000) fail(`payment is ${pay.amount_pennies}p, expected 5000`);
  if (!inv || inv.status !== 'issued') fail(`invoice is '${inv?.status}', expected 'issued'`);
  if (inv.amount_paid_pennies !== 0) fail(`invoice already records ${inv.amount_paid_pennies}p received`);
  if (inv.paid_at || inv.date_paid) fail('invoice already carries a paid date');
  if (card?.status !== 'invoiced') fail(`job card is '${card?.status}', expected 'invoiced'`);
  if (await prisma.refund.count({ where: { payment: { invoice_id: INV } } })) fail('a refund exists — do not settle');

  const t = invoiceTotals(inv.lines);
  const total = inv.vat_registered_at_issue ? t.grossPennies : t.netPennies;
  const fullyPaid = total - (inv.amount_paid_pennies ?? 0) - 5000 <= 0;

  // ── WHAT THE CALL WILL WRITE ───────────────────────────────────────────────────────────────
  console.log('\n══ WHAT fulfilCardPayment WILL WRITE ══════════════════════════════════════════');
  console.log(`  at = ${AT.toISOString()}  (Stripe authorisation, 09:51 BST → 08:51 UTC)\n`);
  console.log(`  Payment ${pay.id}`);
  console.log(`    status        processing → succeeded`);
  console.log(`    collected_at  ${pay.collected_at.toISOString()} → ${AT.toISOString()}`);
  console.log(`\n  Invoice ${inv.invoice_number}  (frozen lines total ${total}p = net ${t.netPennies} + vat ${t.vatPennies})`);
  console.log(`    amount_paid_pennies      0 → 5000        (recomputed from the ledger, not assigned)`);
  console.log(`    status                   issued → paid   (fullyPaid = ${fullyPaid})`);
  console.log(`    paid_at                  null → ${AT.toISOString()}`);
  console.log(`    date_paid                null → ${AT.toISOString()}   ← VAT-relevant document date`);
  console.log(`    confirm_due_at           ${inv.confirm_due_at ?? 'null'} → null`);
  console.log(`    payment_method_snapshot  null → 'Card (online)'`);
  console.log(`\n  JobCard ${CARD}`);
  console.log(`    status        invoiced → paid   (through applyCardTransition, the shared writer)`);
  console.log(`\n  AuditLog  ${auditBefore} rows now → +2 (invoice.paid, invoice.paid_confirmed), userId null`);
  console.log(`            plus whatever applyCardTransition writes for the status move`);
  console.log(`\n  NOT WRITTEN HERE:`);
  console.log(`    charge_id / application_fee_id / stripe_fee_pennies — enrichCardPayment needs a`);
  console.log(`      live Stripe key, which this machine does not have. They stay NULL.`);
  console.log(`    the receipt — fulfilCardPayment does not send it; the webhook does, afterwards.`);
  console.log(`      Sending is outward-facing and is a separate, separately-approved step.`);

  if (!APPLY) {
    console.log('\n══ DRY RUN — nothing written. Re-run with FULFIL_APPLY=yes to apply. ═══════════\n');
    await prisma.$disconnect();
    process.exit(0);
  }

  // ── APPLY ──────────────────────────────────────────────────────────────────────────────────
  console.log('\n══ APPLYING ═══════════════════════════════════════════════════════════════════');
  const r = await fulfilCardPayment({ paymentIntentId: PI, at: AT });
  console.log('  outcome:', JSON.stringify(r));

  // ── VERIFY THE ROWS (the served-surface checks are a separate pass) ────────────────────────
  const pay2 = await prisma.payment.findUnique({ where: { source_ref: PI }, select: { status: true, collected_at: true } });
  const inv2 = await prisma.invoice.findUnique({ where: { id: INV }, select: { status: true, amount_paid_pennies: true, paid_at: true, date_paid: true, payment_method_snapshot: true } });
  const card2 = await prisma.jobCard.findUnique({ where: { id: CARD }, select: { status: true } });
  const auditAfter = await prisma.auditLog.findMany({
    where: { entity: 'job_card', entity_id: CARD }, orderBy: { created_at: 'desc' }, take: 4,
    select: { action: true, created_at: true, user_id: true },
  });
  console.log('\n  Payment :', JSON.stringify(pay2));
  console.log('  Invoice :', JSON.stringify(inv2));
  console.log('  JobCard :', JSON.stringify(card2));
  console.log(`  Audit   : ${auditBefore} → ${await prisma.auditLog.count({ where: { entity: 'job_card', entity_id: CARD } })}`);
  for (const a of auditAfter) console.log(`            ${a.created_at.toISOString()}  ${a.action}  user=${a.user_id ?? 'null (the customer paid)'}`);
  console.log('\n══ DONE ═══════════════════════════════════════════════════════════════════════\n');
} finally {
  await prisma.$disconnect();
}
