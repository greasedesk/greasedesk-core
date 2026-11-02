/**
 * File: scripts/marketing-engine-db-gate.mjs
 *
 * THE PART OF THE ENGINE ONLY THE DATABASE CAN ANSWER.
 *
 * scripts/marketing-engine-gate.mjs proves the rules, the state machine, the templates and the
 * wiring, all without a database — 229 clauses that are true of the source. Six things are NOT
 * true of the source and cannot be:
 *
 *   1. THE PAIR CHECK ACTUALLY REFUSES. The source says `(trial_garage, prospect)` is illegal. Only
 *      an INSERT finds out whether Postgres agrees, and a CHECK that was written but never applied
 *      is indistinguishable from one that was.
 *   2. THE UNIQUE INDEX ACTUALLY REFUSES a second enrolment for one subject on one sequence — the
 *      failure a marketing engine is most likely to produce, which is the same five emails twice.
 *   3. THE STATE CHECK ACTUALLY REFUSES a stop with no reason, and an active row with no due date.
 *   4. THE LEASE CAP ACTUALLY REFUSES more than five minutes.
 *   5. THE CLAIM REALLY SERIALISES. Two runs over one due step must claim it once. The source shows
 *      a conditional updateMany; whether that is a real guard depends on the database doing what
 *      the source assumes, and it is the one clause in this slice whose premise is not ours.
 *   6. THE CASCADE from an enrolment to its lease — the only real foreign key here, since the
 *      subject deliberately has none.
 *
 * ── IT DECLINES RATHER THAN PASSING OVER TABLES IT CANNOT SEE ──────────────────────────────────
 * Migration 20261102120000_marketing_engine is the OWNER'S to apply. Until it is applied to this
 * database none of the six questions above can be asked, and a gate reporting 0 red over four
 * absent tables would be the worst outcome available: a positive report of safety produced by
 * looking at nothing. It declines, by name, saying which migration to apply.
 *
 * ── THE FIXTURES ────────────────────────────────────────────────────────────────────────────────
 * Throwaway enrolments on invented subject ids under one run-unique prefix, removed in a `finally`.
 * The ids resolve to nothing on purpose: nothing here sends, and the sending switch is never
 * written — the lease exists precisely so a gate never has to flip the owner's switch. A killed run
 * leaves at most an expired lease and some orphan rows under its own prefix, which no query of the
 * real engine can reach and which the next run's prefix cannot collide with. The last clause
 * ASSERTS the switches were not touched, rather than merely intending it.
 */
import './_gate-preflight.mjs';
import './_ts.mjs';
const { gatePrisma, declineToRun } = await import('./_gate-preflight.mjs');
const { randomUUID } = await import('node:crypto');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
/** Did the database REFUSE this write, and for the constraint we meant? */
const refused = async (fn, constraint) => {
  try { await fn(); return { ok: false, why: 'the database ACCEPTED it' }; }
  catch (e) {
    const msg = String(e?.message ?? '');
    return { ok: msg.includes(constraint), why: msg.includes(constraint) ? constraint : msg.replace(/\s+/g, ' ').slice(0, 140) };
  }
};

const prisma = await gatePrisma();
const RUN = `gate-${randomUUID().slice(0, 8)}`;
const mk = (n) => `${RUN}-${n}`;

// ── CAN THE QUESTIONS BE ASKED AT ALL? ──────────────────────────────────────────────────────────
const tables = await prisma.$queryRawUnsafe(
  `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
  ['MarketingEnrolment', 'MarketingSending', 'MarketingSendingLease', 'MarketingCopy'],
).catch(() => []);
if (tables.length !== 4) {
  await prisma.$disconnect().catch(() => {});
  declineToRun(
    `the marketing engine's tables are not in this database — ${tables.length} of 4 found `
    + `(${tables.map((t) => t.table_name).join(', ') || 'none'}). Migration `
    + '20261102120000_marketing_engine is additive and the owner\'s to apply: `node scripts/migrate-apply.mjs`. '
    + 'Nothing is asserted over absent tables, because 0 red across four missing ones would be a '
    + 'positive report of safety produced by looking at nothing.',
  );
}

const ACTIVE = (subject) => ({
  sequence_key: 'garage_prospect', subject_type: 'prospect', subject_id: subject,
  state: 'active', next_step: 1, next_due_at: new Date(), started_at: new Date(),
  consent_source: 'rep_visit', consent_at: new Date(),
});

try {
  const E = await import('../lib/marketing-engine.ts');

  // ══ 1. THE PAIR CHECK ═════════════════════════════════════════════════════════════════════════
  console.log('— the pair CHECK refuses an audience pointed at the wrong table —');
  for (const k of E.SEQUENCE_KEYS) {
    const wrong = E.SUBJECT_TYPES.find((t) => t !== E.SUBJECT_OF[k]);
    const r = await refused(() => prisma.marketingEnrolment.create({
      data: { ...ACTIVE(mk(`pair-${k}`)), sequence_key: k, subject_type: wrong },
    }), 'MarketingEnrolment_pair_chk');
    check(`${k.padEnd(18)} cannot point at ${wrong}`, r.ok, r.why);
  }
  // BOTH DIRECTIONS. A CHECK that refused everything would satisfy every clause above, and a gate
  // that only ever proves refusals cannot tell a correct constraint from a broken table.
  for (const k of E.SEQUENCE_KEYS) {
    const row = await prisma.marketingEnrolment.create({
      data: { ...ACTIVE(mk(`ok-${k}`)), sequence_key: k, subject_type: E.SUBJECT_OF[k] },
      select: { id: true },
    }).catch((e) => ({ err: String(e?.message ?? '').slice(0, 120) }));
    check(`  …and its OWN pair is accepted (${k} → ${E.SUBJECT_OF[k]})`, !('err' in row), row.err ?? row.id);
  }

  // ══ 2. ONE ENROLMENT PER SUBJECT PER SEQUENCE ════════════════════════════════════════════════
  console.log('\n— the same person cannot be sent the same five emails twice —');
  const dup = mk('dup');
  await prisma.marketingEnrolment.create({ data: ACTIVE(dup) });
  const r2 = await refused(() => prisma.marketingEnrolment.create({ data: ACTIVE(dup) }), 'MarketingEnrolment_subject_uq');
  check('a second enrolment for one subject on one sequence is refused', r2.ok, r2.why);
  const other = await prisma.marketingEnrolment.create({
    data: { ...ACTIVE(dup), sequence_key: 'affiliate_new', subject_type: 'rep' }, select: { id: true },
  }).catch((e) => ({ err: String(e?.message ?? '').slice(0, 120) }));
  check('  …but the SAME id on a DIFFERENT sequence is fine', !('err' in other),
    'uniqueness is per (sequence, type, id) — one person may legitimately be on two sequences');

  // ══ 3. A STOP SAYS WHY; AN ACTIVE ROW IS ALWAYS DUE ══════════════════════════════════════════
  console.log('\n— the state CHECK, carried over from ProspectSequence_stop_chk —');
  const s1 = await refused(() => prisma.marketingEnrolment.create({
    data: { ...ACTIVE(mk('s1')), state: 'stopped', next_due_at: null, stopped_at: new Date(), stopped_reason: null },
  }), 'MarketingEnrolment_state_chk');
  check('a stop with no reason is refused', s1.ok, s1.why);
  const s2 = await refused(() => prisma.marketingEnrolment.create({
    data: { ...ACTIVE(mk('s2')), state: 'active', next_due_at: null },
  }), 'MarketingEnrolment_state_chk');
  check('an active enrolment with no due date is refused', s2.ok, s2.why);
  const s3 = await refused(() => prisma.marketingEnrolment.create({
    data: { ...ACTIVE(mk('s3')), state: 'stopped', next_due_at: new Date(), stopped_at: new Date(), stopped_reason: 'completed' },
  }), 'MarketingEnrolment_state_chk');
  check('a stopped enrolment left DUE is refused', s3.ok, s3.why);
  const s4 = await refused(() => prisma.marketingEnrolment.create({
    data: { ...ACTIVE(mk('s4')), state: 'paused' },
  }), 'MarketingEnrolment_state_chk');
  check('a third state nobody declared is refused', s4.ok, s4.why);
  const c1 = await refused(() => prisma.marketingEnrolment.create({
    data: { ...ACTIVE(mk('c1')), consent_source: 'because_we_felt_like_it' },
  }), 'MarketingEnrolment_consent_chk');
  check('a consent source outside the four is refused', c1.ok, c1.why);

  // ══ 4. THE LEASE CANNOT OUTLAST FIVE MINUTES ═════════════════════════════════════════════════
  console.log('\n— the lease cap, which is the whole reason a gate never flips the switch —');
  const leased = await prisma.marketingEnrolment.create({ data: ACTIVE(mk('lease')), select: { id: true } });
  const now = new Date();
  const l1 = await refused(() => prisma.marketingSendingLease.create({
    data: { enrolment_id: leased.id, enabled: true, created_at: now, expires_at: new Date(now.getTime() + 6 * 60_000), created_by: RUN },
  }), 'MarketingSendingLease_short_chk');
  check('six minutes is refused', l1.ok, l1.why);
  const l2 = await prisma.marketingSendingLease.create({
    data: { enrolment_id: leased.id, enabled: true, created_at: now, expires_at: new Date(now.getTime() + 60_000), created_by: RUN },
  }).then(() => ({ ok: true, why: '' })).catch((e) => ({ ok: false, why: String(e?.message ?? '').slice(0, 120) }));
  check('  …and one minute is accepted', l2.ok, l2.why);
  await prisma.marketingEnrolment.delete({ where: { id: leased.id } });
  const gone = await prisma.marketingSendingLease.findUnique({ where: { enrolment_id: leased.id } });
  check('deleting the enrolment takes its lease with it', gone === null,
    'the one real foreign key in this slice — the subject has none by design, the lease does');

  // ══ 5. THE CLAIM REALLY SERIALISES ═══════════════════════════════════════════════════════════
  // THE ONLY CLAUSE HERE WHOSE PREMISE IS NOT OURS. The runner's safety against two overlapping
  // cron runs rests on a conditional update matching once; this asks the database rather than
  // reading the source and trusting what it assumes.
  console.log('\n— two runs over one due step claim it once —');
  const due = new Date(Date.now() - 1000);
  const race = await prisma.marketingEnrolment.create({
    data: { ...ACTIVE(mk('race')), next_due_at: due }, select: { id: true },
  });
  const claim = () => prisma.marketingEnrolment.updateMany({
    where: { id: race.id, state: 'active', next_step: 1, next_due_at: due },
    data: { next_due_at: new Date(Date.now() + 15 * 60_000) },
  });
  const [a, b] = await Promise.all([claim(), claim()]);
  check('exactly one of two simultaneous claims wins', a.count + b.count === 1, `${a.count} + ${b.count}`);
  const third = await claim();
  check('  …and a later one finds nothing to claim', third.count === 0,
    'next_due_at has moved, so the pre-state no longer matches — which is what makes the guard real');

  // ══ 6. THE COPY TABLE ════════════════════════════════════════════════════════════════════════
  console.log('\n— the copy: one row per step, and a button is both columns or neither —');
  const k1 = await refused(() => prisma.marketingCopy.create({
    data: { sequence_key: 'garage_prospect', step: 1, subject: 's', body: 'b', cta_label: 'Go', cta_url: null, updated_by: RUN },
  }), 'MarketingCopy_cta_chk');
  check('a button label with no link is refused', k1.ok, k1.why);
  const k2 = await refused(() => prisma.marketingCopy.create({
    data: { sequence_key: 'garage_prospect', step: 0, subject: 's', body: 'b', updated_by: RUN },
  }), 'MarketingCopy_step_chk');
  check('step 0 is refused', k2.ok, k2.why);
  const k3 = await refused(() => prisma.marketingCopy.create({
    data: { sequence_key: 'not_a_sequence', step: 1, subject: 's', body: 'b', updated_by: RUN },
  }), 'MarketingCopy_sequence_chk');
  check('a sequence nobody declared is refused', k3.ok, k3.why);
  const k4 = await refused(() => prisma.marketingSending.create({
    data: { sequence_key: 'not_a_sequence', enabled: false, changed_at: new Date(), changed_by: RUN },
  }), 'MarketingSending_sequence_chk');
  check('  …and so is a switch for one', k4.ok, k4.why);

  // ASSERTED, NOT INTENDED. A gate run that left a real sequence switched on would be the one
  // failure here that cannot be taken back, so the absence of a write is a clause, not a hope.
  console.log('\n— and this gate has not touched the owner\'s switches —');
  const switches = await prisma.marketingSending.findMany({ where: { changed_by: RUN } });
  check('no switch row carries this run\'s signature', switches.length === 0,
    switches.map((s) => s.sequence_key).join(', ') || 'none');
} finally {
  const del = await prisma.marketingEnrolment.deleteMany({ where: { subject_id: { startsWith: RUN } } }).catch(() => ({ count: -1 }));
  await prisma.marketingCopy.deleteMany({ where: { updated_by: RUN } }).catch(() => {});
  console.log(`\n(${del.count} fixture enrolment(s) removed under ${RUN})`);
  await prisma.$disconnect().catch(() => {});
}

const failed = out.filter((r) => r === 'F').length;
console.log(`\n${failed} failures of ${out.length}`);
process.exit(failed ? 1 : 0);
