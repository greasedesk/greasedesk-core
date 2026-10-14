/**
 * WHAT IS ACTUALLY THERE, before building structured advisories.
 *
 * Three questions, asked of the real tenant and attributed per group so a demo row never counts
 * as evidence: how many cards carry advisories, whether a past advisory has a recoverable
 * odometer reading, and how often intake is skipped.
 *
 * Writes nothing. Not a gate — a reporting script.
 */
import './_ts.mjs';
const { prisma } = await import('@/lib/db');
const q = (s, ...p) => prisma.$queryRawUnsafe(s, ...p);
const TMBS = '854d38e7-6dd4-4836-af61-a0d169639a78';
const n = (v) => Number(v ?? 0);
const table = (rows) => rows.forEach((r) => console.log('   ', Object.entries(r).map(([k, v]) => `${k}=${v}`).join('  ')));

const groups = await q(`SELECT id, group_name AS name, is_demo, is_internal FROM "Group" ORDER BY group_name`);
const label = new Map(groups.map((g) => [g.id, `${g.name}${g.is_demo ? ' [demo]' : ''}${g.is_internal ? ' [internal]' : ''}`]));

console.log('\n═══ 1. ADVISORY INVENTORY, by tenant ═══');
table(await q(`
  SELECT group_id, COUNT(*)::int AS items,
         COUNT(DISTINCT vehicle_id)::int AS cars,
         COUNT(DISTINCT found_on_job_card_id)::int AS cards,
         SUM(CASE WHEN observation_key IS NULL THEN 1 ELSE 0 END)::int AS hand_typed,
         SUM(CASE WHEN closed_at IS NULL THEN 1 ELSE 0 END)::int AS still_open
  FROM "VehicleDueItem" GROUP BY group_id ORDER BY 2 DESC`).then((rs) => rs.map((r) => ({ tenant: label.get(r.group_id) ?? r.group_id, ...r, group_id: undefined }))));

console.log('\n─── TMBS: basis and timing ───');
table(await q(`
  SELECT due_basis::text AS basis,
         COUNT(*)::int AS items,
         SUM(CASE WHEN due_mileage IS NOT NULL THEN 1 ELSE 0 END)::int AS has_mileage,
         SUM(CASE WHEN due_date   IS NOT NULL THEN 1 ELSE 0 END)::int AS has_date,
         SUM(CASE WHEN timing_in_description THEN 1 ELSE 0 END)::int AS timing_in_text
  FROM "VehicleDueItem" WHERE group_id = $1 GROUP BY 1 ORDER BY 2 DESC`, TMBS));

console.log('\n─── TMBS: customer response ───');
table(await q(`SELECT customer_response::text AS response, COUNT(*)::int AS items
               FROM "VehicleDueItem" WHERE group_id = $1 GROUP BY 1 ORDER BY 2 DESC`, TMBS));

console.log('\n─── TMBS: cards carrying advisories, against all cards ───');
table(await q(`
  SELECT (SELECT COUNT(*)::int FROM "JobCard" WHERE group_id = $1) AS all_cards,
         (SELECT COUNT(DISTINCT found_on_job_card_id)::int FROM "VehicleDueItem"
            WHERE group_id = $1 AND found_on_job_card_id IS NOT NULL) AS cards_with_advisory,
         (SELECT COUNT(*)::int FROM "VehicleDueItem" WHERE group_id = $1 AND found_on_job_card_id IS NULL) AS orphan_items`, TMBS));

console.log('\n═══ 2. RECOVERABLE ODOMETER at the finding ═══');
table(await q(`
  SELECT COUNT(*)::int AS items_on_a_card,
         SUM(CASE WHEN c.odometer_in  IS NOT NULL THEN 1 ELSE 0 END)::int AS card_odo_in,
         SUM(CASE WHEN c.odometer_out IS NOT NULL THEN 1 ELSE 0 END)::int AS card_odo_out,
         SUM(CASE WHEN c.odometer_in IS NULL AND v.mileage_at_create IS NOT NULL THEN 1 ELSE 0 END)::int AS only_create_mileage,
         SUM(CASE WHEN c.odometer_in IS NULL AND v.mileage_at_create IS NULL THEN 1 ELSE 0 END)::int AS nothing_on_the_card
  FROM "VehicleDueItem" d
  JOIN "JobCard" c ON c.id = d.found_on_job_card_id
  JOIN "Vehicle" v ON v.id = d.vehicle_id
  WHERE d.group_id = $1`, TMBS));

console.log('\n─── a stored reading within 90 days either side of the finding ───');
table(await q(`
  SELECT COUNT(*)::int AS items,
         SUM(CASE WHEN r.near IS NOT NULL THEN 1 ELSE 0 END)::int AS has_nearby_reading,
         SUM(CASE WHEN r.near IS NULL THEN 1 ELSE 0 END)::int AS no_nearby_reading
  FROM "VehicleDueItem" d
  LEFT JOIN LATERAL (
    SELECT 1 AS near FROM "VehicleOdometerReading" o
    WHERE o.vehicle_id = d.vehicle_id
      AND o.reading_date BETWEEN (d.created_at - interval '90 days')::date AND (d.created_at + interval '90 days')::date
    LIMIT 1) r ON TRUE
  WHERE d.group_id = $1`, TMBS));

console.log('\n─── the MONTHLY RATE input: readings per advisory-carrying car ───');
table(await q(`
  SELECT buckets.readings AS readings_held, COUNT(*)::int AS cars, SUM(span_ok)::int AS cars_spanning_90d
  FROM (
    SELECT v.id,
           LEAST(COUNT(o.id), 5)::int AS readings,
           CASE WHEN MAX(o.reading_date) - MIN(o.reading_date) >= 90 THEN 1 ELSE 0 END AS span_ok
    FROM "Vehicle" v
    JOIN "VehicleDueItem" d ON d.vehicle_id = v.id AND d.group_id = $1
    LEFT JOIN "VehicleOdometerReading" o ON o.vehicle_id = v.id
    GROUP BY v.id) buckets
  GROUP BY 1 ORDER BY 1`, TMBS));

console.log('\n─── reading sources held, TMBS cars overall ───');
table(await q(`SELECT source, COUNT(*)::int AS readings, COUNT(DISTINCT vehicle_id)::int AS cars
               FROM "VehicleOdometerReading" WHERE group_id = $1 GROUP BY 1 ORDER BY 2 DESC`, TMBS));

console.log('\n═══ 3. HOW OFTEN INTAKE IS SKIPPED (TMBS) ═══');
table(await q(`
  SELECT date_trunc('month', created_at)::date AS month,
         COUNT(*)::int AS cards,
         SUM(CASE WHEN odometer_in IS NULL THEN 1 ELSE 0 END)::int AS no_odo_in,
         ROUND(100.0 * SUM(CASE WHEN odometer_in IS NULL THEN 1 ELSE 0 END) / COUNT(*))::int AS pct_skipped
  FROM "JobCard" WHERE group_id = $1 AND created_at > now() - interval '12 months'
  GROUP BY 1 ORDER BY 1`, TMBS));

console.log('\n─── invoices: is the odometer frozen at issue already? ───');
table(await q(`
  SELECT COUNT(*)::int AS invoices,
         SUM(CASE WHEN vehicle_mileage_snapshot IS NOT NULL THEN 1 ELSE 0 END)::int AS carry_mileage
  FROM "Invoice" WHERE group_id = $1`, TMBS));

console.log('\n═══ 4. DueItemLine: dead or unwritten? ═══');
table(await q(`SELECT COUNT(*)::int AS rows_all_tenants FROM "DueItemLine"`));

await prisma.$disconnect();
