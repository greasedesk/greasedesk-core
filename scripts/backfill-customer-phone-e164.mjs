/**
 * scripts/backfill-customer-phone-e164.mjs
 * Populate Customer.phone_e164 from the RAW Customer.phone, using the tenant's country-profile dial
 * code. WRITE-ONLY TO phone_e164 — the raw `phone` column is never touched, so nothing any existing
 * screen reads can change, and the operation is reversible by nulling the new column.
 *
 *   --dry           report only; write nothing (DEFAULT — you must pass --commit to write)
 *   --commit        perform the writes, one AuditLog row per changed customer
 *   --group <ref>   limit to one tenant (e.g. GB-GD1967)
 *   --restore <f>   REVERSAL: re-derive from a BEFORE snapshot file, restoring `phone` to the
 *                   snapshot value and recomputing phone_e164 from it
 *
 * Never deletes from AuditLog. Never writes when a row already matches what it would write.
 */
import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'fs';

const prisma = new PrismaClient();
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const COMMIT = has('--commit');
const RESTORE = val('--restore');
const GROUP_REF = val('--group');

// The country profile is compiled TS; the dial-code table is small and stable, so it is mirrored
// here rather than importing the app's build. GB is the only enabled country (lib/enabled-countries).
const DIAL = { GB: '44', IE: '353', US: '1' };

/** Byte-identical to lib/contact-routes::toE164Digits. Kept in step deliberately — if that changes,
 *  this must too, and the dry-run diff is what will tell you. */
function toE164Digits(raw, defaultCc = '44') {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const isPlus = trimmed.startsWith('+');
  let d = trimmed.replace(/\D/g, '');
  if (!d) return null;
  if (isPlus) return d.length >= 8 ? d : null;
  if (d.startsWith('00')) { d = d.slice(2); return d.length >= 8 ? d : null; }
  if (d.startsWith('0')) return defaultCc + d.slice(1);
  if (defaultCc === '1' && d.length === 10) return '1' + d;
  if (d.startsWith(defaultCc)) return d;
  return d.length >= 11 ? d : null;
}

async function main() {
  if (RESTORE) return restore();

  const groups = await prisma.group.findMany({ select: { id: true, ref: true, country_code: true, group_name: true } });
  const targets = GROUP_REF ? groups.filter((g) => g.ref === GROUP_REF) : groups;
  if (GROUP_REF && !targets.length) throw new Error(`No group with ref ${GROUP_REF}`);

  let normalised = 0, unchanged = 0, failed = 0, noPhone = 0;
  const failures = [];

  for (const g of targets) {
    const cc = DIAL[(g.country_code || 'GB').toUpperCase()] ?? '44';
    const rows = await prisma.customer.findMany({
      where: { group_id: g.id },
      select: { id: true, name: true, phone: true, phone_e164: true },
      orderBy: { id: 'asc' },
    });
    for (const c of rows) {
      if (!c.phone || !c.phone.trim()) { noPhone++; continue; }
      const want = toE164Digits(c.phone, cc);
      if (want === null) {
        failed++;
        failures.push({ group: g.ref, id: c.id, name: c.name, raw: c.phone });
        continue;
      }
      if (want === c.phone_e164) { unchanged++; continue; }
      normalised++;
      if (COMMIT) {
        await prisma.$transaction(async (tx) => {
          await tx.customer.update({ where: { id: c.id }, data: { phone_e164: want } });
          await tx.auditLog.create({
            data: {
              group_id: g.id, user_id: null, entity: 'customer', entity_id: c.id,
              action: 'customer.phone_e164_backfilled',
              diff_json: { phone_raw: c.phone, phone_e164: { from: c.phone_e164, to: want }, dial_code: cc, script: 'backfill-customer-phone-e164' },
            },
          });
        });
      }
    }
  }

  console.log(`\n${COMMIT ? '=== COMMITTED ===' : '=== DRY RUN (nothing written) ==='}`);
  console.log(`  normalised successfully : ${normalised}`);
  console.log(`  unchanged (already correct): ${unchanged}`);
  console.log(`  FAILED (stays null, raw kept): ${failed}`);
  console.log(`  no phone at all (skipped): ${noPhone}`);
  if (failures.length) {
    console.log(`\n  --- every failure, with its raw value ---`);
    for (const f of failures) console.log(`   ${f.group}  ${JSON.stringify(f.raw).padEnd(22)} ${f.name}  (${f.id})`);
  }
}

/** REVERSAL from a BEFORE snapshot: restore the raw phone exactly, recompute e164 from it. */
async function restore() {
  const snap = JSON.parse(readFileSync(RESTORE, 'utf8'));
  const g = await prisma.group.findUnique({ where: { id: snap.groupId }, select: { ref: true, country_code: true } });
  const cc = DIAL[(g?.country_code || 'GB').toUpperCase()] ?? '44';
  let restored = 0, same = 0;
  for (const r of snap.rows) {
    const cur = await prisma.customer.findUnique({ where: { id: r.id }, select: { phone: true, phone_e164: true } });
    if (!cur) continue;
    const wantE = r.phone ? toE164Digits(r.phone, cc) : null;
    if (cur.phone === r.phone && cur.phone_e164 === wantE) { same++; continue; }
    restored++;
    if (COMMIT) await prisma.customer.update({ where: { id: r.id }, data: { phone: r.phone, phone_e164: wantE } });
  }
  console.log(`${COMMIT ? 'RESTORED' : 'DRY RUN restore'} — would change ${restored}, already matching ${same} (of ${snap.rows.length})`);
}

main().finally(() => prisma.$disconnect());
