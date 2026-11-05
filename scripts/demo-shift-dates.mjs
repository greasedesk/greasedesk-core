/**
 * File: scripts/demo-shift-dates.mjs
 *
 * MOVE ONE DEMO TENANT'S DATED ROWS FORWARD, so a demo shows a garage working this week.
 *
 *   node scripts/demo-shift-dates.mjs --yes-production --allow-reference-demo           # DRY RUN
 *   node scripts/demo-shift-dates.mjs --yes-production --allow-reference-demo --write   # the write
 *
 * ── WHO SAYS THIS TENANT MAY BE WRITTEN TO ──────────────────────────────────────────────────────
 * Not this file. The first version of this script carried a hardcoded tenant id and four facts
 * about the row, and never asked lib/demo-tenants — so the convention that every writer of a demo
 * tenant routes through `refuseDemoMaintenance` was bypassed, by the one script that needed it
 * most, and nobody found out until afterwards. A private exemption that happens to be correct is
 * still a script nobody can audit from the outside.
 *
 * So the decision belongs to the predicate, and this file reports facts to it: it is run by an
 * operator, the override flag was passed, the ref was typed back. The predicate is asked TWICE —
 * once before anything is read, and again after the typed confirmation and before the transaction
 * — the same shape demo-refresh uses for its activity check, and for the same reason: the first
 * call must refuse early, and the second must be about the state at the moment of the write.
 *
 * The four facts STAY. They answer a different question — "is this the tenant I was written for"
 * — and only one of the two is the predicate's. The id is no longer the authority, though: the row
 * is fetched by REF and the id is cross-checked against the literal, so a tenant that has been
 * replaced goes red instead of the literal silently winning.
 *
 * ── WHY TWO OFFSETS AND NOT ONE ─────────────────────────────────────────────────────────────────
 * The tenant's dates answer to two different calendars and one offset cannot satisfy both.
 *
 * Operational rows are WEEKDAY-anchored: a booking on a Tuesday at 10:00 has to stay on a Tuesday
 * at 10:00, or the diary stops looking like a working week. That needs a whole number of weeks.
 *
 * Cost rows are MONTH-anchored: every CostInstance period starts on the 1st, and a monthly cost
 * register whose periods begin on the 26th is not a register anybody would recognise. Measured
 * before this script was written: all 162 period_start values sit on the 1st, and after a 56-day
 * shift ZERO of them would. That needs whole calendar months.
 *
 * Service-schedule due dates are month-anchored too, for a third reason: a date leg on a schedule
 * row IS a month (lib/service-schedule::SCHEDULE_DATE_IS_MONTH) stored on the 1st, so a day shift
 * would move "due November" to "due 26 November" — a day nobody chose, printed on a frozen invoice
 * as though somebody had.
 *
 * So there are two offsets, declared separately, and the dry run proves each one keeps its own
 * invariant. A single offset would have quietly broken whichever category it was not chosen for.
 *
 * ── AND THE INVARIANT HAS TO EXIST, NOT JUST THE OFFSET ─────────────────────────────────────────
 * Both month-anchored invariants below were added on 2026-11-05, after the reporting anchor was
 * found sitting on 26 October at 13:58:49 on the gate database. The column was ALREADY in the
 * monthly bucket and the shift was already correct — +2 months preserves a day-of-month — which is
 * exactly why nothing caught it: a correct shift of an incorrect value is still incorrect, and
 * looks untouched. The offset decides what moves; only an invariant decides what is allowed to be
 * there in the first place.
 *
 * ── WHAT IS DELIBERATELY NOT MOVED ──────────────────────────────────────────────────────────────
 * `created_at` everywhere. In this tenant it is GENERATION metadata, not story: Invoice.created_at
 * spans 2026-08-10→09-07 while issued_at spans thirteen months. Moving it would date row creation
 * in the future and break created_at <= issued_at. The two biggest tables (JobCardItem 3,587 and
 * InvoiceLine 2,169) hold nothing BUT created_at, so they are untouched on purpose, not by omission.
 *
 * `AuditLog`. 860 of its 884 diff_json payloads carry an embedded yyyy-mm-dd that no column update
 * can reach, so shifting the column would leave the trail disagreeing with the rows it describes.
 * Append-only besides.
 *
 * `PublicHoliday`. Those are real-world calendar facts; +56 days puts Christmas Eve on 18 February.
 * They want regenerating, never shifting.
 *
 * `CustomerMagicLink.expires_at` and `User.last_login_at` / `sessions_valid_from`. A magic link IS
 * the credential; moving its expiry forward revives a dead one. last_login_at is a live session fact.
 *
 * `Vehicle.mot_checked_at`. That column means DVSA ANSWERED. Moving it forward would claim a
 * verification that has not happened. Leaving it behind the shifted mot_expiry reads correctly:
 * checked in September, expires next spring.
 *
 * `CostPerson.start_date`. Employment facts. Capacity reads employedDuring, which still holds when
 * the work moves forward and the hire date does not.
 *
 * ── RAW SQL, NOT PRISMA ─────────────────────────────────────────────────────────────────────────
 * Two reasons. `@updatedAt` columns (MessageThread.updated_at among the tables here) are stamped
 * now() by Prisma on ANY update, whatever is passed — raw SQL leaves them alone. And the arithmetic
 * belongs to Postgres: the dry run's projected values are computed by the same expression the write
 * uses, in the database, rather than recomputed in JavaScript where it could agree with itself and
 * be wrong in both places.
 */
import './_ts.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';

const ROOT = '/Users/hugh/Developer/greasedesk-core';
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const WRITE = has('--write');
// THE OVERRIDE. This script's only target IS the frozen reference demo, so without this flag it
// does nothing at all — which is the point: the exemption is now stated on the command line
// rather than built into the file.
const ALLOW_REFERENCE = has('--allow-reference-demo');

// ── THE ONLY TENANT THIS SCRIPT MAY TOUCH ───────────────────────────────────────────────────────
// Hard-coded, and then checked against four independent facts about the row. An id alone could be
// a tenant that has since been re-used; the ref, the name, is_demo and is_internal together cannot
// all be true of a real garage. See lib/tenant-manifest for why the table list is derived and not
// written out here.
const TENANT_ID = '70b802d9-ed8d-41c1-b16c-55baf052a8ea';
const TENANT_REF = 'GB-GD2236';
const TENANT_NAME = 'Marketbridge';

const OPERATIONAL = "INTERVAL '56 days'";   // 8 weeks — weekday-preserving
const MONTHLY = "INTERVAL '2 months'";      // whole months — 1st-of-month preserving

// A tenant argument is allowed only if it names the one permitted tenant. Passing another is a
// REFUSAL and not a silent fallback to the default, because "it ran and did something" is the
// outcome to prevent.
const asked = (argv.find((a) => a.startsWith('--tenant=')) ?? '').split('=')[1];
if (asked && asked !== TENANT_ID) {
  console.error(`\n  REFUSED: this script only ever touches ${TENANT_REF} (${TENANT_ID}).`);
  console.error(`  You named ${asked}. NOTHING HAS BEEN READ OR WRITTEN.\n`);
  process.exit(2);
}

if (!has('--yes-production')) {
  console.error('\n  This tenant lives on production. Re-run with --yes-production.');
  console.error('  Dry run is the default; add --write to commit the shift.\n');
  process.exit(2);
}

// Production URLs have one home — the same file migrate-apply, encrypt-rep-bank and
// publish-affiliate-terms read. Set BEFORE the client is imported.
const target = `${ROOT}/.migrate-target.production`;
if (!existsSync(target)) {
  console.error(`\n  --yes-production needs ${target}. NOTHING HAS BEEN READ.\n`);
  process.exit(2);
}
for (const line of readFileSync(target, 'utf8').split('\n')) {
  const m = line.match(/^\s*(DATABASE_URL|DIRECT_URL)\s*=\s*(.*)$/);
  if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}

const { PrismaClient } = await import(`${ROOT}/node_modules/@prisma/client/index.js`);
const prisma = new PrismaClient();
// The shared predicate — a pure leaf (lib/demo-tenants imports nothing), so asking it costs no
// client, no pool and no connection. Dynamic, because a static .ts import links before _ts.mjs
// has registered the `@/` resolver (gate-hygiene-gate rule A).
const { refuseDemoMaintenance } = await import('../lib/demo-tenants.ts');

const die = async (msg, code = 2) => {
  console.error(`\n  ${msg}\n`);
  await prisma.$disconnect();
  process.exit(code);
};

// ── WHERE ARE WE, AND IS IT THE RIGHT TENANT ────────────────────────────────────────────────────
const endpoint = new URL(process.env.DATABASE_URL).host.split('.')[0];
const env = await prisma.environment.findFirst({ select: { kind: true, label: true } });
console.log(`\n  endpoint          ${endpoint}`);
console.log(`  Environment       ${env?.kind ?? '(none)'}${env?.label ? ` (${env.label})` : ''}`);
if (env?.kind !== 'production') await die(`REFUSED: --yes-production but the Environment marker says "${env?.kind}".`);

// BY REF, and the id becomes a CROSS-CHECK rather than the authority. A ref is what survives a
// tenant being replaced; an id is not, and a script whose only handle on its target is an id goes
// quietly wrong the first time that happens. Both still have to agree.
const g = await prisma.group.findUnique({
  where: { ref: TENANT_REF },
  select: { id: true, ref: true, group_name: true, is_demo: true, is_internal: true, status: true },
});
if (!g) await die(`REFUSED: no tenant with ref ${TENANT_REF} on this database.`);
const why = [];
if (g.id !== TENANT_ID) why.push(`id is "${g.id}", expected "${TENANT_ID}" — the tenant may have been replaced`);
if (!g.group_name.includes(TENANT_NAME)) why.push(`name "${g.group_name}" does not contain "${TENANT_NAME}"`);
if (g.is_demo !== true) why.push('is_demo is not true');
if (g.is_internal !== true) why.push('is_internal is not true');
if (why.length) await die(`REFUSED: ${TENANT_REF} is not the demo tenant this script is for.\n  ${why.join('\n  ')}`);
console.log(`  tenant            ${g.ref} ${g.group_name} — is_demo ${g.is_demo}, is_internal ${g.is_internal}`);

// ── MAY THIS CALLER WRITE HERE? ASKED BEFORE A SINGLE ROW IS READ ───────────────────────────────
// write:false, so the dry run needs no typed confirmation — but the flag and the declared target
// are required even to look. The second call, after the prompt, is the one that authorises rows.
const firstLook = refuseDemoMaintenance(g.ref, g, {
  actor: 'operator',
  write: false,
  override: { flagged: ALLOW_REFERENCE, confirmed: false },
});
if (firstLook) await die(`REFUSED (${firstLook.code}): ${firstLook.message}`);
console.log(`  authorised by     lib/demo-tenants::refuseDemoMaintenance — operator + --allow-reference-demo`);
console.log(`  operational shift ${OPERATIONAL}`);
console.log(`  monthly shift     ${MONTHLY}`);
console.log(`  mode              ${WRITE ? 'WRITE' : 'DRY RUN (reads only)'}`);

// ── HAS THIS ALREADY BEEN RUN? ──────────────────────────────────────────────────────────────────
// There is no marker to read, so the guard is the data's own shape: this shift is chosen to land
// the last invoice on today, so a last invoice already at or past today means it has been applied.
// Without this a second run moves everything another eight weeks into the future, and the second
// run looks exactly as successful as the first.
const latest = await prisma.invoice.aggregate({ where: { group_id: TENANT_ID }, _max: { issued_at: true } });
const lastIssued = latest._max.issued_at;
if (lastIssued && lastIssued.getTime() > Date.now() - 7 * 86400000 && !has('--again')) {
  await die(`REFUSED: the last invoice is already dated ${lastIssued.toISOString().slice(0, 10)}, which is\n`
    + '  today or later — this shift looks as though it has already been applied. A second run would\n'
    + '  move everything another eight weeks forward. Pass --again only if you mean to shift twice.');
}

// ── THE PLAN ────────────────────────────────────────────────────────────────────────────────────
// scope: how a row is tied to the tenant. 'group'/'self' are direct; the others join through the
// parent the manifest names, so a table with no group_id is still scoped and never shifted wholesale.
const SCOPE = {
  self: '"id" = $1',
  group: '"group_id" = $1',
  vehicle: '"vehicle_id" IN (SELECT "id" FROM "Vehicle" WHERE "group_id" = $1)',
  cost: '"cost_id" IN (SELECT "id" FROM "Cost" WHERE "group_id" = $1)',
};

const PLAN = [
  // ── operational: weekday-anchored ──
  { t: 'JobCard', scope: 'group', iv: OPERATIONAL, cast: 'ts',
    cols: ['start_at', 'end_at', 'accepted_at', 'completed_at', 'archived_at', 'signed_off_at',
           'no_charge_at', 'diag_scan_at', 'held_since', 'intake_nothing_found_at', 'quote_preview_at'] },
  { t: 'JobCard', scope: 'group', iv: OPERATIONAL, cast: 'date', cols: ['scheduled_date'] },
  { t: 'Invoice', scope: 'group', iv: OPERATIONAL, cast: 'ts',
    cols: ['issued_at', 'date_issued', 'due_date', 'paid_at', 'date_paid', 'confirm_due_at', 'receipt_sent_at', 'voided_at'] },
  { t: 'QuoteVersion', scope: 'group', iv: OPERATIONAL, cast: 'ts', cols: ['sent_at', 'responded_at'] },
  { t: 'VehicleOwnership', scope: 'vehicle', iv: OPERATIONAL, cast: 'ts', cols: ['valid_from', 'valid_to'] },
  { t: 'LeaveRecord', scope: 'group', iv: OPERATIONAL, cast: 'ts', cols: ['date'] },
  { t: 'TyreReading', scope: 'group', iv: OPERATIONAL, cast: 'ts', cols: ['measured_at'] },
  { t: 'MessageThread', scope: 'group', iv: OPERATIONAL, cast: 'ts', cols: ['last_message_at'] },
  { t: 'VehicleOdometerReading', scope: 'group', iv: OPERATIONAL, cast: 'date', cols: ['reading_date'] },
  // The car's MOT dates move with the work. mot_checked_at deliberately does not — see the header.
  { t: 'Vehicle', scope: 'group', iv: OPERATIONAL, cast: 'date', cols: ['mot_expiry', 'last_mot_date'] },
  // ── month-anchored ──
  { t: 'CostInstance', scope: 'cost', iv: MONTHLY, cast: 'ts', cols: ['period_start', 'period_end', 'due_on'] },
  { t: 'Cost', scope: 'group', iv: MONTHLY, cast: 'ts', cols: ['active_from', 'active_to'] },
  { t: 'CostRate', scope: 'cost', iv: MONTHLY, cast: 'ts', cols: ['effective_from'] },
  { t: 'Group', scope: 'self', iv: MONTHLY, cast: 'ts', cols: ['reporting_start_date'] },
  /**
   * A DUE DATE IS A CALENDAR COMMITMENT, NOT A BOOKING, so it answers to the month calendar.
   *
   * It was missing from this plan altogether until 2026-11-05 — not mis-shifted, OMITTED. The
   * consequence was quiet: the work moved eight weeks forward and the cars’ due items stayed where
   * they were, so a demo’s "brake fluid due next month" drifted into being overdue with nothing in
   * the dry run mentioning it.
   *
   * WHOLE MONTHS, which does both halves at once. A month-precision row is stored at midnight on
   * STORED_DAY_OF_MONTH (the 1st) and a whole-month shift leaves it there; a day-precision row is a
   * real date a garage chose and keeps its day-of-month. +56 days would have moved the
   * month-precision rows off the 1st, which is the thing lib/service-schedule exists to prevent.
   *
   * NO TWO-PASS NEEDED, and that is ASKED rather than assumed: the partial unique index on this
   * table covers (group, vehicle, observation_key), not due_date, so uniqueCoveredColumns finds
   * nothing here and the mid-statement collision CostInstance hit cannot arise.
   *
   * ONE EDGE, RECORDED BECAUSE IT IS UNREACHABLE TODAY RATHER THAN IMPOSSIBLE: Postgres clamps a
   * month shift to the shorter month, so a day-precision due date on the 30th AND one on the 31st
   * both land on the 28th. That mapping is not injective, which the two-pass note above assumes it
   * is. Harmless here only because no unique index covers this column — if one ever does, that
   * assumption has to be re-read rather than inherited.
   */
  { t: 'VehicleDueItem', scope: 'group', iv: MONTHLY, cast: 'ts', cols: ['due_date'] },
];

const shiftExpr = (col, iv, cast) =>
  cast === 'date' ? `("${col}" + ${iv})::date` : `"${col}" + ${iv}`;

/**
 * ── WHY SOME COLUMNS CANNOT BE SHIFTED IN ONE STATEMENT ─────────────────────────────────────────
 * A uniform shift keeps a unique set unique, so it is tempting to write one UPDATE and move on.
 * That is what the first version of this script did, and it failed on production with
 *
 *   23505  CostInstance (cost_id, period_start) = (b334c453-…, 2025-10-01) already exists
 *
 * The set is unique before and unique after; the collision is in the MIDDLE. Postgres checks a
 * unique index as each row is written, and the statement has no ordering, so the row moving
 * 2025-08-01 → 2025-10-01 is checked while the row still SITTING on 2025-10-01 has not moved yet.
 * Two rows, one value, mid-statement. Nothing about the before or after state predicts it.
 *
 * `SET CONSTRAINTS ALL DEFERRED` does not help: these are unique INDEXES (Prisma's @@unique), not
 * deferrable constraints, so there is nothing for it to defer.
 *
 * So an affected column is moved in two passes inside the same transaction: first out to a parking
 * century, then back to its final value. Pass one cannot collide because no live value is 500 years
 * away; pass two cannot collide because by then every row of that column is parked, and the mapping
 * back is injective. The final value is identical either way — only the route differs.
 *
 * ── AND WHICH COLUMNS THOSE ARE IS ASKED, NOT LISTED ────────────────────────────────────────────
 * Derived from pg_index at run time. A list written here would have been right the day it was
 * written: CostInstance was the one that fired, but the same query finds three more behind it
 * (CostRate, LeaveRecord, VehicleOdometerReading), and the next @@unique added to a dated column
 * would be a fifth that nobody thought to add. The database is asked because the database is what
 * enforces it.
 */
// The statement builder and the pg_index question live in scripts/_shift-sql.mjs, so the collision
// proof can run THESE statements against a fixture built to collide rather than a copy of them.
const { shiftStatements, uniqueCoveredColumns, parkClearSql, PARK } = await import('./_shift-sql.mjs');

const COVERED = await uniqueCoveredColumns(prisma, [...new Set(PLAN.map((s) => s.t))]);
const TWO_PASS = new Set();
for (const step of PLAN) {
  for (const col of step.cols) if (COVERED.has(`${step.t}.${col}`)) TWO_PASS.add(`${step.t}.${col}`);
}

/** The statements for one column, in phase order. Phase 2 exists only for a two-pass column. */
const statementsFor = (step, col) => shiftStatements({
  table: step.t, col, scopeSql: SCOPE[step.scope], iv: step.iv, cast: step.cast,
  twoPass: TWO_PASS.has(`${step.t}.${col}`),
});

/** What each column holds now, and what the SAME expression the write uses would make of it. */
async function preview() {
  const out = [];
  for (const step of PLAN) {
    for (const col of step.cols) {
      const sql = `SELECT count("${col}")::int AS n,
                          min("${col}") AS mn, max("${col}") AS mx,
                          min(${shiftExpr(col, step.iv, step.cast)}) AS mn2,
                          max(${shiftExpr(col, step.iv, step.cast)}) AS mx2
                     FROM "${step.t}" WHERE ${SCOPE[step.scope]}`;
      const [r] = await prisma.$queryRawUnsafe(sql, TENANT_ID);
      out.push({ t: step.t, col, iv: step.iv, n: r.n, mn: r.mn, mx: r.mx, mn2: r.mn2, mx2: r.mx2 });
    }
  }
  return out;
}

const d = (v) => (v ? new Date(v).toISOString().slice(0, 10) : '—');

/**
 * ── WHAT THE WHOLE-WEEKS CHOICE IS FOR, ASSERTED ────────────────────────────────────────────────
 * The offset is a multiple of 7 so a Tuesday 10:00 booking stays a Tuesday 10:00 booking. That is a
 * claim about every row, not about the min and max, so it is checked as a fingerprint of (weekday,
 * time-of-day) over all of them: shift by whole weeks and it is byte-identical afterwards, shift by
 * 55 days and it is not.
 *
 * These columns are `timestamp without time zone` and every surface reads them as UTC — the diary
 * slices the time straight out of the ISO string (`startAt.slice(11,16)`) and passes
 * `timeZone: 'UTC'` everywhere, with no site timezone anywhere in the path. So adding a whole number
 * of days cannot move a rendered time, and this fingerprint is the proof rather than the hope.
 */
async function signatures() {
  const sig = async (label, sql) => {
    const [r] = await prisma.$queryRawUnsafe(sql, TENANT_ID);
    return { label, sig: r.sig };
  };
  return Promise.all([
    sig('JobCard.start_at weekday+time', `SELECT md5(string_agg(extract(dow from "start_at")::text || to_char("start_at",'HH24:MI:SS'), ',' ORDER BY "id")) AS sig FROM "JobCard" WHERE "group_id" = $1 AND "start_at" IS NOT NULL`),
    sig('JobCard.end_at weekday+time', `SELECT md5(string_agg(extract(dow from "end_at")::text || to_char("end_at",'HH24:MI:SS'), ',' ORDER BY "id")) AS sig FROM "JobCard" WHERE "group_id" = $1 AND "end_at" IS NOT NULL`),
    sig('Invoice.issued_at weekday+time', `SELECT md5(string_agg(extract(dow from "issued_at")::text || to_char("issued_at",'HH24:MI:SS'), ',' ORDER BY "id")) AS sig FROM "Invoice" WHERE "group_id" = $1 AND "issued_at" IS NOT NULL`),
    sig('QuoteVersion.sent_at weekday+time', `SELECT md5(string_agg(extract(dow from "sent_at")::text || to_char("sent_at",'HH24:MI:SS'), ',' ORDER BY "id")) AS sig FROM "QuoteVersion" WHERE "group_id" = $1 AND "sent_at" IS NOT NULL`),
    sig('CostInstance.period day-of-month', `SELECT md5(string_agg(extract(day from "period_start")::text || '/' || extract(day from "period_end")::text, ',' ORDER BY "id")) AS sig FROM "CostInstance" WHERE ${SCOPE.cost}`),
    // How many date_issued values sit at midnight, as a value rather than a hash — the shift must
    // move midnight to midnight and an instant to an instant, so this cannot change. See the note
    // on the reported-only invariant above.
    sig('Invoice.date_issued at midnight (count)', `SELECT count(*) FILTER (WHERE "date_issued" = date_trunc('day', "date_issued"))::text AS sig FROM "Invoice" WHERE "group_id" = $1 AND "date_issued" IS NOT NULL`),
  ]);
}

/**
 * THE INVARIANTS, asked of the database before and after.
 *
 * Each is a question the shift could plausibly break, phrased so the answer is a count that should
 * not change. A shift that moves every row and breaks none of these is a shift that moved only the
 * dates. `expect` is what a correct run leaves behind.
 */
async function invariants(when) {
  const q = async (label, sql, expect) => {
    const [r] = await prisma.$queryRawUnsafe(sql, TENANT_ID);
    const got = Number(r.n);
    const ok = expect === null || got === expect;
    console.log(`    ${ok ? '✓' : '✗'} ${label.padEnd(62)} ${got}${expect !== null ? ` (expect ${expect})` : ''}`);
    return ok;
  };
  console.log(`\n  INVARIANTS ${when}:`);
  const oks = [];
  oks.push(await q('job cards whose start is after their end', `SELECT count(*)::int n FROM "JobCard" WHERE "group_id" = $1 AND "start_at" > "end_at"`, 0));
  /**
   * ── THESE THREE COMPARE DAYS, NOT INSTANTS, AND THAT IS THE WHOLE POINT ───────────────────────
   * `issued_at` carries a time of day (11:15) while `date_issued` is that same day at MIDNIGHT —
   * two granularities of one fact, which is what a document's date is. Written as `<>` these
   * reported 833 of 836 invoices "disagreeing" and 661 "paid before they were issued", purely
   * because 00:00 precedes 09:45 on the same day. Measured: ::date gives 0 and 0.
   *
   * So the strict form was not a stricter check, it was a check of something else — and it would
   * have blocked the write over data that is correct. Kept as a note because the next person to
   * tighten these will reach for `<>` for exactly the reason I did.
   */
  oks.push(await q('invoices paid on a day BEFORE they were issued', `SELECT count(*)::int n FROM "Invoice" WHERE "group_id" = $1 AND "paid_at"::date < "issued_at"::date`, 0));
  oks.push(await q('issued_at and date_issued on different DAYS', `SELECT count(*)::int n FROM "Invoice" WHERE "group_id" = $1 AND "issued_at"::date <> "date_issued"::date`, 0));
  oks.push(await q('paid_at and date_paid on different DAYS', `SELECT count(*)::int n FROM "Invoice" WHERE "group_id" = $1 AND "paid_at"::date <> "date_paid"::date`, 0));
  /**
   * REPORTED, NOT REQUIRED TO BE ZERO. This asked for every date_issued to sit at midnight, and
   * three of 836 do not: 0811, 0812 and 0813 carry issued_at == date_issued == created_at to the
   * millisecond, because they were issued through the live app rather than written by the generator.
   * Midnight is the GENERATOR'S convention; the instant is what lib/invoice-issue actually writes.
   * So zero was an assertion about the fixture, not about the product, and it would have blocked the
   * write over three correct rows. What matters is that the shift does not CHANGE this count, which
   * the fingerprint below checks by equality.
   */
  await q('date_issued not at midnight (live-issued invoices — reported, not required)', `SELECT count(*)::int n FROM "Invoice" WHERE "group_id" = $1 AND "date_issued" IS NOT NULL AND "date_issued" <> date_trunc('day', "date_issued")`, null);
  oks.push(await q('bookings landing on a Saturday or Sunday', `SELECT count(*)::int n FROM "JobCard" WHERE "group_id" = $1 AND "start_at" IS NOT NULL AND extract(dow from "start_at") IN (0,6)`, 0));
  oks.push(await q('bookings outside the site\'s 09:00-18:00 window', `SELECT count(*)::int n FROM "JobCard" WHERE "group_id" = $1 AND "start_at" IS NOT NULL AND (extract(hour from "start_at") < 9 OR extract(hour from "start_at") >= 18)`, 0));
  oks.push(await q('scheduled_date disagreeing with start_at\'s day', `SELECT count(*)::int n FROM "JobCard" WHERE "group_id" = $1 AND "scheduled_date" IS NOT NULL AND "start_at" IS NOT NULL AND "scheduled_date" <> "start_at"::date`, 0));
  oks.push(await q('cost periods NOT starting on the 1st', `SELECT count(*)::int n FROM "CostInstance" WHERE ${SCOPE.cost} AND extract(day from "period_start") <> 1`, 0));
  oks.push(await q('cost periods NOT ending on the 1st', `SELECT count(*)::int n FROM "CostInstance" WHERE ${SCOPE.cost} AND extract(day from "period_end") <> 1`, 0));
  /**
   * ── THE ANCHOR MUST LAND ON THE 1st AT 00:00, BEFORE AND AFTER ────────────────────────────────
   * This clause was missing while the column was already in the plan, which is the gap that
   * mattered: the shift is +2 months and therefore PRESERVES a day-of-month, and a preserved wrong
   * value looks exactly like a correct one. Measured 2026-11-05 — every tenant created after
   * 20260830120000 sat mid-month, because DEFAULT CURRENT_TIMESTAMP stored the signup instant — and
   * this script would have carried such a value forward for ever without a word.
   *
   * `x <> date_trunc('month', x)` asks both halves in ONE expression, wrong day and wrong
   * time-of-day, because an anchor on the 1st at 19:15 is just as broken as one on the 26th and a
   * day-only check calls it clean. Blocking, so a dirty baseline refuses the write exactly as the
   * cost-period clauses do.
   */
  oks.push(await q('reporting anchor not on the 1st at 00:00', `SELECT count(*)::int n FROM "Group" WHERE "id" = $1 AND "reporting_start_date" <> date_trunc('month', "reporting_start_date")`, 0));
  /**
   * THE POPULATION FIRST, THEN THE VIOLATION. A clean verdict over an empty table is a positive
   * report of safety about nothing, and Marketbridge holds ZERO month-precision due items today, so
   * without the count beside it the clause below would read as proof of a rule it never tested.
   */
  await q('month-precision due items (population — reported, not required)', `SELECT count(*)::int n FROM "VehicleDueItem" WHERE "group_id" = $1 AND "due_date" IS NOT NULL AND "due_date_precision" = 'month'`, null);
  oks.push(await q('month-precision due dates not on the 1st', `SELECT count(*)::int n FROM "VehicleDueItem" WHERE "group_id" = $1 AND "due_date" IS NOT NULL AND "due_date_precision" = 'month' AND "due_date" <> date_trunc('month', "due_date")`, 0));
  oks.push(await q('quotes answered before they were sent', `SELECT count(*)::int n FROM "QuoteVersion" WHERE "group_id" = $1 AND "responded_at" < "sent_at"`, 0));
  oks.push(await q('invoices created after they were issued (metadata left behind)', `SELECT count(*)::int n FROM "Invoice" WHERE "group_id" = $1 AND "created_at" > "issued_at"`, null));
  return oks.every(Boolean);
}

// ── THE DRY RUN ─────────────────────────────────────────────────────────────────────────────────
const before = await preview();
console.log('\n' + '='.repeat(104));
console.log('TABLE.COLUMN                               shift      rows   now                      would become');
console.log('='.repeat(104));
let moving = 0;
for (const r of before) {
  const label = `${r.t}.${r.col}`;
  const iv = r.iv === OPERATIONAL ? '+56d' : '+2mo';
  if (!r.n) { console.log(`${label.padEnd(42)} ${iv.padEnd(10)} ${String(r.n).padEnd(6)} (none)`); continue; }
  moving += r.n;
  console.log(`${label.padEnd(42)} ${iv.padEnd(10)} ${String(r.n).padEnd(6)} ${`${d(r.mn)} → ${d(r.mx)}`.padEnd(24)} ${d(r.mn2)} → ${d(r.mx2)}`);
}
console.log('='.repeat(104));
console.log(`  ${moving} dated values would move across ${new Set(before.filter((r) => r.n).map((r) => r.t)).size} tables`);

// ── THE TWO-PASS COLUMNS, AND THE PROOF THAT PARKING IS CLEAR ───────────────────────────────────
console.log(`\n  MOVED IN TWO PASSES (a unique index covers them — see the note above):`);
if (!TWO_PASS.size) console.log('    (none — no unique index covers a shifted column)');
let parkOk = true;
for (const step of PLAN) {
  for (const col of step.cols) {
    if (!TWO_PASS.has(`${step.t}.${col}`)) continue;
    // Parking is only safe if no parked value can equal a live one. Asked of the data rather than
    // assumed from "500 years is obviously enough".
    const [r] = await prisma.$queryRawUnsafe(
      parkClearSql(step.t, col, SCOPE[step.scope], step.iv), TENANT_ID);
    const clear = r.n === 0 || new Date(r.parked_min) > new Date(r.live_max);
    if (!clear) parkOk = false;
    console.log(`    ${clear ? '✓' : '✗'} ${`${step.t}.${col}`.padEnd(40)} ${r.n} rows · parked from ${d(r.parked_min)}, clear of the live max ${d(r.live_max)}`);
  }
}

const okBefore = await invariants('BEFORE');
const sigBefore = await signatures();
console.log('\n  WEEKDAY + TIME-OF-DAY FINGERPRINTS (must be identical after a whole-weeks shift):');
for (const s of sigBefore) console.log(`    ${s.label.padEnd(40)} ${s.sig}`);

if (!WRITE) {
  console.log('\n  DRY RUN — nothing was written. Add --write to commit the shift.\n');
  await prisma.$disconnect();
  process.exit(okBefore ? 0 : 1);
}

// ── THE WRITE ───────────────────────────────────────────────────────────────────────────────────
// Spending real rows belongs to a person at a keyboard, as encrypt-rep-bank and
// publish-affiliate-terms both insist. The dry run above needed neither.
if (!process.stdin.isTTY) await die('REFUSED: --write needs a terminal. Run it yourself; the dry run does not need one.');
if (!parkOk) await die('REFUSED: a parking range overlaps live data — the two-pass shift is not safe here.');
if (!okBefore) await die('REFUSED: an invariant was already failing BEFORE the shift. Fix that first — a shift\n  cannot be checked against a baseline that is not clean.');

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, res));
console.log(`\n  This moves ${moving} dated values on PRODUCTION for ${g.ref} ${g.group_name}.`);
const typed = await ask(`  Type the tenant ref (${TENANT_REF}) to proceed: `);
rl.close();
if (typed.trim() !== TENANT_REF) await die('Not confirmed. NOTHING HAS BEEN WRITTEN.');

// ── AND AGAIN, FOR THE WRITE ITSELF ─────────────────────────────────────────────────────────────
// Not a formality: this call carries write:true and the confirmation, which the first one could
// not. Re-reading the group row as well, because the facts the predicate checks are facts about
// NOW — the dry run above may have taken minutes.
const atWrite = refuseDemoMaintenance(g.ref, await prisma.group.findUnique({
  where: { ref: TENANT_REF }, select: { ref: true, is_demo: true, is_internal: true },
}), {
  actor: 'operator',
  write: true,
  override: { flagged: ALLOW_REFERENCE, confirmed: true },
});
if (atWrite) await die(`REFUSED (${atWrite.code}): ${atWrite.message}`);

// PHASE 1 for every column, THEN phase 2 for the parked ones. The phases must not interleave: a
// column returning from the parking century while another is still being parked is the same
// mid-statement overlap this is here to avoid, one level up.
const counts = [];
await prisma.$transaction(async (tx) => {
  for (const phase of [1, 2]) {
    for (const step of PLAN) {
      for (const col of step.cols) {
        for (const s of statementsFor(step, col)) {
          if (s.phase !== phase) continue;
          const n = await tx.$executeRawUnsafe(s.sql, TENANT_ID);
          if (phase === 1) counts.push({ label: `${step.t}.${col}`, n, parked: TWO_PASS.has(`${step.t}.${col}`) });
        }
      }
    }
  }
}, { timeout: 120_000 });

console.log('\n  WRITTEN:');
for (const c of counts) if (c.n) console.log(`    ${c.label.padEnd(42)} ${c.n}`);

// ── AND CHECKED: did each column land where the dry run said it would? ──────────────────────────
// Compared against the PROJECTION taken before the write, not against the shift expression applied
// again — re-deriving it from the new values would agree with itself whatever happened.
const after = await preview();
let mismatch = 0;
for (let i = 0; i < before.length; i++) {
  const b = before[i], a = after[i];
  if (!b.n) continue;
  const wantMin = d(b.mn2), wantMax = d(b.mx2);
  if (d(a.mn) !== wantMin || d(a.mx) !== wantMax) {
    mismatch++;
    console.log(`    ✗ ${b.t}.${b.col}: expected ${wantMin} → ${wantMax}, found ${d(a.mn)} → ${d(a.mx)}`);
  }
  if (a.n !== b.n) { mismatch++; console.log(`    ✗ ${b.t}.${b.col}: ${b.n} values before, ${a.n} after`); }
}
console.log(`\n  LANDED WHERE PREDICTED: ${mismatch === 0 ? 'yes, every column' : `NO — ${mismatch} mismatch(es)`}`);

const sigAfter = await signatures();
console.log('\n  FINGERPRINTS AFTER:');
let sigBroken = 0;
for (let i = 0; i < sigBefore.length; i++) {
  const same = sigBefore[i].sig === sigAfter[i].sig;
  if (!same) sigBroken++;
  console.log(`    ${same ? '✓' : '✗'} ${sigBefore[i].label.padEnd(40)} ${same ? 'unchanged' : `CHANGED — was ${sigBefore[i].sig}, now ${sigAfter[i].sig}`}`);
}

const okAfter = await invariants('AFTER');
const clean = mismatch === 0 && okAfter && sigBroken === 0;
console.log(`\n  ${clean ? 'DONE — shift applied and checked.' : 'FINISHED WITH PROBLEMS — read the crosses above.'}\n`);
await prisma.$disconnect();
process.exit(clean ? 0 : 1);
