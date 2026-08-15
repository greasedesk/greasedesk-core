/**
 * File: scripts/sms-sends-gate.mjs
 * Gate for the templated SMS sends and the top-up purchase.
 *
 * ── NOTHING IS ACTUALLY TEXTED ──────────────────────────────────────────────────────────────────
 * The SMS provider is unconfigured in this environment, so sendNotification records `skipped` with
 * `not_configured` and no message leaves. That is the right shape for a gate over a path that costs
 * money per call: everything up to the provider is exercised, the provider is not. The one thing it
 * cannot prove is Twilio accepting the body — which the segment budget already covers separately.
 *
 * ── THE FIXTURES ARE THE GATE TENANT'S OWN ──────────────────────────────────────────────────────
 * ZZ, and every row this run writes is removed. It refuses to start if a previous run left anything.
 */
import { prisma } from '../lib/db.ts';
import { NOTIFICATION_TEMPLATES } from '../lib/notification-templates.ts';
import { smsAllowance, SMS_TOPUP_PACK } from '../lib/sms-allowance.ts';
import { startTopUpCheckout, recordTopUpFromSession, MAX_PACKS_PER_PURCHASE, smsTopUpPriceId } from '../lib/sms-topup.ts';

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const made = [];

try {
  const stale = await prisma.smsTopUp.count();
  if (stale) throw new Error(`REFUSING: ${stale} top-up row(s) already present`);

  // ── 1. THE TEMPLATES CAN ACTUALLY BE SENT BY SMS ───────────────────────────────────────────
  console.log('\n— the templated sends —');
  for (const t of ['quote_ready', 'job_card_link', 'invoice_pay_link']) {
    check(`${t} has an sms renderer`, typeof NOTIFICATION_TEMPLATES[t]?.sms === 'function',
      'sendNotification records `no_renderer` and sends nothing without one');
  }
  check('invoice_pay_link is SMS-only', !NOTIFICATION_TEMPLATES.invoice_pay_link.email,
    'the email counterpart is invoice_document, which carries the PDF — two templates for one event would be two places to change one sentence');
  check('none of the customer templates is marked security', ['quote_ready', 'job_card_link', 'invoice_pay_link']
    .every((t) => !NOTIFICATION_TEMPLATES[t].security),
    'they must count against the allowance and be refusable by it');

  // ── 2. THE TOP-UP PURCHASE ─────────────────────────────────────────────────────────────────
  console.log('\n— buying a pack —');
  check('a pack is a hundred', SMS_TOPUP_PACK === 100);
  check('the price lives in Stripe, not in the code', smsTopUpPriceId() === null || /^price_/.test(smsTopUpPriceId()),
    smsTopUpPriceId() ? 'configured' : 'STRIPE_PRICE_SMS_TOPUP unset — refuses honestly');

  const bad = await startTopUpCheckout({ groupId: ZZ, packs: 0 });
  const many = await startTopUpCheckout({ groupId: ZZ, packs: MAX_PACKS_PER_PURCHASE + 1 });
  const frac = await startTopUpCheckout({ groupId: ZZ, packs: 1.5 });
  // THE REQUEST IS JUDGED BEFORE THE ENVIRONMENT. These all returned `not_configured` at first,
  // which made the check vacuous — it proved the missing key, not the quantity rule.
  check('zero, too many and fractional packs are refused ON THE QUANTITY',
    [bad, many, frac].every((r) => r.ok === false && r.refusal.code === 'bad_quantity'),
    `${bad.refusal?.code} / ${many.refusal?.code} / ${frac.refusal?.code}`);
  check('and the refusal names the range rather than blaming our deployment',
    /1 and \d+ packs/.test(bad.refusal?.message ?? ''), bad.refusal?.message);
  const okQty = await startTopUpCheckout({ groupId: ZZ, packs: 2 });
  check('a valid request stops at configuration, not at validation',
    okQty.ok === false && okQty.refusal.code === 'not_configured',
    'so the two refusals are distinguishable, which is the whole point of the ordering');

  // ── 3. THE WEBHOOK GRANTS, AND ONLY ONCE ───────────────────────────────────────────────────
  console.log('\n— what the webhook grants —');
  const sess = (o = {}) => ({
    id: `cs_gate_${Date.now()}`, mode: 'payment', payment_status: 'paid', amount_total: 1200,
    client_reference_id: ZZ, metadata: { group_id: ZZ, purpose: 'sms_topup', packs: '2' }, ...o,
  });

  const notATopUp = await recordTopUpFromSession(sess({ metadata: { group_id: ZZ } }));
  check('a session that is not a top-up grants nothing', notATopUp === null,
    'the subscription checkout reaches the same event and must not add messages');

  const unpaid = await recordTopUpFromSession(sess({ payment_status: 'unpaid' }));
  check('a completed but UNPAID session grants nothing', unpaid === null,
    'an async payment method can complete before the money arrives');

  const noPacks = await recordTopUpFromSession(sess({ metadata: { group_id: ZZ, purpose: 'sms_topup' } }));
  check('a session with no pack count grants nothing', noPacks === null, 'and says so in the log rather than guessing one');

  const before = await smsAllowance(prisma, ZZ);
  const s1 = sess();
  const granted = await recordTopUpFromSession(s1);
  const row = await prisma.smsTopUp.findFirst({ where: { source_ref: s1.id }, select: { id: true, quantity: true, amount_pennies: true } });
  if (row) made.push(row.id);
  check('a paid top-up grants packs × 100', granted?.granted === 200, `2 packs → ${granted?.granted}`);
  check('and records what was paid', row?.amount_pennies === 1200, `${row?.amount_pennies}p`);
  const after = await smsAllowance(prisma, ZZ);
  check('the allowance rises by exactly that', after.remaining - before.remaining === 200, `${before.remaining} → ${after.remaining}`);

  const again = await recordTopUpFromSession(s1);
  check('a redelivered webhook grants nothing', again === null, 'source_ref is unique — the same rule as Payment and CommissionEntry');
  check('and the allowance is unchanged', (await smsAllowance(prisma, ZZ)).remaining === after.remaining);
  check('the redelivery check is discriminating', granted?.granted === 200 && again === null,
    'the first granted, the second did not');

  // ── 4. THE PACK SIZE IS OURS, THE QUANTITY IS STRIPE'S ─────────────────────────────────────
  const s2 = sess({ id: `cs_gate_b_${Date.now()}`, metadata: { group_id: ZZ, purpose: 'sms_topup', packs: '1' } });
  const one = await recordTopUpFromSession(s2);
  const r2 = await prisma.smsTopUp.findFirst({ where: { source_ref: s2.id }, select: { id: true } });
  if (r2) made.push(r2.id);
  check('one pack is a hundred, not one', one?.granted === 100,
    'the line-item quantity counts PACKS; how many messages a pack holds is a product rule');
} catch (e) {
  check('run completed', false, String(e?.message ?? e).slice(0, 300));
} finally {
  if (made.length) {
    const d = await prisma.smsTopUp.deleteMany({ where: { id: { in: made } } });
    check('teardown removed the fixture top-ups', d.count === made.length, `${d.count} of ${made.length}`);
  }
  const left = await prisma.smsTopUp.count();
  check('no top-up row remains anywhere', left === 0, `${left}`);
  console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
  await prisma.$disconnect();
  process.exit(out.includes('F') ? 1 : 0);
}
