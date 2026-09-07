// @gate-timeout: 300
/**
 * File: scripts/rep-visit-gate.mjs
 * A VISIT IS EVIDENCE, AND THE MONTH IT PAYS FOR IS FROZEN WHEN IT HAPPENS.
 *
 * RepVisit exists to make CommissionRate.amount_unvisited_pennies reachable. That column has held
 * £12.50 against a £30.00 full rate since 2026-09-06 and NOTHING HAS EVER READ IT: linesForPayment
 * splits `rate.amount_pennies` unconditionally. This slice builds the record and the rule and
 * leaves that true — the dormancy section below is what keeps it true, deliberately, so the gate
 * goes red the day someone wires the money without saying so.
 *
 * ── WHY THE RULE IS TWO CLAUSES ────────────────────────────────────────────────────────────────
 * One visit per calendar month, and at least fourteen days since the last. Each covers what the
 * other misses, which is the whole reason neither is enough alone:
 *   · month alone   — the 31st and the 1st are two calendar months and two consecutive days
 *   · fourteen days alone — the 1st, the 15th and the 29th are three visits inside one month
 *
 * Fixtures on ZZ Gate Garage only. Never TMBS. The tenants this gate creates for the ledger section
 * are throwaway ones on synthetic country codes, removed on the way out.
 */
import './_gate-preflight.mjs';
const { gatePrisma, describeError } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { readFileSync } = await import('node:fs');
const { randomUUID } = await import('node:crypto');
const V = await import('../lib/rep-visit.ts');
const C = await import('../lib/commission.ts');
const prisma = await gatePrisma();

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const prose = (t) => t.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const D = (s) => new Date(s.length === 10 ? `${s}T00:00:00.000Z` : s);
const LDN = 'Europe/London';
const created = { groups: [], countries: new Set() };

try {
  // ── 1. THE CIVIL CALENDAR, NOT THE UTC ONE ───────────────────────────────────────────────────
  // Every clause below is expressed in the SITE's zone. The instants are pinned, so this section
  // answers the same on any day and on any machine.
  console.log('\n— which month a moment belongs to —');
  check('a mid-month instant is its own month', V.periodInZone(D('2026-03-14T12:00:00.000Z'), LDN) === '2026-03');
  // THE BOUNDARY THAT MOVES. 23:40 UTC on 31 March is 00:40 on 1 April in London (BST, +1). Read in
  // UTC this visit pays for March; read in the site's zone it pays for April. It is the same scan.
  check('an instant late on the last night reads in the SITE zone', V.periodInZone(D('2026-03-31T23:40:00.000Z'), LDN) === '2026-04',
    'London is +1 that night — in UTC this would have been March');
  check('  …and the same instant IS March in UTC', V.periodInZone(D('2026-03-31T23:40:00.000Z'), 'UTC') === '2026-03',
    'the discriminating half: the zone is doing the work, not the formatter');
  check('a winter instant does not shift', V.periodInZone(D('2026-01-31T23:40:00.000Z'), LDN) === '2026-01',
    'London is +0 in January, so nothing moves — the rule is the zone, not a constant offset');

  console.log('\n— whole days, in that same zone —');
  check('the 1st to the 15th is fourteen days', V.wholeDaysBetween(D('2026-06-01T09:00:00.000Z'), D('2026-06-15T08:00:00.000Z'), LDN) === 14,
    'CIVIL days, so an earlier hour on the later day does not make it thirteen');
  check('  …which an hours-based reading would have called thirteen',
    (D('2026-06-15T08:00:00.000Z') - D('2026-06-01T09:00:00.000Z')) / 86_400_000 < 14,
    'the discriminating half — 13.96 elapsed days, and the rule still says fourteen');
  // ACROSS A DST BOUNDARY. 29 March 2026 is a 23-hour day in London. Counting civil days is what
  // makes that invisible; counting 24-hour blocks would come up short by an hour once a year.
  check('a DST-shortened day still counts as one', V.wholeDaysBetween(D('2026-03-28T12:00:00.000Z'), D('2026-03-30T12:00:00.000Z'), LDN) === 2,
    '29 March is 23 hours long in London');
  check('the same day is zero days', V.wholeDaysBetween(D('2026-06-01T06:00:00.000Z'), D('2026-06-01T20:00:00.000Z'), LDN) === 0);
  // THE FIRST VERSION OF THIS CASE WAS WRONG, and the code caught it. 00:30 and 23:30 UTC on 1 June
  // are 01:30 on the 1st and 00:30 on the SECOND in London — one civil day apart, not zero. Kept as
  // a case rather than corrected away, because it is the whole rule in one line.
  check('  …and a UTC-same-day pair that crosses London midnight is ONE',
    V.wholeDaysBetween(D('2026-06-01T00:30:00.000Z'), D('2026-06-01T23:30:00.000Z'), LDN) === 1,
    'the same two instants are zero days apart in UTC');
  check('  …which they are not, in UTC', V.wholeDaysBetween(D('2026-06-01T00:30:00.000Z'), D('2026-06-01T23:30:00.000Z'), 'UTC') === 0);

  // ── 2. THE RULE ──────────────────────────────────────────────────────────────────────────────
  console.log('\n— one visit a month, fourteen days apart —');
  const sat = (day, period) => ({ scanned_at: D(day), satisfies_period: period });
  check('a first visit is accepted', V.refuseVisit({ now: D('2026-06-10T10:00:00.000Z'), timeZone: LDN, previous: [] }) === null);
  const twice = V.refuseVisit({ now: D('2026-06-20T10:00:00.000Z'), timeZone: LDN, previous: [sat('2026-06-01T10:00:00.000Z', '2026-06')] });
  check('a second visit in the same month is refused', twice?.code === 'already_satisfied', JSON.stringify(twice));
  check('  …and it names the month it is already paid for', twice?.period === '2026-06', JSON.stringify(twice));
  // THE 31st AND THE 1st — what the month clause alone cannot see.
  const straddle = V.refuseVisit({ now: D('2026-06-01T10:00:00.000Z'), timeZone: LDN, previous: [sat('2026-05-31T10:00:00.000Z', '2026-05')] });
  check('the 31st then the 1st is refused as TOO SOON', straddle?.code === 'too_soon', JSON.stringify(straddle));
  check('  …one day since, not fourteen', straddle?.daysSince === 1, JSON.stringify(straddle));
  // AND THE ANSWER IS A CIVIL DAY, NOT AN INSTANT. The rule counts days in a zone, so the earliest
  // acceptable answer is a DATE. Handing back a Date would invent a time nobody decided.
  check('  …and it says which DAY would be accepted', straddle?.earliestDay === '2026-06-14', JSON.stringify(straddle));
  check('the fourteenth day IS accepted', V.refuseVisit({ now: D('2026-07-15T09:00:00.000Z'), timeZone: LDN, previous: [sat('2026-07-01T10:00:00.000Z', '2026-07')] })?.code !== 'too_soon',
    'fourteen days means fourteen, not fifteen — it is refused for the MONTH, which is the other clause');
  const nextMonth = V.refuseVisit({ now: D('2026-07-01T09:00:00.000Z'), timeZone: LDN, previous: [sat('2026-06-01T10:00:00.000Z', '2026-06')] });
  check('a new month, thirty days later, is accepted', nextMonth === null, JSON.stringify(nextMonth));

  console.log('\n— when both clauses bite, ONE answer comes back —');
  const both = V.refuseVisit({ now: D('2026-06-05T10:00:00.000Z'), timeZone: LDN, previous: [sat('2026-06-01T10:00:00.000Z', '2026-06')] });
  check('the month is reported, not the interval', both?.code === 'already_satisfied',
    'pinned so the message cannot silently change: the month is the more useful thing to be told');

  console.log('\n— a visit that satisfied nothing is still a visit —');
  // The second visit in a month is RECORDED with satisfies_period NULL. It must not then act as the
  // anchor that blocks the next month, or a keen rep would lock themselves out by turning up twice.
  const afterUnsatisfying = V.refuseVisit({
    now: D('2026-07-02T10:00:00.000Z'), timeZone: LDN,
    previous: [sat('2026-06-01T10:00:00.000Z', '2026-06'), { scanned_at: D('2026-06-25T10:00:00.000Z'), satisfies_period: null }],
  });
  check('an unsatisfying visit does not anchor the interval', afterUnsatisfying === null,
    'seven days after the extra visit, thirty-one after the one that counted');

  // ── 3. THE FIRST PARTIAL MONTH ───────────────────────────────────────────────────────────────
  console.log('\n— a month you were barely in asks for nothing —');
  check('a whole month needs a visit', V.monthNeedsVisit(D('2026-01-01'), '2026-06', LDN) === true);
  // THE INCLUSIVE BOUNDARY, PINNED ON THE HARDEST MONTH. Activating on 15 February leaves the 15th
  // to the 28th — fourteen days counting the day you arrived.
  check('activating on 15 February needs a February visit', V.monthNeedsVisit(D('2026-02-15'), '2026-02', LDN) === true,
    '15th to 28th inclusive is fourteen days');
  check('  …and one day later does NOT', V.monthNeedsVisit(D('2026-02-16'), '2026-02', LDN) === false,
    'thirteen days — a visit was arithmetically impossible under the fourteen-day clause');
  check('a garage that arrived after the month ended needs nothing', V.monthNeedsVisit(D('2026-07-01'), '2026-06', LDN) === false);
  check('no activation at all needs nothing', V.monthNeedsVisit(null, '2026-06', LDN) === false,
    'nothing accrues before activation, so there is no month to gate');
  check('the count is days, and it says so', V.activeDaysInMonth(D('2026-02-16'), '2026-02', LDN) === 13,
    String(V.activeDaysInMonth(D('2026-02-16'), '2026-02', LDN)));

  // ── 4. THE RECORD ────────────────────────────────────────────────────────────────────────────
  console.log('\n— the shape of the evidence —');
  const schema = readFileSync('prisma/schema.prisma', 'utf8');
  const model = schema.split('model RepVisit {')[1]?.split('\n}')[0] ?? '';
  check('RepVisit exists', model.length > 0);
  check('  …and records the garage and the site', /group_id\s+String/.test(model) && /site_id\s+String/.test(model));
  check('  …the party, in the shape TenantAttribution already uses', /party_type\s+String/.test(model) && /party_id\s+String/.test(model),
    'a rep_id column would make a regional manager’s visit unrecordable, and that is a migration over evidence');
  check('  …the instant, and the month it FREEZES', /scanned_at\s+DateTime/.test(model) && /satisfies_period\s+String\?/.test(model));
  check('  …and how it was recorded', /source\s+String/.test(model));
  check('the consumed code step cannot be spent twice',
    /@@unique\(\[group_id, code_step\]\)/.test(model),
    'a screenshot forwarded inside the window is the attack; single-use is what closes it');
  check('CommissionEntry can freeze which rate branch it used', /visited\s+Boolean\?/.test(schema.split('model CommissionEntry {')[1]?.split('\n}')[0] ?? ''));

  // ── 5. THE CHECK CONSTRAINT, ASKED OF THE DATABASE ───────────────────────────────────────────
  // NOT asserted by reading the migration file. A CHECK has drifted from the code twice here
  // (MarketingContact_reason_check, then CostAllocation_one_owner_chk) and enum-drift-gate does not
  // cover them — it compares pg_enum, which is a different object. So: try the write, in a
  // transaction that always rolls back, and read the error code.
  console.log('\n— an operator visit without a reason is refused BY POSTGRES —');
  const zz = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
  const zzSiteRow = await prisma.site.findFirst({ where: { group_id: zz }, select: { id: true } });
  const tryInsert = async (row) => {
    try {
      await prisma.$transaction(async (tx) => {
        await tx.repVisit.create({ data: { group_id: zz, site_id: zzSiteRow.id, party_type: 'rep', party_id: randomUUID(),
          scanned_at: new Date(), satisfies_period: null, code_step: Math.floor(Math.random() * 1e9), ...row } });
        throw new Error('ROLLBACK');           // the row is never kept, whatever the outcome
      });
      return 'accepted';
    } catch (e) {
      if (/ROLLBACK/.test(String(e?.message))) return 'accepted';
      // A CHECK violation arrives as PrismaClientUnknownRequestError with the SQLSTATE in the
      // message, not on e.code — which is P2002-shaped and reserved for the constraints Prisma
      // models. The state is what identifies it, so that is what is matched.
      return `${e?.meta?.code ?? e?.code ?? ''} ${describeError(e)}`;
    }
  };
  const refused = (r) => /23514/.test(r);
  const noReason = await tryInsert({ source: 'operator', reason: null });
  check('an operator visit with no reason is refused', refused(noReason), noReason.slice(0, 90));
  const blank = await tryInsert({ source: 'operator', reason: '   ' });
  check('  …and a blank one too', refused(blank), 'whitespace is not a reason');
  check('  …while a real one is accepted', (await tryInsert({ source: 'operator', reason: 'Tablet flat; visit confirmed by phone' })) === 'accepted');
  check('a scanned visit needs no reason', (await tryInsert({ source: 'scan', reason: null })) === 'accepted',
    'the scan IS the evidence — demanding prose as well would be theatre');
  const scanNoStep = await tryInsert({ source: 'scan', reason: null, code_step: null });
  check('  …but it DOES need the step it consumed', refused(scanNoStep),
    'a scan with no code proved nothing, and the unique index has nothing to protect');
  const bogus = await tryInsert({ source: 'invented', reason: null });
  check('  …and an unknown source is refused', refused(bogus), bogus.slice(0, 90));
  check('nothing was kept', (await prisma.repVisit.count({ where: { group_id: zz } })) === 0, 'every probe ran inside a rolled-back transaction');

  // ── 6. THE CLAWBACK READS THE ENTRY ──────────────────────────────────────────────────────────
  // It used to recompute from linesForPayment, which asks TODAY's rate and TODAY's attribution. A
  // rate amendment or a territory hand-over between an accrual and its refund therefore reversed a
  // figure that was never booked. The ledger freezes; only the forecast computes.
  console.log('\n— a refund reverses what was BOOKED, not what would be booked now —');
  const cc = `Z${Math.floor(Math.random() * 9)}`;
  created.countries.add(cc);
  const g = await prisma.group.create({ data: { group_name: `RV ${cc}`, billing_email: `rv-${randomUUID()}@gd.invalid`,
    tax_country_code: cc, trial_ends_at: D('2026-01-01') }, select: { id: true } });
  created.groups.push(g.id);
  const repA = randomUUID(), repB = randomUUID();
  await prisma.commissionRate.create({ data: { country_code: cc, currency: 'GBP', tier: C.ONGOING_TIER, effective_from: D('2026-01-01'), amount_pennies: 3000, amount_unvisited_pennies: 1250 } });
  await prisma.tenantAttribution.create({ data: { group_id: g.id, party_type: 'rep', party_id: repA, role: 'referrer', share_bp: 10000, effective_from: D('2026-01-01'), source: 'manual' } });
  const pay = { ref: `pi_${randomUUID()}`, collected_at: D('2026-03-05'), amount_pennies: 7500, currency: 'GBP' };
  await C.accruePayment(prisma, g.id, pay);
  const accrual = await prisma.commissionEntry.findFirst({ where: { group_id: g.id, kind: 'accrual' }, select: { party_id: true, amount_pennies: true, visited: true, rate_id: true } });
  check('the accrual booked the full rate to the rep who signed them', accrual?.amount_pennies === 3000 && accrual?.party_id === repA, JSON.stringify(accrual));
  check('  …and recorded that NO visit decision was applied', accrual?.visited === null,
    'the gate is dormant — null is the truthful answer, and a default of false would be a decision nobody made');

  // THE WORLD MOVES: the territory hands over, and the rate is amended upward.
  await prisma.tenantAttribution.updateMany({ where: { group_id: g.id, party_id: repA }, data: { ended_at: D('2026-04-01') } });
  await prisma.tenantAttribution.create({ data: { group_id: g.id, party_type: 'rep', party_id: repB, role: 'referrer', share_bp: 10000, effective_from: D('2026-04-01'), source: 'manual' } });
  await prisma.commissionRate.create({ data: { country_code: cc, currency: 'GBP', tier: C.ONGOING_TIER, effective_from: D('2026-04-01'), amount_pennies: 5000, amount_unvisited_pennies: 2000 } });

  await C.clawbackRefund(prisma, g.id, { ref: `re_${randomUUID()}`, refunded_at: D('2026-05-10'), amount_pennies: 7500 }, pay);
  const claw = await prisma.commissionEntry.findFirst({ where: { group_id: g.id, kind: 'clawback' }, select: { party_id: true, amount_pennies: true, rate_id: true, visited: true } });
  check('the clawback reverses the ACCRUAL', claw?.amount_pennies === -3000, JSON.stringify(claw));
  check('  …to the rep who was actually paid', claw?.party_id === repA, 'a hand-over must not move an old month’s debt onto the new rep');
  check('  …carrying the same frozen rate', claw?.rate_id === accrual?.rate_id);
  check('  …and the same visit decision', claw?.visited === accrual?.visited);
  // THE DISCRIMINATING HALF: the world today says £50.00 and repB, so the two answers do not merely
  // happen to agree — the freeze is what produced −£30.00 against repA.
  const rateNow = await prisma.commissionRate.findFirst({ where: { country_code: cc, currency: 'GBP', effective_from: { lte: D('2026-05-10') } }, orderBy: { effective_from: 'desc' }, select: { amount_pennies: true } });
  const attrNow = await prisma.tenantAttribution.findFirst({ where: { group_id: g.id, effective_from: { lte: D('2026-05-10') }, OR: [{ ended_at: null }, { ended_at: { gt: D('2026-05-10') } }] }, select: { party_id: true } });
  check('  …where today’s world would have said something else entirely',
    rateNow?.amount_pennies === 5000 && attrNow?.party_id === repB,
    `${rateNow?.amount_pennies} to ${attrNow?.party_id === repB ? 'repB' : attrNow?.party_id}`);

  // AND A REFUND WITH NO ACCRUAL WRITES NOTHING. Recomputing could invent a negative where no
  // positive was ever booked — a payment refused at accrual time, then a rate added, then a refund.
  const orphan = { ref: `pi_${randomUUID()}`, collected_at: D('2026-03-06'), amount_pennies: 7500, currency: 'GBP' };
  const res = await C.clawbackRefund(prisma, g.id, { ref: `re_${randomUUID()}`, refunded_at: D('2026-05-11'), amount_pennies: 7500 }, orphan);
  check('a refund of a payment that never accrued writes nothing', res.written === 0, JSON.stringify(res));

  // ── 7. STILL DORMANT ─────────────────────────────────────────────────────────────────────────
  console.log('\n— and none of it touches the money yet —');
  const comm = prose(readFileSync('lib/commission.ts', 'utf8'));
  check('lib/commission does not read amount_unvisited_pennies', !/amount_unvisited_pennies/.test(comm),
    'the reduced rate stays unreachable until a slice says otherwise, and this check is how that stays true');
  check('  …and nothing else at runtime does either',
    !/amount_unvisited_pennies/.test(prose(readFileSync('lib/rep-visit.ts', 'utf8'))));
  check('linesForPayment still splits the FULL rate', /splitAmount\(rate\.amount_pennies,/.test(comm),
    'the shape that has to change when the gate is wired — pinned so the change is deliberate');
  check('nothing writes a RepVisit yet', (await prisma.repVisit.count()) === 0,
    'the model and the rule land before any surface — dormant means no rows');
} catch (e) {
  check('gate run completed', false, describeError(e).slice(0, 400));
} finally {
  for (const id of created.groups) {
    try { await prisma.commissionEntry.deleteMany({ where: { group_id: id } }); } catch {}
    try { await prisma.tenantAttribution.deleteMany({ where: { group_id: id } }); } catch {}
    try { await prisma.group.delete({ where: { id } }); } catch (e) { console.log(`  teardown group: ${describeError(e).slice(0, 90)}`); }
  }
  for (const c of created.countries) {
    try { await prisma.commissionRate.deleteMany({ where: { country_code: c } }); } catch {}
  }
  try {
    check('teardown removed every throwaway tenant',
      created.groups.length === 0 || (await prisma.group.count({ where: { id: { in: created.groups } } })) === 0);
  } catch (e) { check('teardown removed every throwaway tenant', false, describeError(e).slice(0, 70)); }
  const f = out.filter((x) => x === 'F').length;
  console.log(`\n${f} failures of ${out.length}`);
  await prisma.$disconnect();
  process.exit(f ? 1 : 0);
}
