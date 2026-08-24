// @gate-timeout: 120
/**
 * File: scripts/mot-sweep-stamp-gate.mjs
 * A CONFIRMED DATE IS A VERIFICATION — what the sweep records when nothing moved.
 *
 * The backfill sweep wrote only what CHANGED. Run against TMBS on 19 Aug 2026 it refreshed the
 * fleet and left 210 of 214 stored expiries reading as never verified, because for 225 of 227 cars
 * DVSA confirmed exactly what we already held and an empty write stored nothing. The dates were
 * correct; the database could not say so. That is the shape worth gating: the common case is the
 * one that was being dropped.
 *
 * ── WHAT THIS GATE REACHES, AND WHAT IT DOES NOT ────────────────────────────────────────────────
 * It exercises the DECISION (lib/dvsa::motVerifiedWrite) directly and pins the sweep to it by
 * source. It does NOT drive scripts/dvsa-backfill.mjs end to end, because that script calls DVSA
 * directly and has no injection seam — and no gate touches live DVSA. So the source checks below
 * are load-bearing, not decoration: they are the only thing tying the proven rule to the writer,
 * and they must fail if the script grows a second update that bypasses it.
 *
 * No fixtures, no tenant writes — the rule is pure, which is why it can be proven at all.
 */
import './_gate-preflight.mjs';
import './_ts.mjs';
const { readFileSync } = await import('node:fs');
const { motVerifiedWrite } = await import('../lib/dvsa.ts');

const out = [];
const check = (n, ok, d = '') => { out.push(ok ? 'P' : 'F'); console.log(`${ok ? '✓' : '✗'} ${n}${d ? `  — ${d}` : ''}`); };
const AT = new Date('2026-08-24T11:00:00.000Z');
const held = { mot_expiry: new Date('2026-09-20T00:00:00.000Z'), last_mot_mileage: 61000, last_mot_date: new Date('2025-09-19T00:00:00.000Z') };

try {
  // ── 1. DVSA CONFIRMS WHAT WE HOLD — NOTHING MOVES, AND THAT IS STILL A CHECK ─────────────────
  const same = motVerifiedWrite(held, { motExpiry: '2026-09-20', lastMotMileage: 61000, lastMotDate: '2025-09-19' }, AT);
  check('a confirmed-unchanged date still stamps', same?.mot_checked_at?.getTime() === AT.getTime(), JSON.stringify(same));
  check('and moves nothing while doing it', same != null && Object.keys(same).length === 1,
    `wrote ${Object.keys(same ?? {}).filter((k) => k !== 'mot_checked_at').join(', ') || 'only the stamp'}`);

  // ── 2. DVSA HAS NO RECORD — THE DISCRIMINATING HALF ──────────────────────────────────────────
  // Without this the check above passes against a writer that stamps unconditionally, which would
  // put a verification mark on the five TMBS cars DVSA 404s and cannot confirm at all.
  check('a miss records NOTHING — null, not an empty update', motVerifiedWrite(held, null, AT) === null,
    'a 404, a 403, a 429, a timeout and an unconfigured credential all arrive here as null');

  // ── 3. A REAL MOVE STILL MOVES, AND STAMPS ───────────────────────────────────────────────────
  const moved = motVerifiedWrite(held, { motExpiry: '2027-09-20', lastMotMileage: 68120, lastMotDate: '2026-09-19' }, AT);
  check('a moved expiry is written', moved?.mot_expiry?.toISOString().slice(0, 10) === '2027-09-20', JSON.stringify(moved));
  check('with the mileage and test date beside it', moved?.last_mot_mileage === 68120
    && moved?.last_mot_date?.toISOString().slice(0, 10) === '2026-09-19');
  check('and stamped', moved?.mot_checked_at?.getTime() === AT.getTime());

  // ── 4. AN ANSWER WITH NO MOT IS NOT AN ERASURE ───────────────────────────────────────────────
  // A 200 carrying no tests is NOT null and must not reach motFieldsToWrite as a reason to blank.
  const empty = motVerifiedWrite(held, {}, AT);
  check('a 200 with no test history erases nothing', empty != null && Object.keys(empty).length === 1,
    `${JSON.stringify(empty)} — an answered lookup, so it stamps, but it learned no dates`);

  // ── 5. THE SWEEP IS TIED TO THIS RULE ────────────────────────────────────────────────────────
  // @scan-ok: matching an import line and a call site, not a bare identifier in prose.
  const sweep = readFileSync('scripts/dvsa-backfill.mjs', 'utf8');
  check('the sweep imports the rule', /motVerifiedWrite/.test(sweep.match(/const \{[^}]*\} = await import\('\.\.\/lib\/dvsa\.ts'\);/g)?.join('\n') ?? ''),
    'imported from the chokepoint, not reimplemented');
  const updates = [...sweep.matchAll(/\b(?:tx|prisma)\.vehicle\.update\(/g)].length;
  check('the sweep has exactly ONE vehicle update', updates === 1, `${updates} found — a second one is a path that can bypass the stamp`);
  check('and it writes the rule\'s result, not motFieldsToWrite\'s', /data: verified/.test(sweep.replace(/\s+/g, ' ')),
    'the stamp cannot be reached by spreading motFieldsToWrite at the call site');

  // ── 6. THE STAMP AND THE ROW THAT EXPLAINS IT LAND TOGETHER ──────────────────────────────────
  // A stamp with no audit row is exactly the state this change removes; a write that succeeded
  // beside an audit that failed would recreate it one car at a time, invisibly.
  const flat = sweep.replace(/\s+/g, ' ');
  check('the sweep writes an audit row', /writeAudit\(tx, \{/.test(flat), 'per vehicle, on the transaction client');
  check('inside the SAME transaction as the update',
    /prisma\.\$transaction\(async \(tx\) => \{ await tx\.vehicle\.update\([^;]*; await writeAudit\(tx, \{/.test(flat),
    'update then audit, one transaction — not two independent writes');
  check('under its own action, not the button\'s', /action: 'vehicle\.mot_swept'/.test(flat)
    && !/action: 'vehicle\.mot_refresh'/.test(flat), 'vehicle.mot_refresh means a human pressed something');
  check('and it states BOTH moved and verified', /moved: movedFields\.length > 0/.test(flat) && /verified: true/.test(flat),
    'an empty `fields` with no `verified` reads as a failed write, not a confirmation');
} catch (e) {
  console.log(`\n✗ THREW: ${String(e?.stack ?? e).slice(0, 600)}`);
  out.push('F');
}
const f = out.filter((x) => x === 'F').length;
console.log(`\n${f} failures of ${out.length}`);
process.exit(f ? 1 : 0);
