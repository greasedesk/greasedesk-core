/**
 * File: scripts/purge-completeness-gate.mjs
 * A HARD PURGE IS OUR ERASURE MECHANISM, AND ITS TABLE LIST HAD NO MECHANISM BEHIND IT.
 *
 * lib/tenant-purge deletes innermost-first past the NoAction FKs, then sweeps six tables a cascade
 * cannot reach, then deletes the Group. Which tables are in that list has always been decided by
 * somebody remembering. On 2026-08-09 a purged tenant left a TwoFactorSecret holding a real
 * verified mobile number, and the six-table sweep exists because of it.
 *
 * It happened again, quietly, on 2026-09-07: RepVisit, RepVisitAnswer and RepLead were added with a
 * bare group_id and no FK, so `group.delete()` sails past all three exactly as it does
 * CommissionEntry — and nothing objected, because nothing was looking. This gate is the thing that
 * looks. It would have flagged all three the day they were written.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────────────────────────
 * Compute, from the schema alone, every model that still holds tenant rows after `group.delete()`:
 *   · cascade-reachable from Group          → gone, nothing to check
 *   · cascade-reachable from a model the purge deletes EXPLICITLY → gone with its parent
 *     (Account/Session off User; photos and items off JobCard — the header says so, and this is
 *      what makes those six explicit deletes count for their children too)
 *   · everything else that carries group_id or points at Group → SURVIVES
 *   · and anything hanging off a survivor survives with it — which is how the two child tables
 *     were caught, since neither carries a group_id of its own
 * Every survivor must be NAMED here, with the reason it is allowed to stay.
 *
 * ── WHAT THIS CANNOT SEE, SAID OUT LOUD ─────────────────────────────────────────────────────────
 * A table keyed by a bare `subject_id` string has no relation and no group_id, so no analysis of
 * the schema graph can find it — which is precisely how the phone number survived. Those are
 * checked BY NAME below instead. A green graph is not evidence that a subject-keyed table is
 * swept; only the named list is.
 */
import './_gate-preflight.mjs';
const { describeError } = await import('./_gate-preflight.mjs');
const { readFileSync } = await import('node:fs');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };

/**
 * ── THE ALLOW-LIST. Every entry is a decision, and carries the reason it was made. ──────────────
 * The test each one passes is the two-part test lib/tenant-purge already states for CommissionEntry:
 * it must be OUR OWN BOOKS, and it must hold NO PERSONAL DATA ABOUT THE TENANT'S PEOPLE. Both, not
 * either. A row that is only one of the two goes with the tenant.
 */
const ALLOWED = {
  CommissionEntry: 'our accounts payable — what we owe a rep for the introduction. Holds the id of a group that no longer exists, exactly as SuperAdminAudit.target_group_id does.',
  TenantAttribution: 'the same books, one table over: which rep introduced whom, and on what share.',
  RepVisit: 'the SUPPORTING DOCUMENT for those books. Once the visit gate is wired it decides £30 against £12.50 and CommissionEntry.visited freezes which branch was taken — delete the visits and every surviving entry becomes a figure nobody can defend. Its columns are our own commercial process: the rep’s party_id, the scan time, the consumed code step, and ids of rows that no longer exist.',
};

/** Keyed by a bare string, so the graph below is blind to them. Checked by name, not by analysis. */
const SUBJECT_KEYED = ['twoFactorSecret', 'deliveredCode', 'twoFactorRecoveryCode', 'verificationToken', 'authRateLimit', 'countryWaitlist'];

/** Pure, so the synthetic cases below test the real analysis rather than a copy of it. */
export function purgeSurvivors(schema, purgeSrc) {
  const models = {};
  for (const m of schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    const [name, body] = [m[1], m[2]];
    const rels = [];
    for (const r of body.matchAll(/^\s*(\w+)\s+(\w+)(\?|\[\])?\s+@relation\(([^)]*)\)/gm)) {
      if (r[3] === '[]') continue;                       // the list side holds no foreign key
      rels.push({ target: r[2], onDelete: (r[4].match(/onDelete:\s*(\w+)/) ?? [])[1] ?? 'NoAction' });
    }
    models[name] = { rels, hasGroupId: /^\s*group_id\s+String/m.test(body) };
  }
  const deletedExplicitly = (n) => new RegExp(`\\.${n[0].toLowerCase()}${n.slice(1)}\\.(deleteMany|delete)\\(`).test(purgeSrc);

  // GONE: cascaded from Group, or from anything the purge deletes by hand.
  const gone = new Set(['Group', ...Object.keys(models).filter(deletedExplicitly)]);
  for (let moved = true; moved;) {
    moved = false;
    for (const [n, m] of Object.entries(models)) {
      if (gone.has(n)) continue;
      if (m.rels.some((r) => gone.has(r.target) && r.onDelete === 'Cascade')) { gone.add(n); moved = true; }
    }
  }
  // SURVIVES: touches a tenant and was not taken by any of that.
  const touches = (n) => models[n].hasGroupId || models[n].rels.some((r) => r.target === 'Group');
  const survives = new Set(Object.keys(models).filter((n) => !gone.has(n) && touches(n)));
  // …and so does anything hanging off a survivor, group_id of its own or not.
  for (let moved = true; moved;) {
    moved = false;
    for (const [n, m] of Object.entries(models)) {
      if (gone.has(n) || survives.has(n)) continue;
      if (m.rels.some((r) => survives.has(r.target))) { survives.add(n); moved = true; }
    }
  }
  return [...survives].sort();
}

try {
  const schema = readFileSync('prisma/schema.prisma', 'utf8');
  const purge = readFileSync('lib/tenant-purge.ts', 'utf8');

  // ── 1. THE ANALYSIS BITES ────────────────────────────────────────────────────────────────────
  // Proven on synthetic schemas, because a sweep that finds nothing is indistinguishable from an
  // analysis that cannot find anything.
  console.log('\n— proven on synthetic schemas —');
  const BARE = 'model Group {\n  id String @id\n}\nmodel Thing {\n  id String @id\n  group_id String\n}\n';
  check('a bare group_id with no FK is a SURVIVOR', purgeSurvivors(BARE, '').includes('Thing'),
    'exactly the shape RepVisit, CommissionEntry and TenantAttribution have');
  const CASC = 'model Group {\n  id String @id\n}\nmodel Thing {\n  id String @id\n  group_id String\n  group Group @relation(fields: [group_id], references: [id], onDelete: Cascade)\n}\n';
  check('  …and a cascading one is not', !purgeSurvivors(CASC, '').includes('Thing'));
  const SETNULL = CASC.replace('onDelete: Cascade', 'onDelete: SetNull');
  check('  …while SetNull SURVIVES, holding a nulled group_id', purgeSurvivors(SETNULL, '').includes('Thing'),
    'the CountryWaitlist trap — the row outlives the tenant with its email intact');
  check('  …unless the purge deletes it by hand', !purgeSurvivors(SETNULL, 'await tx.thing.deleteMany({ where: {} });').includes('Thing'));
  const CHILD = BARE + 'model Kid {\n  id String @id\n  thing_id String\n  thing Thing @relation(fields: [thing_id], references: [id], onDelete: Cascade)\n}\n';
  check('a child of a survivor survives too', purgeSurvivors(CHILD, '').includes('Kid'),
    'it carries no group_id of its own — which is how RepVisitAnswer and RepLead were caught');
  check('  …and goes when its parent is swept', !purgeSurvivors(CHILD, 'await tx.thing.deleteMany({ where: {} });').includes('Kid'),
    'the rule that lets User take Account and Session, and JobCard take its photos');

  // ── 2. THE REAL SCHEMA ───────────────────────────────────────────────────────────────────────
  console.log('\n— and no survivor is unaccounted for —');
  const survivors = purgeSurvivors(schema, purge);
  const unnamed = survivors.filter((s) => !(s in ALLOWED));
  check('every model that outlives a purge is a named decision', unnamed.length === 0,
    unnamed.length ? unnamed.join(', ') : `${survivors.length} survivors, all named`);
  check('  …and every name is still a survivor', Object.keys(ALLOWED).every((a) => survivors.includes(a)),
    Object.keys(ALLOWED).filter((a) => !survivors.includes(a)).join(', ') || 'no stale entries');
  check('  …each with the reason it was allowed to stay',
    Object.values(ALLOWED).every((r) => r.length > 60), 'a name with no argument is a name somebody will delete');
  check('the two-part test is stated where the decision lives',
    /no personal data about the tenant's people/.test(purge) && /must not erase our books/.test(purge),
    'both halves, because a row that is only one of the two goes with the tenant');
  // ANCHORED ON THE SENTENCE, NOT THE IDENTIFIER. A bare /RepVisit/ matches "RepVisitAnswer" in the
  // same header — so the check would have passed on the two tables that DO go with the tenant while
  // proving nothing about the one that stays. gate-hygiene Rule F caught it; the collision was real.
  check('  …and RepVisit’s decision is written out beside CommissionEntry’s',
    /RepVisit STAYS, on the same two-part test/.test(purge),
    'the header’s own convention: named so nobody later reads the sweep, notices the gap and “fixes” it');
  check('  …and the two that do NOT stay say why', /ITS ANSWERS DO NOT/.test(purge),
    'the split is the two-part test doing its job, and the next reader needs the argument, not the outcome');

  // ── 3. WHAT THE GRAPH CANNOT SEE ─────────────────────────────────────────────────────────────
  console.log('\n— the subject-keyed six, checked by name because nothing can find them —');
  for (const t of SUBJECT_KEYED) {
    check(`${t} is still swept`, new RegExp(`\\.${t}\\.deleteMany\\(`).test(purge),
      'no group_id and no relation — a schema analysis is blind to it, which is how a real mobile number survived a purge');
  }
  check('  …and the blindness is admitted in this file', /no analysis of the schema graph can find it/.test(readFileSync('scripts/purge-completeness-gate.mjs', 'utf8')),
    'a green graph is not evidence that a subject-keyed table is swept');

  // ── 4. THE AFTER-COUNT MUST COVER WHAT THE SWEEP CLAIMS ──────────────────────────────────────
  // A purge that deletes a table but never counts it reports a clean run it did not verify.
  console.log('\n— and the after-count covers every explicit delete —');
  const deleted = [...purge.matchAll(/\btx\.(\w+)\.deleteMany\(/g)].map((m) => m[1]);
  const counted = [...purge.matchAll(/\bprisma\.(\w+)\.count\(/g)].map((m) => m[1]);
  const uncounted = [...new Set(deleted)].filter((d) => !counted.includes(d));
  check('every swept table is also counted', uncounted.length === 0, uncounted.join(', ') || `${new Set(deleted).size} swept, all counted`);
} catch (e) {
  check('gate run completed', false, describeError(e).slice(0, 300));
}

console.log(`\n${out.filter((x) => x === 'F').length} failures of ${out.length}`);
process.exit(out.includes('F') ? 1 : 0);
