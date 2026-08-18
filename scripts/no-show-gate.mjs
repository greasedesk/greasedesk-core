/**
 * File: scripts/no-show-gate.mjs
 * NO-SHOW: a different fact from cancellation, refused where work has started, and a derived count
 * that corrects itself on reopen.
 *
 * Fixtures on ZZ Gate Garage only. Never TMBS. Throwaway rows, created and removed here.
 */
import './_gate-preflight.mjs';
import './_ts.mjs';
const { prisma } = await import('../lib/db.ts');
const { findTransition, nextTransitions, OFF_DIARY_STATUSES, paymentState, JOB_STATUSES } = await import('../lib/jobcard-status.ts');
const { applyCardTransition } = await import('../lib/jobcard-transition.ts');
const { noShowHistory } = await import('../lib/no-show.ts');
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
check('no_show has exactly one exit: reopen to draft', exits.length === 1 && exits[0].to === 'draft', JSON.stringify(exits));

// ── 2. THE UNIONS ────────────────────────────────────────────────────────────────────────────────
console.log('\n— every reader that enumerates statuses has decided —');
check('no_show is OFF-DIARY — the slot frees for a walk-in', OFF_DIARY_STATUSES.includes('no_show'), OFF_DIARY_STATUSES.join(', '));
check('no_show closes the quote thread', QUOTE_CLOSED_CARD_STATUSES.includes('no_show'));
check('no_show is NOT work-in-progress', !WIP_STATUSES.includes('no_show'), WIP_STATUSES.join(', '));
check('money label is unpaid, never unknown', paymentState('no_show') === 'unpaid',
  'unknown would render the raw status where a money chip belongs');
const tiles = readFileSync('lib/dashboard-tiles.ts', 'utf8');
check('the forward-booked read uses OFF_DIARY_STATUSES, not an inline list',
  /status: \{ notIn: OFF_DIARY_STATUSES as any \}/.test(tiles),
  'the one reader that would have kept counting a no-show as booked hours');
const tilesCode = tiles.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check("  …and the inline ['cancelled', 'declined'] is gone from the code", !/notIn: \['cancelled', 'declined'\]/.test(tilesCode));
const api = readFileSync('pages/api/jobcard-status.ts', 'utf8');
check('a no-show revokes the customer link, in the same tx as the cancel path',
  /if \(to === 'no_show'\) await revokeMagicLinksForCard\(jobCardId, 'no_show', tx\);/.test(api));

// ── 3. ON ZZ: the applier, the audit note, the derived count, the reopen ─────────────────────────
console.log('\n— throwaway fixtures on ZZ Gate Garage —');
let fix = null;
try {
  const site = await prisma.site.findFirst({ where: { group_id: ZZ }, select: { id: true } });
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
  await prisma.$transaction((tx) => applyCardTransition(tx, { groupId: ZZ, jobCardId: two.id, from: 'no_show', to: 'draft', actorUserId: null }));
  hist = await noShowHistory(prisma, cust.id);
  check('REOPEN corrects the count to 1 by construction — no counter to unwind', hist.count === 1, JSON.stringify(hist));
} catch (e) {
  check('fixture run completed', false, String(e?.message ?? e).slice(0, 300));
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
