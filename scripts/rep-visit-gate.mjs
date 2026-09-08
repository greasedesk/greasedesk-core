// @gate-timeout: 300
/**
 * File: scripts/rep-visit-gate.mjs
 * A VISIT IS EVIDENCE, AND THE MONTH IT PAYS FOR IS FROZEN WHEN IT HAPPENS.
 *
 * RepVisit was built to make a REDUCED RATE reachable — £12.50 for a garage-month whose visit did
 * not happen. That rate is gone (2026-09-08): a garage-month is paid at £30 or it is HELD, and a
 * held month is a decision an area manager makes rather than a smaller number somebody is paid
 * without being asked. So the visit prices nothing. It is evidence, shown to a person, and what
 * they decided is frozen on the entry. See docs/rep-system.md.
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
  // RENAMED 2026-09-08. `visited` described which of two amounts was used, and there is one amount.
  // The column survives because the new model has a question of the same shape: at release, what
  // picture was the manager shown? Re-deriving it later would show a different one, because an
  // operator-recorded visit can be added afterwards.
  const entryModel = schema.split('model CommissionEntry {')[1]?.split('\n}')[0] ?? '';
  check('CommissionEntry freezes the picture the manager was shown', /shown_as_visited\s+Boolean\?/.test(entryModel));
  check('  …and no longer claims to record a rate branch', !/\bvisited\s+Boolean/.test(entryModel),
    'a column that keeps its old name ends up meaning two things');

  // ── 4b. THE REASON IS A CODE, AND THE PROSE LEFT ─────────────────────────────────────────────
  // `reason` shipped as free prose on operator-recorded visits — and RepVisit SURVIVES a purge, so
  // "Dave's tablet was flat" was a name we kept after an erasure. It is now a value from a closed
  // set (lib/rep-visit UNSCANNED_REASONS), which is the audit answer to "why was this not
  // scanned?" and holds nothing about the garage's people. Anything a person wants to type moves
  // to RepVisitNote, which goes with the tenant exactly as the answers do.
  console.log('\n— why a visit was not scanned is a code, not a sentence —');
  check('the set is closed and small', V.UNSCANNED_REASONS.length >= 3 && V.UNSCANNED_REASONS.length <= 6,
    V.UNSCANNED_REASONS.join(', '));
  check('  …and carries no “other”', !V.UNSCANNED_REASONS.includes('other'),
    'the prose that would explain it is erased with the tenant, so `other` degrades to noise exactly when the audit needs it');
  check('  …and every value is a case where the rep WAS THERE',
    !V.UNSCANNED_REASONS.some((r) => /not_attend|absent|no_visit/.test(r)),
    'a visit nobody attended is not a visit with a reason — it is a month with no visit, and recording one would pay for a fiction');
  check('an operator visit needs a reason from the set', V.refuseUnscanned('operator', null)?.code === 'reason_required');
  check('  …and refuses one that is not in it', V.refuseUnscanned('operator', 'because')?.code === 'bad_reason');
  check('  …while a real code is accepted', V.refuseUnscanned('operator', V.UNSCANNED_REASONS[0]) === null);
  check('a scan carries no reason at all', V.refuseUnscanned('scan', null) === null);
  check('  …and is refused if it invents one', V.refuseUnscanned('scan', V.UNSCANNED_REASONS[0])?.code === 'bad_reason',
    'the scan IS the evidence; a reason beside it is a contradiction');
  const rvSchema = readFileSync('prisma/schema.prisma', 'utf8');
  const noteModel = rvSchema.split('model RepVisitNote {')[1]?.split('\n}')[0] ?? '';
  check('the prose has its own row', noteModel.length > 0 && /visit_id\s+String\s+@unique/.test(noteModel));
  check('  …which the purge sweeps with the tenant', /repVisitNote\.deleteMany\(/.test(readFileSync('lib/tenant-purge.ts', 'utf8')),
    'free text about a garage must not outlive the garage');
  check('  …while the visit and its CODE do not', /RepVisit STAYS, on the same two-part test/.test(readFileSync('lib/tenant-purge.ts', 'utf8')));

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
  // THE SENTENCE THAT USED TO BE ACCEPTED. This check read "…while a real one is accepted" and
  // passed a prose reason; it failed the moment RepVisit_reason_chk landed, which is the constraint
  // doing its job. Kept as the case rather than deleted — a sentence being refused IS the change.
  const sentence = await tryInsert({ source: 'operator', reason: 'Tablet flat; visit confirmed by phone' });
  check('  …and a SENTENCE is refused, where it used to be accepted', refused(sentence),
    'the prose moved to RepVisitNote, which leaves with the tenant');
  check('  …while a code from the set is accepted',
    (await tryInsert({ source: 'operator', reason: V.UNSCANNED_REASONS[0] })) === 'accepted');
  check('a scanned visit needs no reason', (await tryInsert({ source: 'scan', reason: null })) === 'accepted',
    'the scan IS the evidence — demanding a reason as well would be theatre');
  check('  …and is refused if it carries one', refused(await tryInsert({ source: 'scan', reason: V.UNSCANNED_REASONS[0] })),
    'a reason beside a scan is a contradiction, not extra detail — the pairing now bites both ways');
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
  await prisma.commissionRate.create({ data: { country_code: cc, currency: 'GBP', tier: C.ONGOING_TIER, effective_from: D('2026-01-01'), amount_pennies: 3000 } });
  await prisma.tenantAttribution.create({ data: { group_id: g.id, party_type: 'rep', party_id: repA, role: 'referrer', share_bp: 10000, effective_from: D('2026-01-01'), source: 'manual' } });
  const pay = { ref: `pi_${randomUUID()}`, collected_at: D('2026-03-05'), amount_pennies: 7500, currency: 'GBP' };
  await C.accruePayment(prisma, g.id, pay);
  const accrual = await prisma.commissionEntry.findFirst({ where: { group_id: g.id, kind: 'accrual' }, select: { party_id: true, amount_pennies: true, shown_as_visited: true, rate_id: true } });
  check('the accrual booked the full rate to the rep who signed them', accrual?.amount_pennies === 3000 && accrual?.party_id === repA, JSON.stringify(accrual));
  check('  …and recorded that it has NOT been released', accrual?.shown_as_visited === null,
    'the release is not built, so null is the truthful answer — false would be the decision "released without a visit", which nobody has made');

  // THE WORLD MOVES: the territory hands over, and the rate is amended upward.
  await prisma.tenantAttribution.updateMany({ where: { group_id: g.id, party_id: repA }, data: { ended_at: D('2026-04-01') } });
  await prisma.tenantAttribution.create({ data: { group_id: g.id, party_type: 'rep', party_id: repB, role: 'referrer', share_bp: 10000, effective_from: D('2026-04-01'), source: 'manual' } });
  await prisma.commissionRate.create({ data: { country_code: cc, currency: 'GBP', tier: C.ONGOING_TIER, effective_from: D('2026-04-01'), amount_pennies: 5000 } });

  await C.clawbackRefund(prisma, g.id, { ref: `re_${randomUUID()}`, refunded_at: D('2026-05-10'), amount_pennies: 7500 }, pay);
  const claw = await prisma.commissionEntry.findFirst({ where: { group_id: g.id, kind: 'clawback' }, select: { party_id: true, amount_pennies: true, rate_id: true, shown_as_visited: true } });
  check('the clawback reverses the ACCRUAL', claw?.amount_pennies === -3000, JSON.stringify(claw));
  check('  …to the rep who was actually paid', claw?.party_id === repA, 'a hand-over must not move an old month’s debt onto the new rep');
  check('  …carrying the same frozen rate', claw?.rate_id === accrual?.rate_id);
  check('  …and the same release picture', claw?.shown_as_visited === accrual?.shown_as_visited,
    'a clawback reverses what was booked, including what the manager was looking at when they released it');
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
  // THE REDUCED RATE IS GONE, not merely unread. It was £12.50 for a month whose visit did not
  // happen; there is now one amount and a held month is a person's decision. So this is no longer
  // a dormancy ratchet waiting to be released — it is permanent, and says so.
  check('nothing anywhere reads a reduced rate', !/amount_unvisited_pennies/.test(comm)
    && !/amount_unvisited_pennies/.test(prose(readFileSync('lib/rep-visit.ts', 'utf8'))),
    'one amount: £30 or held');
  check('linesForPayment splits the one rate', /splitAmount\(rate\.amount_pennies,/.test(comm),
    'no branch to choose, so nothing here has to change again');

  // ── THE THIRD STATE ──────────────────────────────────────────────────────────────────────────
  // monthNeedsVisit was a PRICING rule: it stopped the reduced rate being charged for a month in
  // which a visit was arithmetically impossible. With one amount it prices nothing, and it becomes
  // the predicate that gives the area manager's list its third state. A garage that joined on the
  // 28th showing as "no visit" beside nineteen real misses is twenty conversations where there
  // should be nineteen.
  console.log('\n— visited, not visited, and not expected —');
  const feb = (d) => ({ activation: D(`2026-02-${d}`), period: '2026-02' });
  const st = (args) => V.visitState({ ...args, timeZone: LDN });
  check('a satisfied month is VISITED', st({ ...feb('01'), satisfied: true }) === 'visited');
  check('an unsatisfied month somebody was here for is NOT VISITED', st({ ...feb('01'), satisfied: false }) === 'not_visited');
  check('a month they were barely in is NOT EXPECTED', st({ ...feb('16'), satisfied: false }) === 'not_expected',
    'thirteen days — the fourteen-day clause made a visit impossible, and that is not a missed visit');
  check('  …and the boundary is the same one monthNeedsVisit uses', st({ ...feb('15'), satisfied: false }) === 'not_visited',
    '15th to 28th inclusive is fourteen days, so a visit WAS expected');
  check('a month they were barely in but DID visit is still VISITED', st({ ...feb('16'), satisfied: true }) === 'visited',
    'evidence beats expectation — they turned up, and the list must not hide it');
  check('no activation at all is NOT EXPECTED', st({ activation: null, period: '2026-02', satisfied: false }) === 'not_expected',
    'nothing accrues before activation, so there is no month to have missed');
  check('the three states are a closed set', Array.isArray(V.VISIT_STATES) && V.VISIT_STATES.length === 3
    && ['visited', 'not_visited', 'not_expected'].every((x) => V.VISIT_STATES.includes(x)),
    (V.VISIT_STATES ?? []).join(', '));
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
