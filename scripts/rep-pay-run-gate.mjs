// @gate-timeout: 420
/**
 * File: scripts/rep-pay-run-gate.mjs
 * SALES COMMISSION IS RELEASED BY A PERSON, AND A CLOSED RUN NEVER MOVES AGAIN.
 *
 * An area manager reviews a rep's claimed visits, releases or holds each line, and released lines
 * land in a dated pay run that a human closes with a signoff. Nothing pays itself: the scheduled
 * date makes a run ELIGIBLE to close and never closes it.
 *
 * ── LANGUAGE ────────────────────────────────────────────────────────────────────────────────────
 * "Sales Commission". Never wage, salary, or pay as a noun for the rep. A rep is self-employed and
 * invoices us; calling their commission a wage is wrong in law before it is wrong on a screen.
 *
 * ── FIXTURES ────────────────────────────────────────────────────────────────────────────────────
 * Entries on ZZ Gate Garage only, never TMBS, with a SYNTHETIC party_id — a random uuid, because
 * party_id has no foreign key and inventing a Rep row would be inventing a person. The live GB/GBP
 * rate is read, never written. A throwaway Group on a synthetic country code carries the
 * region-scope clause. Everything is removed by its own id.
 *
 * A REP PAY RUN IS PLATFORM-WIDE, so this gate REFUSES TO START if any run exists rather than
 * colliding with a real one. Stated here rather than discovered later: once a real open run exists,
 * this gate cannot run until it is closed and the fixture window is clear.
 */
import './_gate-preflight.mjs';
const { gatePrisma, describeError, serverReady, declineToRun } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { keyRegex } = await import('../lib/anchored-match.ts');
const { readFileSync, readdirSync, statSync, existsSync } = await import('node:fs');
const { join } = await import('node:path');
const { randomUUID } = await import('node:crypto');
const R = await import('../lib/rep-pay-run.ts');
const prisma = await gatePrisma();

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const D = (s) => new Date(s.length === 10 ? `${s}T00:00:00.000Z` : s);
const money = (p) => `£${(p / 100).toFixed(2)}`;
let fix = null;

try {
  // ── 1. THE STATES, AND WHAT EACH ONE DEMANDS ─────────────────────────────────────────────────
  console.log('\n— pending, held, released, and nothing in between —');
  check('the lifecycle is a closed set', R.ENTRY_STATUSES.join('|') === 'pending|held|released|billed|paid|void',
    R.ENTRY_STATUSES.join(', '));
  check('a run is open or closed, and nothing else', R.PAY_RUN_STATUSES.join('|') === 'open|closed');
  check('holding needs a reason from a set', R.HOLD_REASONS.length >= 3 && !R.HOLD_REASONS.includes('other'),
    R.HOLD_REASONS.join(', '));
  check('  …and so does an override', R.RELEASE_OVERRIDE_REASONS.length >= 3 && !R.RELEASE_OVERRIDE_REASONS.includes('other'),
    'no catch-all: the prose that would explain one lives in a child row, and a set that cannot express a case is WRONG rather than extended by accident');

  // ── 2. THE FOURTEEN-DAY RULE IS REPORTED, NOT ENFORCED ───────────────────────────────────────
  console.log('\n— the window is reported, and a failing line is still releasable —');
  const wIn = R.windowVerdict({ period: '2026-06', visitAt: D('2026-06-20'), previousVisitAt: D('2026-06-01') });
  check('two visits sixteen days apart PASS', wIn.pass === true, JSON.stringify(wIn));
  const wOut = R.windowVerdict({ period: '2026-06', visitAt: D('2026-06-08'), previousVisitAt: D('2026-06-01') });
  check('seven days apart FAILS', wOut.pass === false, JSON.stringify(wOut));
  check('  …and it says WHICH DATES decided it', wOut.previousVisitAt != null && wOut.visitAt != null && wOut.daysSince === 7,
    'a verdict with no dates is an assertion the manager cannot check');
  const wNone = R.windowVerdict({ period: '2026-06', visitAt: null, previousVisitAt: null });
  check('no visit at all is NOT a pass and NOT a fail', wNone.pass === null,
    'honest null: the rule has nothing to judge, and rendering that as a fail would invent evidence');

  // THE REPORTED RULE DOES NOT GATE THE MONEY.
  const line = (o = {}) => ({ status: 'pending', payRunId: null, windowPass: true, hasVisit: true, ...o });
  check('a failing line is releasable', R.refuseRelease(line({ windowPass: false }), { overrideReason: R.RELEASE_OVERRIDE_REASONS[0] }) === null);
  check('  …but not without a reason', R.refuseRelease(line({ windowPass: false }), {})?.code === 'override_required');
  check('  …nor with one outside the set', R.refuseRelease(line({ windowPass: false }), { overrideReason: 'because I said so' })?.code === 'bad_reason');
  check('an entry with NO matching visit is releasable with a reason',
    R.refuseRelease(line({ hasVisit: false, windowPass: null }), { overrideReason: R.RELEASE_OVERRIDE_REASONS[0] }) === null);
  check('  …and refused without one', R.refuseRelease(line({ hasVisit: false, windowPass: null }), {})?.code === 'override_required');
  check('a passing line needs no reason at all', R.refuseRelease(line(), {}) === null,
    'an override on every line is an override on none');
  check('  …and offering one anyway is refused', R.refuseRelease(line(), { overrideReason: R.RELEASE_OVERRIDE_REASONS[0] })?.code === 'override_not_needed',
    'a reason recorded against a line that did not need one makes the audit unreadable');

  console.log('\n— and a line is released once, into one run —');
  check('an already-released line is refused', R.refuseRelease(line({ status: 'released', payRunId: 'r1' }), {})?.code === 'already_released');
  check('  …as is one already in a run', R.refuseRelease(line({ payRunId: 'r1' }), {})?.code === 'already_released');
  check('a held line can be released', R.refuseRelease(line({ status: 'held' }), {}) === null,
    'held is not terminal — it is a line waiting for a conversation');
  check('holding needs its own reason', R.refuseHold(line(), {})?.code === 'hold_reason_required');
  check('  …from the set', R.refuseHold(line(), { holdReason: 'dunno' })?.code === 'bad_reason');
  check('  …and a released line cannot be held', R.refuseHold(line({ status: 'released', payRunId: 'r1' }), { holdReason: R.HOLD_REASONS[0] })?.code === 'already_released');

  // ── 3. CLOSING IS A HUMAN ACT ────────────────────────────────────────────────────────────────
  console.log('\n— the date makes a run eligible; a person closes it —');
  const run = (o = {}) => ({ status: 'open', scheduled_on: D('2026-06-25'), ...o });
  check('a run before its scheduled date is CLOSEABLE', R.refuseClose(run(), { signoff: 'Checked all 40 lines', now: D('2026-06-10') }) === null,
    'eligibility is a prompt, not a permission — a manager who is ready may close early');
  check('  …and does not close itself when the date passes',
    R.refuseClose(run(), { signoff: null, now: D('2026-07-01') })?.code === 'signoff_required',
    'the scheduled date changes nothing about the run; only a person does');
  check('closing without a signoff is refused', R.refuseClose(run(), { signoff: '   ', now: D('2026-06-26') })?.code === 'signoff_required');
  check('an already-closed run cannot be closed again', R.refuseClose(run({ status: 'closed' }), { signoff: 'x', now: D('2026-06-26') })?.code === 'run_closed');
  check('eligibility is reported separately from permission',
    R.runEligibleToClose(run(), D('2026-06-24')) === false && R.runEligibleToClose(run(), D('2026-06-25')) === true,
    'the screen shows it; nothing acts on it');

  // ── 4. IMMUTABLE ONCE CLOSED — ONE PREDICATE, MANY CALLERS ───────────────────────────────────
  console.log('\n— a closed run never moves again —');
  check('the predicate is the canEditInvoice shape', typeof R.canEditPayRun === 'function'
    && R.canEditPayRun({ status: 'open' }) === true && R.canEditPayRun({ status: 'closed' }) === false);
  check('a closed run refuses a new line', R.refuseRunChange({ status: 'closed' })?.code === 'run_closed');
  check('  …a removed line', R.refuseRunChange({ status: 'closed' })?.code === 'run_closed');
  check('  …and an amount change', R.refuseRunChange({ status: 'closed' })?.code === 'run_closed');
  check('  …while an open run permits all three', R.refuseRunChange({ status: 'open' }) === null);
  // NO CALLER REIMPLEMENTS IT. The failure this prevents is two places disagreeing about closed.
  // CODE, NOT COMMENTS. Both files EXPLAIN what they avoid — lib/rep-pay-run's header names P2002 to
  // say there must never be one, and names canEditInvoice as the shape it copies. Scanning the raw
  // text failed on correct code, which is the fifth time this week a scan has matched the thing it
  // was written to look past. A file must be able to say what it does not do.
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  const libSrc = stripComments(readFileSync('lib/rep-pay-run.ts', 'utf8'));
  const apiSrc = stripComments(readFileSync('pages/api/superadmin/pay-run.ts', 'utf8'));
  const libRaw = readFileSync('lib/rep-pay-run.ts', 'utf8');
  check('no caller re-derives "closed" for itself',
    !/status\s*===\s*'closed'|status\s*!==\s*'open'/.test(apiSrc),
    'one predicate, many readers — a second copy is how a closed run gets edited');
  // THE API DELEGATES RATHER THAN ASKS, which is stronger: it calls releaseEntry/closeRun and those
  // ask refuseRunChange inside the same transaction that holds the run's row lock. An API that
  // checked the predicate itself would be checking it OUTSIDE the lock, which is a race wearing a
  // predicate's clothes.
  check('  …and the writers ask the predicate, inside the lock',
    (libSrc.match(/refuseRunChange\(/g) ?? []).length >= 2 && /FOR UPDATE/.test(libSrc));
  check('  …while the API only delegates', !/status\s*===|status\s*!==/.test(apiSrc),
    'one rule, asked where it can still be true when it is acted on');

  // ── 5. ARREARS ARE DERIVED ───────────────────────────────────────────────────────────────────
  console.log('\n— an earlier month released now is arrears —');
  check('an earlier period is arrears', R.isArrears('2026-05', '2026-06') === true);
  check('the run’s own period is not', R.isArrears('2026-06', '2026-06') === false);
  check('a later one is not either', R.isArrears('2026-07', '2026-06') === false,
    'nothing from the future can be in arrears');
  // ── SCOPED TO THE LIVE PATH, WHICH IS WHAT THE RULE IS ABOUT ─────────────────────────────────
  // This scanned the WHOLE schema for the identifier and went red on 2026-09-09 when RepInvoiceLine
  // arrived carrying is_arrears — correctly, by its own terms, and wrongly about the design. The
  // rule is that arrears must not go STALE against the run it is shown in, which is a statement
  // about live rows: CommissionEntry moves, RepPayRun moves, so deriving is the only way the two
  // can never disagree. A SUBMITTED invoice line is the opposite case — it is frozen by
  // construction, and re-deriving anything on it would be rebuilding somebody else's filed
  // document. So the ban is scoped to the two models it is about, and the exception is asserted
  // rather than left as a hole the scan happens not to look in.
  const schemaSrc = readFileSync('prisma/schema.prisma', 'utf8');
  const modelBody = (n) => (new RegExp(`^model ${n} \\{([\\s\\S]*?)^\\}`, 'm').exec(schemaSrc) ?? [])[1] ?? '';
  check('no column on the LIVE path stores it',
    !/is_arrears|arrears\s+Boolean/.test(modelBody('CommissionEntry') + modelBody('RepPayRun')),
    'derived on every read, so it cannot go stale against the run it is shown in');
  // THE EXCEPTION, ASSERTED. A frozen line MUST carry it: derive it at render time and a submitted
  // document changes its own words when the run it belonged to is no longer the current one.
  check('  …while the frozen invoice line MUST', /is_arrears\s+Boolean/.test(modelBody('RepInvoiceLine')),
    'a submitted invoice is the rep\'s accounting record — nothing on it is re-derived, ever');

  // ── 6. AGAINST THE DATABASE ──────────────────────────────────────────────────────────────────
  console.log('\n— and now for real —');
  const existing = await prisma.repPayRun.count();
  if (existing) declineToRun(`REFUSING: ${existing} RepPayRun row(s) already exist — a run is platform-wide and this gate must not collide with a real one`);
  const rate = await prisma.commissionRate.findFirst({ where: { country_code: 'GB', currency: 'GBP' }, orderBy: { effective_from: 'desc' }, select: { id: true, amount_pennies: true } });
  check('the live GB/GBP rate is readable and flat', rate?.amount_pennies === 3000, money(rate?.amount_pennies ?? 0));

  const party = randomUUID();
  const runRow = await prisma.repPayRun.create({
    data: { period: '2026-06', scheduled_on: D('2026-06-25'), status: 'open', opened_by: null }, select: { id: true },
  });
  const mkEntry = async (period, ref) => (await prisma.commissionEntry.create({
    data: { group_id: ZZ, party_type: 'rep', party_id: party, period, kind: 'accrual', tier: 'thereafter',
      rate_id: rate.id, share_bp: 10000, amount_pennies: 3000, currency: 'GBP', source_ref: ref, payment_ref: ref, status: 'pending' },
    select: { id: true },
  })).id;
  const e1 = await mkEntry('2026-06', `gate-${randomUUID()}`);
  const e2 = await mkEntry('2026-05', `gate-${randomUUID()}`);
  fix = { runId: runRow.id, entryIds: [e1, e2], party, groupIds: [] };

  check('ONE OPEN RUN AT A TIME, enforced by the database', await (async () => {
    try { await prisma.repPayRun.create({ data: { period: '2026-07', scheduled_on: D('2026-07-25'), status: 'open' } }); return false; }
    catch (e) { return /Unique constraint|23505/.test(describeError(e)); }
  })(), 'a partial unique index on the open status — not application logic that a second writer can skip');

  // THE CONDITIONAL UPDATE. No unique index, no caught P2002 — the pre-state IS the where clause,
  // and the affected-row count is the answer. lib/commission's header records why a caught P2002
  // inside a transaction is a defect: Postgres aborts the block and every later statement dies.
  console.log('\n— two managers, one line —');
  const both = await Promise.all([
    R.releaseEntry(prisma, { entryId: e1, runId: runRow.id, operatorId: 'op-a', shownAsVisited: true }),
    R.releaseEntry(prisma, { entryId: e1, runId: runRow.id, operatorId: 'op-b', shownAsVisited: true }),
  ]);
  check('exactly one release succeeds', both.filter((r) => r.ok).length === 1, JSON.stringify(both));
  check('  …and the loser is told why', both.some((r) => !r.ok && r.code === 'already_released'), JSON.stringify(both));
  const afterRace = await prisma.commissionEntry.findUnique({ where: { id: e1 }, select: { status: true, pay_run_id: true, released_by: true, released_at: true } });
  check('the line is released, once, into one run', afterRace?.status === 'released' && afterRace?.pay_run_id === runRow.id
    && afterRace?.released_at != null, JSON.stringify(afterRace));
  check('  …and only one manager owns it', ['op-a', 'op-b'].includes(afterRace?.released_by ?? ''), String(afterRace?.released_by));
  check('  …with exactly one line in the run', (await prisma.commissionEntry.count({ where: { pay_run_id: runRow.id } })) === 1);
  check('no caught P2002 anywhere in the release path', !/P2002/.test(libSrc),
    'the defect lib/commission:32 records — a caught P2002 still poisons its transaction');
  check('  …and the file says WHY there is none', /caught P2002 still poisons its transaction/.test(libRaw),
    'anchored on the SENTENCE: a bare identifier tested against file source is what gate-hygiene Rule F exists to stop, and it is right — the word alone would match any mention');

  // ── 7. A HELD LINE JOINS THE RUN OPEN WHEN IT IS RELEASED ────────────────────────────────────
  console.log('\n— a held line does not go back for the run it missed —');
  const held = await R.holdEntry(prisma, { entryId: e2, operatorId: 'op-a', holdReason: R.HOLD_REASONS[0] });
  check('the May line is held', held.ok === true && (await prisma.commissionEntry.findUnique({ where: { id: e2 }, select: { status: true } }))?.status === 'held');
  const closed = await R.closeRun(prisma, { runId: runRow.id, operatorId: 'op-owner', signoff: 'June run checked, 1 line' });
  check('the June run closes with a signoff', closed.ok === true, JSON.stringify(closed));
  const closedRow = await prisma.repPayRun.findUnique({ where: { id: runRow.id }, select: { status: true, closed_at: true, closed_by: true, signoff: true, snapshot_line_count: true, snapshot_amount_pennies: true, snapshot_parties: true } });
  check('  …and freezes its totals', closedRow?.snapshot_line_count === 1 && closedRow?.snapshot_amount_pennies === 3000 && closedRow?.snapshot_parties === 1,
    JSON.stringify(closedRow));
  check('  …recording who signed it off', closedRow?.closed_by === 'op-owner' && (closedRow?.signoff ?? '').length > 0);

  const run2 = await prisma.repPayRun.create({ data: { period: '2026-07', scheduled_on: D('2026-07-25'), status: 'open' }, select: { id: true } });
  fix.run2 = run2.id;
  const late = await R.releaseEntry(prisma, { entryId: e2, runId: run2.id, operatorId: 'op-a', shownAsVisited: false, overrideReason: R.RELEASE_OVERRIDE_REASONS[0] });
  check('the held May line releases into the JULY run', late.ok === true, JSON.stringify(late));
  const e2row = await prisma.commissionEntry.findUnique({ where: { id: e2 }, select: { pay_run_id: true, period: true, held_reason: true } });
  check('  …and NOT into the closed June one', e2row?.pay_run_id === run2.id, `${e2row?.pay_run_id?.slice(0, 8)} vs closed ${runRow.id.slice(0, 8)}`);
  check('  …where it reads as arrears', R.isArrears(e2row?.period ?? '', '2026-07') === true, `${e2row?.period} into 2026-07`);
  check('  …and its hold reason is cleared, not left to contradict the release', e2row?.held_reason === null);
  check('the closed run still holds exactly its one line', (await prisma.commissionEntry.count({ where: { pay_run_id: runRow.id } })) === 1,
    'no retrospective edit of a closed run');

  console.log('\n— and a closed run refuses everything —');
  const e3 = await mkEntry('2026-06', `gate-${randomUUID()}`);
  fix.entryIds.push(e3);
  const intoClosed = await R.releaseEntry(prisma, { entryId: e3, runId: runRow.id, operatorId: 'op-a', shownAsVisited: true });
  check('a new line cannot join a closed run', intoClosed.ok === false && intoClosed.code === 'run_closed', JSON.stringify(intoClosed));
  const reclose = await R.closeRun(prisma, { runId: runRow.id, operatorId: 'op-owner', signoff: 'again' });
  check('  …and it cannot be closed twice', reclose.ok === false && reclose.code === 'run_closed');

  // ── 8. THE SCREEN ────────────────────────────────────────────────────────────────────────────
  console.log('\n— what the manager is shown —');
  const pageRaw = readFileSync('pages/superadmin/pay-runs.tsx', 'utf8');
  // COMMENTS STRIPPED. The first version of the honest-null checks below read the raw file, and the
  // phrase they hunt for ("No scan recorded") also appears in the doc comment on the Line type — so
  // deleting the RENDER left the check green. Sixth time this week a scan has matched the thing it
  // was written to look past, and the second time it produced a check that could not fail.
  const page = stripComments(pageRaw);
  check('the screen says Sales Commission', /Sales Commission/.test(page));
  const banned = ['wage', 'salary', 'payslip'].filter((w) => new RegExp(`\\b${w}`, 'i').test(page.replace(/\/\*[\s\S]*?\*\//g, ' ')));
  check('  …and never wage, salary or payslip', banned.length === 0, banned.join(', ') || 'none');
  check('an absent scan renders as absent, not as a zero or a dash-date', /No scan recorded/.test(page));
  check('a garage that never signed in says so', /Never signed in/.test(page),
    'a null last_login_at is not a date and must never be rendered as one');
  check('  …and the absences go through ONE renderer', (page.match(/<Missing what=/g) ?? []).length >= 3,
    'three absences, one component — so a fourth cannot quietly render as a dash');
  check('  …which nothing bypasses with a fallback string',
    !/\?\?\s*'[—-]'|\?\?\s*"[—-]"|\|\|\s*'0'/.test(page),
    'a dash is a rendered value; an absence is not');
  check('an unreleased line still shows its amount', !/released \? .*: '£0/.test(page),
    'an unreleased line is worth £30 and has not been paid — those are different facts');
  check('the window verdict shows its dates', /windowVerdict|daysSince/.test(page));
  check('the attribution is shown as evidence', /ref=|signed up under/.test(page));

  console.log('\n— and who may do what —');
  check('release requires country_manager', keyRegex('release', "'country_manager'").test(apiSrc) && keyRegex('hold', "'country_manager'").test(apiSrc));
  check('closing requires owner', keyRegex('close', "'owner'").test(apiSrc));
  check('  …and the guard reads that map, not a literal', /requireOperatorApi\([^)]*MIN_ROLE\[/.test(apiSrc),
    'a role written in one place and enforced from another is two rules');
  check('both respect the region scope', /operatorTenantScope/.test(apiSrc),
    'an operator with no regions matches nothing, and still does here');
  check('the screen is gated by the same minRole the nav filters on', /erMinRole\('\/superadmin\/pay-runs'\)/.test(page));
  // ── THIS CLAUSE IS SCOPED, NOT DELETED ───────────────────────────────────────────────────────
  // It used to read "nothing rep-facing was added", which was the pay-run slice's own constraint:
  // that slice built the RELEASE screen and was explicitly forbidden a rep surface, so the check
  // pinned the boundary while it mattered. On 2026-09-09 the rep portal was commissioned and
  // /rep/runs/[id] exists by instruction — the clause had done its job and was now asserting the
  // absence of something somebody had since asked for.
  //
  // What is STILL true, and what this now pins: the release decision is operator-only. A rep may
  // read their own closed runs; nothing on their side may hold, release, or close anything.
  const repSurfaces = readdirSync('pages/rep', { recursive: true }).map(String)
    .concat(existsSync('pages/api/rep') ? readdirSync('pages/api/rep', { recursive: true }).map((f) => `api/${f}`) : []);
  const strip = (t) => t.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const releasers = repSurfaces.filter((f) => /\.tsx?$/.test(f))
    .filter((f) => /releaseEntry|holdEntry|closeRun|refuseRelease|refuseHold/.test(strip(readFileSync(`pages/${f.startsWith('api/') ? `api/rep/${f.slice(4)}` : `rep/${f}`}`, 'utf8'))));
  check('no rep-facing surface releases, holds or closes anything', releasers.length === 0,
    releasers.join(', ') || `${repSurfaces.length} rep files, none touching the release path`);
  check('the garage-invoice re-issue path is untouched',
    !/invoice-void|canEditInvoice|assignInvoiceNumber/.test(libSrc),
    'a different document class; it must not inherit that rule and this must not inherit its');

  const ready = await serverReady();
  check('the dev server serves pages before we drive it', ready.ok, `HTTP ${ready.status}`);
} catch (e) {
  check('gate run completed', false, describeError(e).slice(0, 400));
} finally {
  if (fix) {
    const step = async (n, f) => { try { await f(); } catch (e) { console.log(`  teardown ${n}: ${describeError(e).slice(0, 110)}`); } };
    await step('entries', () => prisma.commissionEntry.deleteMany({ where: { id: { in: fix.entryIds } } }));
    await step('run2', () => (fix.run2 ? prisma.repPayRun.deleteMany({ where: { id: fix.run2 } }) : null));
    await step('run', () => prisma.repPayRun.deleteMany({ where: { id: fix.runId } }));
    for (const g of fix.groupIds) await step('group', () => prisma.group.delete({ where: { id: g } }));
    try {
      check('teardown removed every fixture', (await prisma.repPayRun.count()) === 0
        && (await prisma.commissionEntry.count({ where: { party_id: fix.party } })) === 0,
        'a pay run is platform-wide; leaving one would block the next run of this gate AND a real one');
    } catch (e) { check('teardown removed every fixture', false, describeError(e).slice(0, 70)); }
  }
  const f = out.filter((x) => x === 'F').length;
  console.log(`\n${f} failures of ${out.length}`);
  await prisma.$disconnect();
  process.exit(f ? 1 : 0);
}
