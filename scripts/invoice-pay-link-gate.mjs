/**
 * File: scripts/invoice-pay-link-gate.mjs
 * Gate for the invoice_pay magic link: the lifetime rule, the receipt rule, the under-correction
 * predicate, and the mint's own refusal.
 *
 * ── RULE 1: AGAINST THE REAL FUNCTIONS ──────────────────────────────────────────────────────────
 * invoicePayExpiry, offersPayLink and isUnderCorrection are imported, never reimplemented. The
 * discrimination checks reconstruct the BEHAVIOUR BEING REPLACED (a flat 14-day link) and confirm
 * the assertions go red against it.
 *
 * ── RULE 2: THE DB LEG TOUCHES NOTHING IT DID NOT CREATE ────────────────────────────────────────
 * It mints a link against an EXISTING ZZ invoice — read-only as far as the ledger is concerned, so
 * no invoice number is spent — and deletes only the link rows it wrote, matched on their own ids.
 */
import './_gate-preflight.mjs';
import { prisma } from '../lib/db.ts';
import { MAGIC_LINK_DAYS, INVOICE_PAY_GRACE_DAYS, invoicePayExpiry, createMagicLink, resolveMagicLink, magicLinkUrl } from '../lib/magic-link.ts';
import { offersPayLink } from '../lib/invoice-pay-link.ts';
import { canEditInvoice, isUnderCorrection } from '../lib/invoice.ts';
import { expectedCachePennies } from '../lib/payments.ts';
import { amountReceivedPennies, balanceOwedPennies } from '../lib/invoice.ts';

const GATE_REF = 'GB-GD2141';
const DAY = 24 * 60 * 60 * 1000;
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const days = (from, to) => Math.round((to.getTime() - from.getTime()) / DAY);

const NOW = new Date('2026-08-15T12:00:00Z');
const doc = (o = {}) => ({ status: 'issued', underCorrection: false, series: 'chargeable', vatRegistered: true, totals: { grossPennies: 94000, netPennies: 78333 }, ...o });

const minted = [];
try {
  // ── 1. HOW LONG A PAY LINK LIVES ───────────────────────────────────────────────────────────
  console.log('\n— link lifetime —');
  const issued = new Date('2026-08-15T09:00:00Z');

  check('an account invoice due in 30 days lives 30 days past the DUE date',
    days(NOW, invoicePayExpiry({ dueDate: new Date('2026-09-14T00:00:00Z'), issuedAt: issued }, NOW)) === 60,
    'due+30, not mint+14');
  check('a null due date falls back to 30 days from issue',
    days(NOW, invoicePayExpiry({ dueDate: null, issuedAt: issued }, NOW)) === 30,
    'the COMMON path — due_date is only set for account customers');
  check('a link is never minted already dead',
    days(NOW, invoicePayExpiry({ dueDate: null, issuedAt: new Date('2026-01-01T00:00:00Z') }, NOW)) === MAGIC_LINK_DAYS,
    're-sending a seven-month-old invoice still gives a usable fortnight');
  check('a long-overdue account invoice also floors at 14 days',
    days(NOW, invoicePayExpiry({ dueDate: new Date('2026-02-01T00:00:00Z'), issuedAt: issued }, NOW)) === MAGIC_LINK_DAYS);
  check('the grace is the stated 30 days', INVOICE_PAY_GRACE_DAYS === 30);

  // THE SCENARIO THAT PROMPTED THE RULE, asserted as itself rather than as arithmetic.
  check('a garage chasing an account customer at day 25 finds the link ALIVE', (() => {
    const issuedAt = new Date('2026-08-01T09:00:00Z');
    const dueDate = new Date('2026-08-31T09:00:00Z');          // 30-day terms
    const expiry = invoicePayExpiry({ dueDate, issuedAt }, issuedAt);
    const dayTwentyFive = new Date(issuedAt.getTime() + 25 * DAY);
    return expiry > dayTwentyFive;
  })(), 'and under the old flat rule it would have died on day 14');

  // THE GATE MUST BE ABLE TO FAIL. The behaviour being replaced was a flat 14 days from mint.
  check('these lifetime checks are discriminating', (() => {
    const flat = (now) => new Date(now.getTime() + MAGIC_LINK_DAYS * DAY);
    const issuedAt = new Date('2026-08-01T09:00:00Z');
    const dueDate = new Date('2026-08-31T09:00:00Z');
    const dayTwentyFive = new Date(issuedAt.getTime() + 25 * DAY);
    return flat(issuedAt) < dayTwentyFive                                   // old rule: dead at 25
      && days(NOW, flat(NOW)) !== 60                                        // old rule: not due+30
      && days(NOW, flat(NOW)) !== 30;                                       // old rule: not issue+30
  })(), 'a flat 14-day link fails three of the assertions above');

  // ── 2. A RECEIPT MUST NOT CARRY A DEMAND ───────────────────────────────────────────────────
  console.log('\n— which documents offer a link —');
  check('an issued invoice with a balance offers a link', offersPayLink(doc()) === true);
  check('a PAID invoice does not', offersPayLink(doc({ status: 'paid' })) === false,
    'two of the four sendInvoiceEmail callers are receipts');
  check('a pending payment does not', offersPayLink(doc({ status: 'paid_pending' })) === false);
  check('a settled warranty does not', offersPayLink(doc({ status: 'settled' })) === false);
  check('a VOID invoice does not', offersPayLink(doc({ status: 'void' })) === false, 'there is nothing to pay');
  check('an invoice UNDER CORRECTION does not', offersPayLink(doc({ underCorrection: true })) === false,
    'the amount is not final and a different one is coming');
  check('a warranty document does not', offersPayLink(doc({ series: 'warranty' })) === false, '£0.00 due by construction');
  check('a zero-total document does not', offersPayLink(doc({ totals: { grossPennies: 0, netPennies: 0 } })) === false);
  check('a non-VAT tenant is judged on its NET total', offersPayLink(doc({ vatRegistered: false, totals: { grossPennies: 0, netPennies: 5000 } })) === true,
    'reading grossPennies unconditionally would deny every non-registered garage a link');
  // Deliberate: unknown paid amount still gets a LINK — the document is a real demand and the link
  // is also how the customer reads it. Refusing an unknown balance is the PAY button's job.
  check('an unknown paid amount does not withhold the link', offersPayLink(doc()) === true,
    'the customer view says the balance must come from the garage');

  check('the receipt rule is discriminating', (() => {
    const naive = (d) => d.status !== 'void';   // a plausible wrong rule
    return naive(doc({ status: 'paid' })) === true && offersPayLink(doc({ status: 'paid' })) === false;
  })(), 'a "not void" test would put Pay now on every receipt');

  // ── 3. UNDER CORRECTION IS ONE FUNCTION WITH TWO NAMES ─────────────────────────────────────
  console.log('\n— under correction —');
  check('the customer-facing name IS the garage-facing predicate', isUnderCorrection === canEditInvoice,
    'an alias cannot drift from its original; a second implementation can');
  check('an unlocked invoice is detected', isUnderCorrection({ status: 'issued', hasFrozenLines: false }) === true);
  check('an ordinary issued invoice is NOT', isUnderCorrection({ status: 'issued', hasFrozenLines: true }) === false);
  check('a paid invoice with no lines is not "under correction"', isUnderCorrection({ status: 'paid', hasFrozenLines: false }) === false,
    'status alone and lines alone are both wrong; it takes both');
  check('the state is invisible to a status-only reader', (() => {
    const statusOnly = (i) => i.status === 'issued';           // what a new reader writes
    const unlocked = { status: 'issued', hasFrozenLines: false };
    return statusOnly(unlocked) === true && isUnderCorrection(unlocked) === true;
  })(), 'both say "issued" — only this predicate says the document is blank');

  // ── 3b. WHAT IS OWED ───────────────────────────────────────────────────────────────────────
  // The backfill changed what an absent ledger figure MEANS, and the customer view was left
  // reading the old meaning: it told every unpaid invoice's customer to ring the garage instead of
  // showing them the amount. These assert the new reading and the thing that makes it safe.
  console.log('\n— what is owed —');
  check('no ledger figure now reads as nothing received', amountReceivedPennies({ amount_paid_pennies: null }) === 0,
    'before the backfill this was "unknown" and had to stay unknown');
  check('an unpaid invoice owes its whole total', balanceOwedPennies({ amount_paid_pennies: null }, 94000) === 94000,
    'the case a pay link exists for — it rendered "contact the garage" for a few hours');
  check('a part payment is subtracted', balanceOwedPennies({ amount_paid_pennies: 20000 }, 94000) === 74000);
  check('a settled invoice owes nothing', balanceOwedPennies({ amount_paid_pennies: 94000 }, 94000) === 0);
  check('an overpayment is reported as credit, not clamped to zero',
    balanceOwedPennies({ amount_paid_pennies: 100000 }, 94000) === -6000,
    'clamping would hide an overpayment the garage needs to know about');
  check('zero received and unknown are the same ANSWER but not the same fact', (() => {
    // expectedCachePennies still distinguishes them at the LEDGER; only the product reading merged.
    return expectedCachePennies([], []) === null
      && expectedCachePennies([{ status: 'processing', amount_pennies: 500 }], []) === 0
      && amountReceivedPennies({ amount_paid_pennies: null }) === amountReceivedPennies({ amount_paid_pennies: 0 });
  })(), 'the ledger keeps the distinction; the balance no longer needs it');
  check('the derivation is discriminating', (() => {
    const old = (inv, total) => (inv.amount_paid_pennies == null ? null : total - inv.amount_paid_pennies);
    return old({ amount_paid_pennies: null }, 94000) === null      // the shipped bug: no figure
      && balanceOwedPennies({ amount_paid_pennies: null }, 94000) === 94000;
  })(), 'the old reading returned null here, which is what rendered the wrong sentence');

  // ── 4. THE MINT REFUSES A PAY LINK WITH NO INVOICE ─────────────────────────────────────────
  console.log('\n— minting —');
  let refused = false;
  try {
    await createMagicLink({ groupId: 'x', jobCardId: 'y', purpose: 'invoice_pay', recipient: 'a@b.c' });
  } catch (e) { refused = String(e?.message) === 'MAGIC:invoice_pay_requires_invoice'; }
  check('invoice_pay without an invoice is refused at the mint', refused,
    'it would resolve to a card and render the wrong money');

  // ── 5. ROUND TRIP, ON AN EXISTING ZZ INVOICE ───────────────────────────────────────────────
  const g = await prisma.group.findUnique({ where: { ref: GATE_REF }, select: { id: true } });
  if (!g) throw new Error(`gate tenant ${GATE_REF} not found`);
  const inv = await prisma.invoice.findFirst({
    where: { group_id: g.id, status: 'issued' },
    select: { id: true, job_card_id: true, invoice_number: true, due_date: true, issued_at: true },
    orderBy: { issued_at: 'desc' },
  });
  if (!inv) throw new Error('no issued ZZ invoice to bind a link to');

  const link = await createMagicLink({
    groupId: g.id, jobCardId: inv.job_card_id, invoiceId: inv.id,
    purpose: 'invoice_pay', recipient: 'gate@zzgategarage.test',
    expiresAt: invoicePayExpiry({ dueDate: inv.due_date, issuedAt: inv.issued_at }),
  });
  minted.push(link.id);
  const res = await resolveMagicLink(link.rawToken, { recordUse: false });
  check('the minted link resolves', res.ok === true);
  check('it names its INVOICE, not just the card', res.ok && res.link.invoiceId === inv.id, `invoice ${inv.invoice_number}`);
  check('it carries the invoice_pay purpose', res.ok && res.link.purpose === 'invoice_pay');
  // Asserted against the PRODUCTION origin explicitly. Reading link.url would test whatever
  // NEXT_PUBLIC_APP_URL happens to be on the machine running the gate — it returned 40 locally and
  // the check "passed" on a number that means nothing. The SMS budget was sized for the real one.
  const prodUrl = magicLinkUrl('0123456789abcdef', 'https://greasedesk.com');
  check('a pay link is the same 41-character URL the SMS budget was sized for',
    prodUrl.length === 41 && prodUrl.split('/c/')[1].length === 16,
    `${prodUrl.length} chars — invoice_pay reuses the quote token shape, so piece 3 inherits the budget`);

  // A quote link on the same card must still resolve with a NULL invoice — the column is additive
  // and must not have changed what a quote link means.
  const q = await createMagicLink({ groupId: g.id, jobCardId: inv.job_card_id, purpose: 'quote_view', recipient: 'gate@zzgategarage.test' });
  minted.push(q.id);
  const qr = await resolveMagicLink(q.rawToken, { recordUse: false });
  check('a quote link still carries no invoice', qr.ok && qr.link.invoiceId === null, 'additive, not a change of meaning');
  check('and keeps the flat 14-day lifetime', days(new Date(), q.expiresAt) === MAGIC_LINK_DAYS);
} catch (e) {
  check('run completed', false, String(e?.message ?? e).slice(0, 300));
} finally {
  // Scoped to the rows this run minted, by id. Nothing else on ZZ is in scope, and the invoices
  // themselves were only ever read.
  if (minted.length) {
    const del = await prisma.customerMagicLink.deleteMany({ where: { id: { in: minted } } });
    check('teardown removed only the links this run minted', del.count === minted.length, `${del.count} of ${minted.length}`);
  }
  console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
  await prisma.$disconnect();
  process.exit(out.includes('F') ? 1 : 0);
}
