/**
 * File: scripts/no-show-gate.mjs
 * NO-SHOW: a different fact from cancellation, refused where work has started, and a derived count
 * that corrects itself on reopen.
 *
 * Fixtures on ZZ Gate Garage only. Never TMBS. Throwaway rows, created and removed here.
 */
import './_gate-preflight.mjs';
const { zzSite, describeError } = await import('./_gate-preflight.mjs');
import './_ts.mjs';
const { keyRegex } = await import('../lib/anchored-match.ts');
const { prisma } = await import('../lib/db.ts');
const { findTransition, nextTransitions, FREES_THE_SLOT, HIDDEN_FROM_DIARY, paymentState, reBookingDoor, JOB_STATUSES } = await import('../lib/jobcard-status.ts');
const { applyCardTransition } = await import('../lib/jobcard-transition.ts');
const { noShowHistory, noShowLostInPeriod } = await import('../lib/no-show.ts');
const R = await import('../lib/no-show-reopen.ts').catch((e) => ({ __err: describeError(e) }));
/**
 * CAN THE REOPEN EVEN BE CALLED? Red-first means the clauses below report red one by one — not
 * that the first missing function throws and takes the rest of the fixture with it. The first
 * run of this section did exactly that: 2 red of 27, where 41 clauses had run a moment earlier,
 * and every clause this section exists for was never reached. A crash is not a red.
 */
const canReopen = typeof R.reopenNoShow === 'function';
const { cardWasAccepted } = await import('../lib/acceptance-provenance.ts');
const { fetchDayBookings } = await import('../lib/diary-day.ts');
const { QUOTE_CLOSED_CARD_STATUSES } = await import('../lib/quotes-list.ts');
const { WIP_STATUSES } = await import('../lib/wip.ts');
const { readFileSync } = await import('node:fs');

const ZZ = 'c75ac44e-250a-4c90-98ba-a8326e98dad5';
const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };

// ── 1. THE TABLE — every edge, and every refusal, against the pure functions ─────────────────────
console.log('\n— the transition table —');
for (const from of ['draft', 'quoted', 'accepted']) {
  const tr = findTransition(from, 'no_show');
  check(`${from} → no_show exists, commercial, gated on the booking`,
    tr?.kind === 'commercial' && tr?.gate === 'booking_exists', JSON.stringify(tr));
}
for (const from of ['in_progress', 'invoiced', 'paid', 'done', 'declined', 'cancelled']) {
  check(`${from} → no_show is REFUSED`, findTransition(from, 'no_show') === null,
    from === 'in_progress' ? 'work started — the card cannot become a no-show' : '');
}
const exits = nextTransitions('no_show');
/**
 * NO TABLE EXIT AT ALL, and that is the change — this clause used to assert exactly one, to
 * 'draft'. A from->to table cannot express "back to whatever it was", and 'draft' was the wrong
 * fixed answer: 11 of the 13 no-shows on production were 'accepted' when they were marked, so the
 * hardcoded destination silently un-accepted eleven accepted quotes. Same reason no_charge has
 * no exits either. The door is reopen_no_show, which restores no_show_prior_status.
 */
check('no_show has NO exit in the table — the door is reopen_no_show, not a fixed destination',
  exits.length === 0, JSON.stringify(exits));
check('  …and the re-booking door still NAMES itself, so a refusal can say what to do',
  reBookingDoor('no_show') === 'reopen', String(reBookingDoor('no_show')));

// ── 2. THE UNIONS ────────────────────────────────────────────────────────────────────────────────
console.log('\n— every reader that enumerates statuses has decided —');
check('no_show FREES the slot for a walk-in', FREES_THE_SLOT.includes('no_show'), FREES_THE_SLOT.join(', '));
check('and stays VISIBLE as a ghost — not hidden from the board', !HIDDEN_FROM_DIARY.includes('no_show'), HIDDEN_FROM_DIARY.join(', '));
check('no_show closes the quote thread', QUOTE_CLOSED_CARD_STATUSES.includes('no_show'));
check('no_show is NOT work-in-progress', !WIP_STATUSES.includes('no_show'), WIP_STATUSES.join(', '));
check('money label is unpaid, never unknown', paymentState('no_show') === 'unpaid',
  'unknown would render the raw status where a money chip belongs');
const tiles = readFileSync('lib/dashboard-tiles.ts', 'utf8');
check('the forward-booked read uses FREES_THE_SLOT — the occupancy question',
  keyRegex('status', '{ notIn: FREES_THE_SLOT as any }').test(tiles),
  'the one reader that would have kept counting a no-show as booked hours');
const tilesCode = tiles.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check("  …and the inline ['cancelled', 'declined'] is gone from the code", !keyRegex('notIn', "['cancelled', 'declined']").test(tilesCode));
const api = readFileSync('pages/api/jobcard-status.ts', 'utf8');
check('a no-show revokes the customer link, in the same tx as the cancel path',
  /if \(to === 'no_show'\) await revokeMagicLinksForCard\(jobCardId, 'no_show', tx\);/.test(api));

// ── 3. ON ZZ: the applier, the audit note, the derived count, the reopen ─────────────────────────
console.log('\n— throwaway fixtures on ZZ Gate Garage —');
let fix = null;
try {
  const site = await zzSite(prisma);
  const resource = await prisma.resource.findFirst({ where: { site_id: site.id }, select: { id: true } });
  const cust = await prisma.customer.create({
    data: { group_id: ZZ, site_id: site.id, name: 'NoShow Gate Fixture', phone: '07700 900999', phone_e164: '447700900999' },
    select: { id: true },
  });
  // vehicle_id is required on JobCard — a throwaway vehicle on the same tenant.
  const veh = await prisma.vehicle.create({
    data: { group_id: ZZ, registration: 'ZZ99 NSG', registration_normalized: 'ZZ99NSG' },
    select: { id: true },
  });
  const mkCard = (booked) => prisma.jobCard.create({
    data: {
      group_id: ZZ, site_id: site.id, customer_id: cust.id, vehicle_id: veh.id, status: 'accepted',
      ...(booked && resource ? {
        resource_id: resource.id,
        start_at: new Date('2026-08-17T09:00:00Z'), end_at: new Date('2026-08-17T11:00:00Z'),
        booking_duration_minutes: 120,
      } : {}),
    },
    select: { id: true },
  });
  const card = await mkCard(true);
  fix = { custId: cust.id, vehId: veh.id, cardIds: [card.id] };

  // The applier writes the status, the audit row, and the note into the diff.
  const moved = await prisma.$transaction((tx) =>
    applyCardTransition(tx, { groupId: ZZ, jobCardId: card.id, from: 'accepted', to: 'no_show', actorUserId: null, note: '  didn’t answer the phone  ' }));
  check('accepted → no_show applies through the shared writer', moved.ok === true);
  const audit = await prisma.auditLog.findFirst({
    where: { group_id: ZZ, entity_id: card.id, action: 'status.no_show' },
    orderBy: { created_at: 'desc' }, select: { diff_json: true },
  });
  check('the audit row carries the note, trimmed — no column anywhere', audit?.diff_json?.note === 'didn’t answer the phone',
    JSON.stringify(audit?.diff_json));
  const schema = readFileSync('prisma/schema.prisma', 'utf8');
  check('  …the check is discriminating: JobCard has no no_show/reason column',
    !/no_show_note|no_show_reason|cancel_reason/.test(schema));

  // Illegal edge refused by the same pure table the API consults.
  const bad = await prisma.$transaction((tx) =>
    applyCardTransition(tx, { groupId: ZZ, jobCardId: card.id, from: 'in_progress', to: 'no_show', actorUserId: null }));
  check('the applier refuses in_progress → no_show', bad.ok === false && bad.refusal.code === 'illegal_transition');

  // The DERIVED count, and the reopen correcting it — the argument for deriving.
  let hist = await noShowHistory(prisma, cust.id);
  check('the derived count reads 1, dated by the missed slot', hist.count === 1 && hist.dates[0] === '2026-08-17',
    JSON.stringify(hist));
  const two = await mkCard(true);
  fix.cardIds.push(two.id);
  await prisma.$transaction((tx) => applyCardTransition(tx, { groupId: ZZ, jobCardId: two.id, from: 'accepted', to: 'no_show', actorUserId: null }));
  hist = await noShowHistory(prisma, cust.id);
  check('a second no-show reads 2, most recent first', hist.count === 2);
  // THROUGH THE REOPEN PATH, not the table edge this gate used to drive: 'no_show -> draft' is gone.
  if (canReopen) await prisma.$transaction((tx) => R.reopenNoShow(tx, { groupId: ZZ, jobCardId: two.id, actorUserId: null }));
  hist = await noShowHistory(prisma, cust.id);
  check('REOPEN corrects the count to 1 by construction — no counter to unwind', hist.count === 1, JSON.stringify(hist));
  // ── 4. THE CAPACITY LINE: slot-month attribution, reopen correction, absent-when-zero ─────────
  console.log('\n— booked time lost, attributed to the SLOT\'s month —');
  // `two` was reopened above, so exactly ONE no-show stands: card one, slot 2026-08-17, 120 min.
  const aug = await noShowLostInPeriod(prisma, { groupId: ZZ, siteIds: [site.id], from: new Date('2026-08-01T00:00:00Z'), to: new Date('2026-09-01T00:00:00Z') });
  check('the slot month carries the loss', aug.count === 1 && aug.minutes === 120, JSON.stringify(aug));
  const sep = await noShowLostInPeriod(prisma, { groupId: ZZ, siteIds: [site.id], from: new Date('2026-09-01T00:00:00Z'), to: new Date('2026-10-01T00:00:00Z') });
  check('a month with no slots reads zero — the UI line is ABSENT, never £0.00', sep.count === 0 && sep.minutes === 0);
  // A no-show MARKED long after its slot: backdate the second card's slot to July, re-mark it.
  await prisma.jobCard.update({ where: { id: two.id }, data: { start_at: new Date('2026-07-10T09:00:00Z'), end_at: new Date('2026-07-10T10:30:00Z'), booking_duration_minutes: 90 } });
  await prisma.$transaction(async (tx) => {
    await applyCardTransition(tx, { groupId: ZZ, jobCardId: two.id, from: 'draft', to: 'quoted', actorUserId: null }).catch(() => {});
    return applyCardTransition(tx, { groupId: ZZ, jobCardId: two.id, from: 'quoted', to: 'no_show', actorUserId: null });
  }).catch(() => {});
  const jul = await noShowLostInPeriod(prisma, { groupId: ZZ, siteIds: [site.id], from: new Date('2026-07-01T00:00:00Z'), to: new Date('2026-08-01T00:00:00Z') });
  check('marked TODAY, slot in JULY → lands in JULY (the closed month legitimately moves)',
    jul.count === 1 && jul.minutes === 90,
    `${JSON.stringify(jul)} — today's date never enters the query`);
  // THROUGH THE REOPEN PATH, like the one above. This was the SECOND call site driving the
  // removed table edge, and rewriting only the first left it refusing silently — the card stayed
  // no_show and July went on carrying the loss. Found by this clause, which is what it is for.
  if (canReopen) await prisma.$transaction((tx) => R.reopenNoShow(tx, { groupId: ZZ, jobCardId: two.id, actorUserId: null }));
  const jul2 = await noShowLostInPeriod(prisma, { groupId: ZZ, siteIds: [site.id], from: new Date('2026-07-01T00:00:00Z'), to: new Date('2026-08-01T00:00:00Z') });
  check('and the reopen un-moves it, in the month the slot sat', jul2.count === 0 && jul2.minutes === 0);

  // ── 5. THE GHOST: visible on the board, free on the lift, absent from the money ───────────────
  console.log('\n— the ghost: display keeps it, occupancy frees it, the money never counts it —');
  // Re-mark card one (reopened above? no — card one still stands as no_show, slot 2026-08-17).
  // Give it a priced line so the money exclusion is tested against a NON-zero value: a £0 fixture
  // would pass a broken reducer too.
  await prisma.jobCardItem.create({ data: { job_card_id: card.id, item_type: 'labour', description: 'gate: priced ghost line', qty: 1, unit_price: 100, vat_rate: 20 } });
  const dayRows = await fetchDayBookings(site.id, new Date('2026-08-17T00:00:00Z'), new Date('2026-08-18T00:00:00Z'));
  const ghostRow = dayRows.find((r) => r.id === card.id);
  check('the DISPLAY read returns the no-show — the board shows the wasted slot', !!ghostRow, `${dayRows.length} rows for the day`);
  check('  …status rides with it, so the renderer can grey it', ghostRow?.status === 'no_show');
  // The OCCUPANCY question, asked exactly as the guard asks it: an overlapping booking search that
  // excludes FREES_THE_SLOT must NOT see the ghost — the walk-in takes the lift.
  const blockers = await prisma.jobCard.findMany({
    where: { resource_id: ghostRow.resource_id, status: { notIn: FREES_THE_SLOT }, start_at: { lt: new Date('2026-08-17T11:00:00Z') }, end_at: { gt: new Date('2026-08-17T09:00:00Z') } },
    select: { id: true },
  });
  check('the OCCUPANCY read does NOT see it — the slot is genuinely free', !blockers.some((b) => b.id === card.id),
    `${blockers.length} live blockers in the ghost's window`);
  // THE MONEY. The gssp reducer must skip ghosts, or the wasted slot adds itself back into
  // "Booked" through the display path while the forward-booked read drops it — two readers
  // disagreeing about one fact, on money. Comment-stripped scan, plus the block-value guard.
  const diarySrc = readFileSync('pages/admin/diary.tsx', 'utf8');
  const diaryCode = diarySrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check('the totals reducer skips ghosts', /if \(!ghost && startMs >= rangeStartMs/.test(diaryCode),
    'a no-show renders but must never land in bookedPennies/marginPennies');
  check('the block value is zero for a ghost', /fin\.seeValues && !ghost \?/.test(diaryCode));
  check('the ghost is discriminating — its line is PRICED (£100), so a broken reducer would show money',
    Number(ghostRow?.items?.[0]?.unit_price ?? 0) === 100);
  check('the ghost grey lives OUTSIDE the tenant palette', /GHOST_COLOUR/.test(readFileSync('lib/diary-colours.ts', 'utf8'))
    && !/GHOST/.test(readFileSync('lib/status-colours.ts', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')),
    'fixed grey in diary-colours; the curated band map never learns it');

  // The wiring and the wording — the tile carries it, the panel hides zero, the words say what it is.
  const tilesSrc = readFileSync('lib/dashboard-tiles.ts', 'utf8');
  check('the capacity compute carries noShows via the one helper', /noShowLostInPeriod\(prisma/.test(tilesSrc));
  const dash = readFileSync('pages/admin/dashboard.tsx', 'utf8');
  check('the panel renders the line only when count > 0', /cap\.noShows\?\.count \?\? 0\) > 0/.test(dash));
  const i18n = JSON.parse(readFileSync('public/locales/en-GB/dashboard.json', 'utf8'));
  check('the wording says BOOKED TIME and AT TODAY\'S RATE — a record and a valuation, labelled',
    /booked time/.test(i18n.capacity.noShowLost) && /today.s labour rate/.test(i18n.capacity.noShowLost),
    i18n.capacity.noShowLost);
  check('  …and the no-rate variant shows hours only, never £0.00',
    /booked time/.test(i18n.capacity.noShowLostNoRate) && !/rate/.test(i18n.capacity.noShowLostNoRate));
  // ── 6. CLAUSE A: REOPEN RESTORES WHAT THE CARD WAS ──────────────────────────────────────────
  console.log('\n— reopen: back to the status it held, not to draft —');
  check('lib/no-show-reopen exists and exports both halves',
    typeof R.refuseReopenNoShow === 'function' && typeof R.reopenNoShow === 'function', R.__err ?? '');

  // THE REFUSALS, as pure functions — the same split no_charge uses: the route decides 'permitted',
  // the predicate decides everything else, and the gate can ask it without a session.
  if (typeof R.refuseReopenNoShow === 'function') {
    const f = R.refuseReopenNoShow;
    check('  refuses when the user may not manage the site',
      f({ status: 'no_show', priorStatus: 'accepted', permitted: false })?.code === 'not_permitted');
    check('  refuses a card that is not a no-show',
      f({ status: 'accepted', priorStatus: 'accepted', permitted: true })?.code === 'not_no_show');
    /**
     * NULL PRIOR STATUS REFUSES RATHER THAN GUESSING. The 13 rows that predate the column are
     * backfilled, but a row that arrives by some other route must not be reopened into 'draft' by
     * default — that default IS the defect the column exists to remove.
     */
    check('  refuses when it does not know what the card was — never defaults to draft',
      f({ status: 'no_show', priorStatus: null, permitted: true })?.code === 'no_prior_status');
    check('  …and allows the real case', f({ status: 'no_show', priorStatus: 'accepted', permitted: true }) === null);
  }

  // END TO END on a third fixture card: accepted -> no_show -> reopen.
  const three = await mkCard(true);
  fix.cardIds.push(three.id);
  await prisma.$transaction((tx) => applyCardTransition(tx, { groupId: ZZ, jobCardId: three.id, from: 'accepted', to: 'no_show', actorUserId: null }));
  const closed = await prisma.jobCard.findUnique({ where: { id: three.id },
    select: { status: true, no_show_prior_status: true, accepted_at: true, resource_id: true, start_at: true, end_at: true } }).catch(() => null);
  check('the close STAMPS what the card was', closed?.no_show_prior_status === 'accepted',
    closed === null ? 'the card READ failed — column missing from the client?' : JSON.stringify(closed.no_show_prior_status));

  const before = { resource: closed?.resource_id, start: closed?.start_at?.toISOString(), end: closed?.end_at?.toISOString() };
  if (canReopen) await prisma.$transaction((tx) => R.reopenNoShow(tx, { groupId: ZZ, jobCardId: three.id, actorUserId: null }));
  const reopened = await prisma.jobCard.findUnique({ where: { id: three.id },
    select: { status: true, no_show_prior_status: true, accepted_at: true, resource_id: true, start_at: true, end_at: true } }).catch(() => null);

  check('REOPEN restores ACCEPTED — not draft', reopened?.status === 'accepted', String(reopened?.status));
  /**
   * AND THE ONE FUNCTION THAT ANSWERS "WAS THIS ACCEPTED" AGREES. This is the clause that would
   * have caught the lossy version: reopening to 'draft' leaves accepted_at ON the row, so a column
   * check passes while cardWasAccepted() returns FALSE — SPINE_AMBIGUOUS_ACCEPTANCE lists draft:false.
   * The evidence and the answer disagree, and only the answer is read.
   */
  check('  …and cardWasAccepted() agrees, which a column check alone would not',
    cardWasAccepted({ status: String(reopened?.status), accepted_at: reopened?.accepted_at ?? null }, false) === true,
    `status=${reopened?.status} accepted_at=${reopened?.accepted_at ? 'set' : 'null'}`);
  check('  …the stamp is CLEARED, so a reopened card cannot be reopened twice',
    reopened?.no_show_prior_status === null, String(reopened?.no_show_prior_status));
  /**
   * THE VALUES MUST BE THERE BEFORE THEY CAN BE COMPARED. Written without the truthiness guard
   * this clause compared undefined to undefined and went GREEN whenever the column was missing —
   * agreeing with itself about nothing, on the exact run where everything else was red.
   */
  check('  …and the booking record is untouched — the slot is history, not a plan',
    !!before.resource && !!before.start && !!before.end
    && reopened?.resource_id === before.resource && reopened?.start_at?.toISOString() === before.start
    && reopened?.end_at?.toISOString() === before.end, JSON.stringify(before));

  // THE TRAIL: the original row survives, and the reversal is its own event.
  const closeRows = await prisma.auditLog.count({ where: { group_id: ZZ, entity_id: three.id, action: 'status.no_show' } });
  const revRow = await prisma.auditLog.findFirst({ where: { group_id: ZZ, entity_id: three.id, action: 'status.no_show_reversed' },
    orderBy: { created_at: 'desc' }, select: { diff_json: true } });
  check('the original status.no_show row is STILL THERE — never edited, never deleted', closeRows === 1, `${closeRows} row(s)`);
  check('  …and the reversal is a SEPARATE event naming where it went back to',
    !!revRow && revRow.diff_json?.restoredTo === 'accepted', JSON.stringify(revRow?.diff_json ?? null));

  // ── 7. CLAUSE A, THE UI: one control, and nothing else let through with it ───────────────────
  console.log('\n— the reopen-only branch —');
  const ws = readFileSync('components/jobcard/JobCardWorkspace.tsx', 'utf8');
  /**
   * SLICED, NOT SEARCHED. "the file mentions a reopen button" is satisfied by a comment; what
   * matters is what the !canManage branch RETURNS. AcceptVerbal is gated only on
   * !isAcceptedOnwards, which is TRUE for no_show — it is safe today purely because this early
   * return hides the whole panel, so the branch must return the control and NOT fall through.
   */
  const i = ws.indexOf('if (!canManage)');
  const slice = i < 0 ? '' : ws.slice(i, i + 900);
  check('the actions panel has a !canManage branch at all', i >= 0);
  check('  …which offers the reopen control', /data-testid="reopen-no-show"/.test(slice), slice.slice(0, 120));
  check('  …and does NOT let AcceptVerbal through with it', !/AcceptVerbal/.test(slice));

} catch (e) {
  check('fixture run completed', false, describeError(e).slice(0, 300));
} finally {
  if (fix) {
    // AuditLog rows are deliberately LEFT — append-only is a standing rule, and rows referencing a
    // deleted fixture correctly stay: they are the record that this gate ran.
    await prisma.jobCard.deleteMany({ where: { id: { in: fix.cardIds }, group_id: ZZ } });
    await prisma.vehicle.delete({ where: { id: fix.vehId } }).catch(() => {});
    await prisma.customer.delete({ where: { id: fix.custId } });
    const left = await prisma.jobCard.count({ where: { id: { in: fix.cardIds } } })
      + await prisma.customer.count({ where: { id: fix.custId } })
      + await prisma.vehicle.count({ where: { id: fix.vehId } });
    check('teardown removed every fixture row (audit rows stay — append-only)', left === 0, `${left} left`);
  }
}

console.log(`\n${out.filter((c) => c === 'F').length} failures of ${out.length}`);
await prisma.$disconnect();
process.exit(out.includes('F') ? 1 : 0);
