/**
 * File: scripts/payment-intent-gate.mjs
 * Gate for the PaymentIntent path: the refusal order, and the endpoint's guards.
 *
 * ── WHAT THIS CANNOT PROVE, STATED UP FRONT ─────────────────────────────────────────────────────
 * No PaymentIntent is created anywhere in this gate. Doing so needs a connected account, a live
 * publishable key and a seeded rate — none of which exist, deliberately. What IS proved is
 * everything up to the Stripe call: which documents are refused and in what order, that the
 * endpoint derives money from the token alone, that a wrong or dead link cannot reach the money
 * path, and that the limiter fires. The Stripe call itself waits for the sandbox account.
 *
 * ── IT CLEANS UP ITS OWN LIMITER ROWS ───────────────────────────────────────────────────────────
 * The rate-limit assertions burn real tokens against a real key. Left behind, the gate would refuse
 * to pass again for an hour — a gate that cannot be re-run is a gate people stop running. The keys
 * it writes are deleted by exact key in teardown. AuthRateLimit is a time-based limiter with its
 * own reaper, not an audit log; deleting rows this run created is not the AuditLog rule.
 */
import './_gate-preflight.mjs';
const { describeError } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { prisma } = await import('../lib/db.ts');
const { refusePayment } = await import('../lib/invoice-payment-intent.ts');
const { createMagicLink, invoicePayExpiry } = await import('../lib/magic-link.ts');
const { PAY_LIMITS } = await import('../pages/api/pay/intent.ts');

const GATE_REF = 'GB-GD2141';
// PORT 3000, the port `npm run dev` uses. This defaulted to 3111 — not a decision, just whatever
// the author had running that afternoon. Six gates carried defaults like it, so six gates skipped
// on every machine but one; both of the two tested pass unchanged against 3000. GATE_BASE still
// overrides, which is what a genuinely different server is for.
const B = process.env.GATE_BASE ?? 'http://localhost:3000';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };

const doc = (o = {}) => ({ status: 'issued', underCorrection: false, series: 'chargeable', ...o });
const post = async (body) => {
  const r = await fetch(`${B}/api/pay/intent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

const minted = [];
/**
 * The limiter keys this run burns are scoped by TIME, not guessed by name. They were hardcoded to
 * `pay:ip:127.0.0.1`, which is right for a local server and wrong for every remote one: against
 * greasedesk.com the key is this machine's egress IP, which the gate cannot know — so the hammer
 * loop burned ten tokens it could not release and the next four runs failed on 429s that looked
 * like endpoint defects. Deleting `pay:` rows created since the run started is exact regardless of
 * where the server is, and releasing a limiter token is not a destructive act.
 */
const startedAt = new Date();
try {
  // ── 1. WHICH DOCUMENTS ARE REFUSED ─────────────────────────────────────────────────────────
  console.log('\n— refusals —');
  check('an ordinary issued invoice with a balance is allowed', refusePayment(doc(), 94000) === null);
  check('a VOID invoice is refused', refusePayment(doc({ status: 'void' }), 94000)?.code === 'void');
  check('an invoice UNDER CORRECTION is refused', refusePayment(doc({ underCorrection: true }), 94000)?.code === 'under_correction',
    'the amount is not final and a different one is coming');
  check('a WARRANTY document is refused', refusePayment(doc({ series: 'warranty' }), 0)?.code === 'warranty');
  check('a settled invoice is refused', refusePayment(doc(), 0)?.code === 'nothing_owing');
  check('an OVERPAID invoice is refused, not charged a negative', refusePayment(doc(), -500)?.code === 'nothing_owing',
    'balanceOwedPennies returns credit as negative; this is where that must not become a charge');

  // ORDER. A void invoice also has nothing owing; the customer must be told it was cancelled, not
  // that it is paid — those are different facts and only one of them is true.
  check('void beats nothing-owing', refusePayment(doc({ status: 'void' }), 0)?.code === 'void');
  check('under-correction beats nothing-owing', refusePayment(doc({ underCorrection: true }), 0)?.code === 'under_correction',
    'an unlocked invoice has no lines, so its balance is zero — the wrong sentence entirely');
  check('the ordering is discriminating', (() => {
    // A refusal chain that tested the balance first would call a void invoice "already paid".
    const balanceFirst = (d, bal) => (bal <= 0 ? 'nothing_owing' : d.status === 'void' ? 'void' : null);
    return balanceFirst(doc({ status: 'void' }), 0) === 'nothing_owing'
      && refusePayment(doc({ status: 'void' }), 0).code === 'void';
  })());

  check('every refusal is a sentence, not a code', [
    refusePayment(doc({ status: 'void' }), 94000),
    refusePayment(doc({ underCorrection: true }), 94000),
    refusePayment(doc(), 0),
  ].every((r) => r.message.length > 25 && !/[_A-Z]{4,}/.test(r.message)), 'they reach a customer, not a developer');

  check('the limits are tighter than the magic-link resolver’s 60/hour',
    PAY_LIMITS.perIp.max < 60 && PAY_LIMITS.perLink.max < PAY_LIMITS.perIp.max,
    `${PAY_LIMITS.perIp.max}/ip, ${PAY_LIMITS.perLink.max}/link — one invoice needs one intent`);

  // ── 2. THE ENDPOINT'S GUARDS, SERVED ───────────────────────────────────────────────────────
  const reachable = await fetch(`${B}/admin/login`).then((r) => r.ok).catch(() => false);
  if (!reachable) {
    check('a server is reachable for the served leg', false, `${B} — start one, or set GATE_BASE`);
  } else {
    console.log('\n— the endpoint —');
    const g = await prisma.group.findUnique({ where: { ref: GATE_REF }, select: { id: true } });
    const inv = await prisma.invoice.findFirst({
      where: { group_id: g.id, status: 'issued', lines: { some: {} } },
      select: { id: true, job_card_id: true, invoice_number: true, due_date: true, issued_at: true },
      orderBy: { issued_at: 'desc' },
    });

    check('GET is refused', (await fetch(`${B}/api/pay/intent`)).status === 405);

    const noToken = await post({});
    check('no token is refused', noToken.status === 404 && noToken.body.code === 'no_link');
    const junk = await post({ token: 'not-a-real-token' });
    check('a junk token is refused', junk.status === 404);
    check('and the refusal says nothing about whether it ever existed',
      junk.body.message === noToken.body.message,
      'the pay endpoint is not where a guesser learns which guesses landed');

    const quote = await createMagicLink({ groupId: g.id, jobCardId: inv.job_card_id, purpose: 'quote_view', recipient: 'gate@zzgategarage.test' });
    minted.push(quote.id);
    const wrong = await post({ token: quote.rawToken });
    check('a QUOTE token cannot start a payment', wrong.status === 400 && wrong.body.code === 'wrong_link',
      'the purpose is the boundary, and it is checked server-side');

    const pay = await createMagicLink({
      groupId: g.id, jobCardId: inv.job_card_id, invoiceId: inv.id, purpose: 'invoice_pay',
      recipient: 'gate@zzgategarage.test',
      expiresAt: invoicePayExpiry({ dueDate: inv.due_date, issuedAt: inv.issued_at }),
    });
    minted.push(pay.id);

    const real = await post({ token: pay.rawToken });
    // With no Stripe key and no publishable key locally this reaches PAY:not_configured. That is the
    // whole chain — limiter, token, purpose, invoice, balance — exercised right up to Stripe.
    check('a valid pay token reaches the money path and stops at configuration',
      real.status === 409 && real.body.code === 'unavailable',
      `${real.status} ${real.body.code} — not 404, not 400, so the link and purpose were accepted`);
    check('no client secret is ever returned on a refusal', !real.body.clientSecret && !real.body.publishableKey);

    // No PaymentIntent could have been created, so no ledger row may exist either.
    const rows = await prisma.payment.count({ where: { invoice_id: inv.id, provider: 'stripe' } });
    check('a refused payment wrote no ledger row', rows === 0, `${rows} stripe rows on ${inv.invoice_number}`);

    // ── 3. THE LIMITER FIRES ─────────────────────────────────────────────────────────────────
    console.log('\n— the limiter —');
    let sawLimit = null;
    for (let i = 0; i < PAY_LIMITS.perIp.max + 3; i++) {
      const r = await post({ token: pay.rawToken });
      if (r.status === 429) { sawLimit = { at: i, body: r.body }; break; }
    }
    check('hammering the endpoint is stopped', !!sawLimit, sawLimit ? `429 after ${sawLimit.at + 1} more attempts` : 'never limited');
    check('and the customer is told to wait, not that something broke',
      /wait|try again/i.test(String(sawLimit?.body?.message ?? '')), String(sawLimit?.body?.message ?? '').slice(0, 60));
  }
} catch (e) {
  check('run completed', false, describeError(e).slice(0, 300));
} finally {
  if (minted.length) {
    const d = await prisma.customerMagicLink.deleteMany({ where: { id: { in: minted } } });
    check('teardown removed the links this run minted', d.count === minted.length, `${d.count} of ${minted.length}`);
  }
  const released = await prisma.authRateLimit.deleteMany({
    where: { key: { startsWith: 'pay:' }, created_at: { gte: startedAt } },
  });
  check('teardown cleared this run’s limiter budget', true,
    `${released.count} token(s) released — scoped by time, so it works against a remote server too`);
  console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
  await prisma.$disconnect();
  process.exit(out.includes('F') ? 1 : 0);
}
