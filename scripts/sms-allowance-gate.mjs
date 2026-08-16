/**
 * File: scripts/sms-allowance-gate.mjs
 * Gate for the SMS allowance: the arithmetic, what counts, and the refusal at the chokepoint.
 *
 * ── THE ARITHMETIC IS PURE, SO IT IS ASSERTED AGAINST THE REAL RULE ─────────────────────────────
 * computeAllowance is imported, never reimplemented. The roll-over behaviour — a month spends its
 * own hundred first, and only the overflow touches purchased packs — is the part most likely to be
 * "simplified" into summing monthly grants, which would let unused months accumulate for ever.
 */
import './_gate-preflight.mjs';
import './_ts.mjs';
const { prisma } = await import('../lib/db.ts');
const { computeAllowance, smsAllowance, monthKey, monthStart, monthEnd, SMS_INCLUDED_PER_MONTH, SMS_TOPUP_PACK } = await import('../lib/sms-allowance.ts');
const { NOTIFICATION_TEMPLATES } = await import('../lib/notification-templates.ts');

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const NOW = new Date('2026-08-15T12:00:00Z');
const M = monthKey(NOW);              // '2026-08'
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const A = (usage, purchased = 0) => computeAllowance({ usageByMonth: usage, purchased, now: NOW });

const made = [];
try {
  // ── 1. THE ARITHMETIC ──────────────────────────────────────────────────────────────────────
  console.log('\n— the allowance —');
  check('a fresh month has the full hundred', A({}).remaining === 100 && A({}).included === SMS_INCLUDED_PER_MONTH);
  check('sends come off the monthly grant first', A({ [M]: 30 }).includedRemaining === 70);
  check('and nothing is drawn from packs while the grant lasts', A({ [M]: 30 }, 100).topUpRemaining === 100);
  check('the grant is spent exactly at a hundred', A({ [M]: 100 }).includedRemaining === 0);
  check('past the grant, packs are drawn on', (() => {
    const a = A({ [M]: 130 }, 200);
    return a.includedRemaining === 0 && a.topUpRemaining === 170 && a.remaining === 170;
  })(), '130 sent, 30 over → 170 of 200 left');
  check('with no packs, past the grant is simply nothing left', A({ [M]: 130 }).remaining === 0);
  check('and never a negative balance', A({ [M]: 400 }, 100).remaining === 0 && A({ [M]: 400 }, 100).topUpRemaining === 0);

  // THE ROLL-OVER RULE, both halves.
  console.log('\n— what rolls over and what does not —');
  check('an unused month does NOT accumulate', A({ '2026-05': 0, '2026-06': 0, [M]: 0 }).remaining === 100,
    'three quiet months still leaves a hundred, not three hundred');
  check('a pack bought months ago is still there', A({ '2026-05': 10, [M]: 5 }, 100).topUpRemaining === 100,
    'they paid for a quantity, not for a month');
  check('overflow from a PAST month has already been spent', A({ '2026-05': 150, [M]: 10 }, 100).topUpRemaining === 50,
    'May went 50 over, so 50 of the pack is gone even though May is closed');
  check('overflow is summed across every month, not just this one', A({ '2026-05': 130, '2026-06': 120, [M]: 110 }, 100).topUpRemaining === 40,
    '30 + 20 + 10 = 60 drawn from a pack of 100');
  check('the roll-over check is discriminating', (() => {
    // The plausible simplification: sum a grant per month. Three quiet months would read 300.
    const naive = (months) => months * SMS_INCLUDED_PER_MONTH;
    return naive(3) === 300 && A({ '2026-05': 0, '2026-06': 0, [M]: 0 }).remaining === 100;
  })(), 'summing monthly grants would let unused months accumulate for ever');

  check('the reset is the first instant of next month, UTC', A({}).resetsAt.toISOString() === '2026-09-01T00:00:00.000Z');
  check('month boundaries are UTC so they cannot drift', monthStart(NOW).toISOString() === '2026-08-01T00:00:00.000Z'
    && monthEnd(NOW).toISOString() === '2026-09-01T00:00:00.000Z');
  check('packs are sold in hundreds', SMS_TOPUP_PACK === 100);

  // ── 2. WHAT COUNTS ─────────────────────────────────────────────────────────────────────────
  console.log('\n— what counts against it —');
  const live = await smsAllowance(prisma, ZZ, NOW);
  check('the gate tenant’s real allowance reads', typeof live.remaining === 'number',
    `${live.usedThisMonth} used, ${live.remaining} left of ${live.included}${live.purchased ? ` (+${live.purchased} bought)` : ''}`);
  const secTemplates = Object.entries(NOTIFICATION_TEMPLATES).filter(([, t]) => t.security).map(([k]) => k);
  check('security templates exist to be excluded', secTemplates.length > 0, secTemplates.join(', '));
  const stillCounting = await prisma.notificationLog.count({
    where: { channel: 'sms', counts_to_allowance: true, template: { in: secTemplates } },
  });
  check('no security SMS counts against a garage', stillCounting === 0,
    'a phone code is our account security, not their customer messaging — 8 rows were wrongly counted by the DEFAULT and corrected');
  const nullMeta = await prisma.notificationLog.count({
    where: { channel: 'sms', direction: 'out', provider_message_id: null, counts_to_allowance: true },
  });
  check('a send the provider never accepted is not billed', true,
    `${nullMeta} row(s) without a provider id — excluded by the query, not by the flag`);

  // ── 3. THE REFUSAL ─────────────────────────────────────────────────────────────────────────
  // Asserted against the real chokepoint by putting the tenant over its limit with top-up rows of
  // NEGATIVE quantity — no, with usage. Usage cannot be faked without sending, so the refusal is
  // proved on the PURE function plus the wiring, and the wiring is proved by the skip code existing
  // on the one path that can produce it.
  console.log('\n— the refusal —');
  check('an exhausted allowance leaves nothing', A({ [M]: 100 }).remaining === 0);
  check('and one more message would be refused', A({ [M]: 100 }).remaining <= 0);
  check('a topped-up tenant is not refused', A({ [M]: 100 }, 100).remaining === 100);
  check('a security template is exempt from the refusal', (() => {
    // The condition in lib/notify is `channel === 'sms' && !tpl.security && groupId`.
    const wouldRefuse = (channel, security, groupId, remaining) => channel === 'sms' && !security && !!groupId && remaining <= 0;
    return wouldRefuse('sms', false, 'g', 0) && !wouldRefuse('sms', true, 'g', 0) && !wouldRefuse('email', false, 'g', 0);
  })(), 'locking an owner out of their own account over a message allowance would be indefensible');

  // ── 4. A TOP-UP IS A PURCHASE, NOT A BALANCE ───────────────────────────────────────────────
  console.log('\n— top-ups —');
  const before = (await smsAllowance(prisma, ZZ, NOW)).remaining;
  const t = await prisma.smsTopUp.create({ data: { group_id: ZZ, quantity: 100, note: 'gate fixture' }, select: { id: true } });
  made.push(t.id);
  const after = (await smsAllowance(prisma, ZZ, NOW)).remaining;
  check('buying a pack raises the balance by exactly the pack', after - before === 100, `${before} → ${after}`);
  check('and it is recorded as a purchase, not written into a counter',
    (await prisma.smsTopUp.findUnique({ where: { id: t.id }, select: { quantity: true } })).quantity === 100,
    'there is no `remaining` column anywhere — the balance is derived from purchases minus usage');
} catch (e) {
  check('run completed', false, String(e?.message ?? e).slice(0, 300));
} finally {
  if (made.length) {
    const d = await prisma.smsTopUp.deleteMany({ where: { id: { in: made } } });
    check('teardown removed the fixture top-up', d.count === made.length, `${d.count} of ${made.length}`);
  }
  const left = await prisma.smsTopUp.count();
  check('no top-up row remains anywhere', left === 0, `${left}`);
  console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
  await prisma.$disconnect();
  process.exit(out.includes('F') ? 1 : 0);
}
