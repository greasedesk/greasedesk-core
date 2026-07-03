// Occupancy BREAKS Stage 2 — set Great Bridge's 13:00-14:00 break + capture-first re-derive the
// bookings whose footprint now spans lunch. DRY RUN by default (prints capture + re-derive plan +
// zero-overlap assertion, writes nothing). --commit: writes capture, sets site.breaks, re-derives
// end_at in one tx, GATED on zero cross-booking overlaps. computeFootprint below MIRRORS lib/occupancy
// (cross-checked against the compiled chokepoint in the dry-run).
const os = require('os');
const path = require('path');
const fs = require('fs');
const { PrismaClient } = require('@prisma/client');

const COMMIT = process.argv.includes('--commit');
const CAPTURE_PATH = process.env.S2B_CAPTURE || path.join(os.tmpdir(), 'stage2-breaks-capture.json');
const SITE_NAME = process.env.S2B_SITE || 'Great Bridge';
const BREAKS = [{ start: 780, end: 840 }]; // 13:00-14:00
const p = new PrismaClient();

// --- mirror of lib/occupancy.ts (break-aware) ---
const MIN = 60000;
const todMin = (ms) => { const d = new Date(ms); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const dow = (ms) => new Date(ms).getUTCDay();
const midnight = (ms) => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };
const atMin = (ms, m) => midnight(ms) + m * MIN;
function dayBands(openMin, closeMin, breaks) {
  const bs = (breaks || []).filter((b) => b.end > b.start).sort((a, b) => a.start - b.start);
  const out = []; let cur = openMin;
  for (const b of bs) { const s = Math.max(openMin, Math.min(b.start, closeMin)), e = Math.max(openMin, Math.min(b.end, closeMin)); if (s > cur) out.push([cur, s]); cur = Math.max(cur, e); }
  if (cur < closeMin) out.push([cur, closeMin]);
  return out.filter(([s, e]) => e > s);
}
function advanceToWorking(ms, bands, openMin, openDays) {
  let cur = ms;
  for (let g = 0; g < 3700; g++) { if (openDays.includes(dow(cur))) { const t = todMin(cur); for (const [bs, be] of bands) if (t < be) return atMin(cur, Math.max(t, bs)); } cur = atMin(cur + 24 * 3600000, openMin); }
  throw new Error('NO_WORKING_TIME');
}
function computeFootprint(startISO, wm, oH, cH, openDays, breaks) {
  const openMin = oH * 60, closeMin = cH * 60;
  if (!openDays || !openDays.length || !(wm > 0)) return { segments: [], endISO: startISO };
  const bands = dayBands(openMin, closeMin, breaks || []);
  if (!bands.length) return { segments: [], endISO: startISO };
  const segments = []; let remaining = Math.round(wm); let cur = advanceToWorking(Date.parse(startISO), bands, openMin, openDays); let last = cur;
  while (remaining > 0) { cur = advanceToWorking(cur, bands, openMin, openDays); const t = todMin(cur); const band = bands.find(([bs, be]) => t >= bs && t < be); const bandEnd = band ? band[1] : closeMin; const take = Math.min(remaining, bandEnd - t); const segEnd = atMin(cur, t + take); segments.push({ startISO: new Date(cur).toISOString(), endISO: new Date(segEnd).toISOString() }); remaining -= take; last = segEnd; cur = segEnd; }
  return { segments, endISO: new Date(last).toISOString() };
}
const segOverlap = (a, b) => Date.parse(a.startISO) < Date.parse(b.endISO) && Date.parse(a.endISO) > Date.parse(b.startISO);
const fpClash = (a, b) => a.segments.some((sa) => b.segments.some((sb) => segOverlap(sa, sb)));

(async () => {
  const site = await p.site.findFirst({ where: { site_name: SITE_NAME }, select: { id: true, site_name: true, open_hour: true, close_hour: true, open_days: true, breaks: true } });
  if (!site) { console.error(`Site "${SITE_NAME}" not found.`); process.exit(1); }
  const oH = site.open_hour, cH = site.close_hour, openDays = site.open_days;
  console.log(`Site: ${site.site_name} open=${oH} close=${cH} days=${JSON.stringify(openDays)} current breaks=${JSON.stringify(site.breaks)}`);
  console.log(`Setting breaks -> ${JSON.stringify(BREAKS)} (13:00-14:00)\n`);

  const cards = await p.jobCard.findMany({
    where: { site_id: site.id, start_at: { not: null }, end_at: { not: null } },
    orderBy: { start_at: 'asc' },
    select: { id: true, resource_id: true, start_at: true, end_at: true, booking_duration_minutes: true, vehicle: { select: { registration: true } }, resource: { select: { name: true } } },
  });

  // ---- RE-DERIVE PLAN (with break) ----
  console.log('=== RE-DERIVE PLAN (end_at = break-aware footprint end) ===');
  const changed = [];
  for (const c of cards) {
    const wm = c.booking_duration_minutes ?? Math.round((c.end_at - c.start_at) / 60000);
    const newEnd = computeFootprint(c.start_at.toISOString(), wm, oH, cH, openDays, BREAKS).endISO;
    const moved = newEnd !== c.end_at.toISOString();
    if (moved) changed.push({ id: c.id, reg: c.vehicle?.registration, resource_id: c.resource_id, resource: c.resource?.name, start_at: c.start_at.toISOString(), oldEnd: c.end_at.toISOString(), newEnd, dur: wm });
    console.log(`  ${(c.vehicle?.registration || '?').padEnd(9)} ${c.resource?.name?.padEnd(7)} dur=${String(c.booking_duration_minutes).padStart(4)}m  ${c.end_at.toISOString().slice(0, 16)} -> ${newEnd.slice(0, 16)} ${moved ? '  <-- MOVED' : ''}`);
  }

  // ---- CAPTURE (the changed cards + the site's current breaks) ----
  const capture = {
    stamp: new Date().toISOString(), siteId: site.id, siteBreaksBefore: site.breaks ?? null,
    cards: changed.map((c) => ({ id: c.id, reg: c.reg, resource_id: c.resource_id, start_at: c.start_at, end_at: c.oldEnd, booking_duration_minutes: c.dur })),
  };
  console.log(`\n=== CAPTURE (${changed.length} moved cards + site breaks pre-state) ===`);
  for (const c of capture.cards) console.log(`  ${c.reg.padEnd(9)} lift=${c.resource_id?.slice(0, 8)} end=${c.end_at.slice(0, 16)} dur=${c.booking_duration_minutes}`);
  console.log(`  site.breaks before = ${JSON.stringify(capture.siteBreaksBefore)}`);

  // ---- ZERO-OVERLAP ASSERTION (all bookings, WITH break + re-derived ends) ----
  console.log('\n=== ZERO-OVERLAP ASSERTION (all bookings, post-break) ===');
  const post = cards.map((c) => {
    const wm = c.booking_duration_minutes ?? Math.round((c.end_at - c.start_at) / 60000);
    return { reg: c.vehicle?.registration, resource_id: c.resource_id, resource: c.resource?.name, fp: computeFootprint(c.start_at.toISOString(), wm, oH, cH, openDays, BREAKS) };
  });
  const byRes = {};
  for (const c of post) (byRes[c.resource_id] ??= []).push(c);
  let overlaps = 0;
  for (const list of Object.values(byRes)) for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) if (fpClash(list[i].fp, list[j].fp)) { overlaps++; console.log(`  OVERLAP on ${list[i].resource}: ${list[i].reg} x ${list[j].reg}`); }
  console.log(`  cross-booking footprint overlaps: ${overlaps} (expect 0)`);

  // ---- S1CNE 03/07 extension check (explicit) ----
  const s1 = post.find((c) => c.reg === 'S1CNE');
  if (s1) {
    console.log(`\n=== S1CNE extension check ===`);
    console.log(`  S1CNE (${s1.resource}) footprint: ${s1.fp.segments.map((x) => x.startISO.slice(5, 16) + '..' + x.endISO.slice(11, 16)).join('  ')}`);
    const sameLift = post.filter((c) => c.reg !== 'S1CNE' && c.resource_id === s1.resource_id);
    const clashers = sameLift.filter((c) => fpClash(s1.fp, c.fp));
    console.log(`  other bookings on ${s1.resource}: ${sameLift.map((c) => c.reg).join(', ') || '(none)'}  | S1CNE clashes: ${clashers.map((c) => c.reg).join(', ') || 'NONE ✅'}`);
  }

  if (!COMMIT) { console.log(`\nDRY RUN — no writes. Capture would go to:\n  ${CAPTURE_PATH}\nRe-run with --commit to apply.`); await p.$disconnect(); return; }
  if (overlaps > 0) { console.error('\nREFUSING to commit: post-break state has overlaps.'); process.exit(1); }

  fs.writeFileSync(CAPTURE_PATH, JSON.stringify(capture, null, 2));
  console.log(`\nCapture written: ${CAPTURE_PATH}`);
  await p.$transaction(async (tx) => {
    await tx.site.update({ where: { id: site.id }, data: { breaks: BREAKS } });
    for (const c of changed) await tx.jobCard.update({ where: { id: c.id }, data: { end_at: new Date(Date.parse(c.newEnd)) } });
  });
  console.log(`Committed: Great Bridge break set; ${changed.length} bookings re-derived.`);
  await p.$disconnect();
})().catch((e) => { console.error('STAGE2 BREAKS ERROR:', e.message); process.exit(1); });
