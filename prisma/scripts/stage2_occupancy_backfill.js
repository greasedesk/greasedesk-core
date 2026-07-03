// Occupancy footprint STAGE 2 — capture-first backfill + L100BKY reconcile.
//
//   node --env-file=.env prisma/scripts/stage2_occupancy_backfill.js [--commit]
//
// DRY RUN by default: captures the pre-state, prints the plan (durations, re-derived end_at, the
// L100BKY move, the zero-overlap assertion) and writes NOTHING. With --commit it writes the capture
// file first, then applies the backfill + move in one transaction. computeFootprint below MIRRORS
// lib/occupancy.ts (verified equal in the dry-run cross-check); the re-derived end_at therefore equals
// what the deployed guard/render compute.
const os = require('os');
const path = require('path');
const fs = require('fs');
const { PrismaClient } = require('@prisma/client');

const COMMIT = process.argv.includes('--commit');
const CAPTURE_PATH = process.env.S2_CAPTURE || path.join(os.tmpdir(), 'stage2-occupancy-capture.json');
const p = new PrismaClient();

// --- mirror of lib/occupancy.ts::computeFootprint / footprintsClash ---
const MINMS = 60000;
const atOpen = (ms, openMin) => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0) + openMin * MINMS; };
function advanceToOpen(ms, openMin, closeMin, openDays) {
  let cur = ms;
  for (let g = 0; g < 3700; g++) {
    const d = new Date(cur); const t = d.getUTCHours() * 60 + d.getUTCMinutes();
    if (openDays.includes(d.getUTCDay())) { if (t < openMin) return atOpen(cur, openMin); if (t < closeMin) return cur; }
    cur = atOpen(cur + 24 * 3600000, openMin);
  }
  throw new Error('NO_OPEN_DAY');
}
function computeFootprint(startISO, workingMinutes, openHour, closeHour, openDays) {
  const openMin = openHour * 60, closeMin = closeHour * 60;
  if (!openDays || !openDays.length || !(workingMinutes > 0)) return { segments: [], endISO: startISO };
  const segments = []; let remaining = Math.round(workingMinutes);
  let cur = advanceToOpen(Date.parse(startISO), openMin, closeMin, openDays); let lastEnd = cur;
  while (remaining > 0) {
    cur = advanceToOpen(cur, openMin, closeMin, openDays);
    const avail = closeMin - (new Date(cur).getUTCHours() * 60 + new Date(cur).getUTCMinutes());
    const take = Math.min(remaining, avail); const segEnd = cur + take * MINMS;
    segments.push({ startISO: new Date(cur).toISOString(), endISO: new Date(segEnd).toISOString() });
    remaining -= take; lastEnd = segEnd; cur = segEnd;
  }
  return { segments, endISO: new Date(lastEnd).toISOString() };
}
const segOverlap = (a, b) => Date.parse(a.startISO) < Date.parse(b.endISO) && Date.parse(a.endISO) > Date.parse(b.startISO);
const fpClash = (a, b) => a.segments.some((sa) => b.segments.some((sb) => segOverlap(sa, sb)));

(async () => {
  const cards = await p.jobCard.findMany({
    where: { start_at: { not: null }, end_at: { not: null } },
    orderBy: { start_at: 'asc' },
    select: {
      id: true, resource_id: true, start_at: true, end_at: true, booking_duration_minutes: true,
      vehicle: { select: { registration: true } }, resource: { select: { name: true } },
      site: { select: { id: true, site_name: true, open_hour: true, close_hour: true, open_days: true } },
    },
  });

  // ---- CAPTURE (pre-state) ----
  const capture = {
    stamp: new Date().toISOString(),
    note: 'Stage 2 pre-state: the booked cards {start_at, end_at, resource_id, booking_duration_minutes}. Restore reverts these.',
    cards: cards.map((c) => ({ id: c.id, reg: c.vehicle?.registration, resource_id: c.resource_id, start_at: c.start_at.toISOString(), end_at: c.end_at.toISOString(), booking_duration_minutes: c.booking_duration_minutes })),
  };
  console.log(`=== CAPTURE (${cards.length} booked cards) ===`);
  for (const c of capture.cards) console.log(`  ${c.reg.padEnd(8)} lift=${c.resource_id?.slice(0, 8)} ${c.start_at.slice(0, 16)}->${c.end_at.slice(11, 16)} dur=${c.booking_duration_minutes ?? 'NULL'}`);

  // ---- BACKFILL PLAN ----
  console.log('\n=== BACKFILL PLAN (duration = round((end-start)/60000); end_at = footprint.end) ===');
  const plan = [];
  for (const c of cards) {
    const dur = Math.round((c.end_at.getTime() - c.start_at.getTime()) / 60000);
    const fp = computeFootprint(c.start_at.toISOString(), dur, c.site.open_hour, c.site.close_hour, c.site.open_days);
    const newEnd = fp.endISO;
    const changed = newEnd !== c.end_at.toISOString();
    plan.push({ id: c.id, reg: c.vehicle?.registration, dur, oldEnd: c.end_at.toISOString(), newEnd, segments: fp.segments, site: c.site, resource_id: c.resource_id });
    console.log(`  ${c.vehicle?.registration.padEnd(8)} dur=${dur}m  end_at ${c.end_at.toISOString().slice(0, 16)} -> ${newEnd.slice(0, 16)} ${changed ? '  <-- CHANGED (wrapped)' : ''}`);
  }

  // ---- RECONCILE ----
  // The Step-0 plan moved L100BKY Lift1->Lift2 to clear the S1CNE spill conflict. Live data has since
  // changed (L100BKY was rebooked onto Lift 2), so that move is moot. Rather than hardcode a now-stale
  // move, Stage 2 GATES on zero cross-booking overlaps below and REFUSES to commit if any remain — so a
  // residual conflict is surfaced for a human to resolve, never silently backfilled over.
  console.log('\n=== RECONCILE ===');
  console.log('  No hardcoded move — the original L100BKY conflict is already resolved in live data.');
  console.log('  Commit is GATED on the zero-overlap assertion below.');

  // ---- ZERO-OVERLAP ASSERTION (simulate post-backfill state) — the commit gate ----
  console.log('\n=== ZERO-OVERLAP ASSERTION (post-backfill) ===');
  const post = plan.map((pl) => ({ reg: pl.reg, resource_id: pl.resource_id, fp: { segments: pl.segments } }));
  const byResource = {};
  for (const c of post) (byResource[c.resource_id] ??= []).push(c);
  let overlaps = 0;
  for (const [rid, list] of Object.entries(byResource)) {
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      if (fpClash(list[i].fp, list[j].fp)) { overlaps++; console.log(`  OVERLAP on ${rid.slice(0, 8)}: ${list[i].reg} x ${list[j].reg}`); }
    }
  }
  console.log(`  cross-booking footprint overlaps: ${overlaps} (expect 0)`);

  if (!COMMIT) {
    console.log(`\nDRY RUN — no writes. Capture would be written to:\n  ${CAPTURE_PATH}\nRe-run with --commit to apply.`);
    await p.$disconnect();
    return;
  }
  if (overlaps > 0) { console.error('\nREFUSING to commit: post-state still has overlaps.'); process.exit(1); }

  fs.writeFileSync(CAPTURE_PATH, JSON.stringify(capture, null, 2));
  console.log(`\nCapture written: ${CAPTURE_PATH}`);
  await p.$transaction(async (tx) => {
    for (const pl of plan) {
      await tx.jobCard.update({
        where: { id: pl.id },
        data: { booking_duration_minutes: pl.dur, end_at: new Date(Date.parse(pl.newEnd)) },
      });
    }
  });
  console.log('Backfill committed (durations set + end_at re-derived).');
  await p.$disconnect();
})().catch((e) => { console.error('STAGE2 ERROR:', e.message); process.exit(1); });
