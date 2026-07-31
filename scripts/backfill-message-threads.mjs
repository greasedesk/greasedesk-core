/**
 * scripts/backfill-message-threads.mjs
 * Link existing NotificationLog rows onto (customer, vehicle) threads.
 *
 *   --dry            report only, write nothing (DEFAULT — you must pass --commit)
 *   --commit         create threads and set NotificationLog.thread_id
 *   --restore <file> REVERSAL: set thread_id null for every id in the BEFORE snapshot
 *
 * ONLY writes NotificationLog.thread_id and creates MessageThread rows. No message content is
 * copied, moved or altered — the log stays the single record of what was sent.
 *
 * The thread is derived from the message's SUBJECT (job card / invoice → vehicle → current owner via
 * the VehicleOwnership edge), not from its recipient. A recipient can be the garage's own address:
 * a "customer accepted your quote" alert is addressed to staff and is not a customer conversation.
 * Those stay NULL, and so do staff invites and operator mail. Null means NOT A CUSTOMER THREAD.
 */
import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'fs';

const prisma = new PrismaClient();
const argv = process.argv.slice(2);
const COMMIT = argv.includes('--commit');
const RESTORE = argv.includes('--restore') ? argv[argv.indexOf('--restore') + 1] : null;

async function currentOwnerId(vehicleId) {
  const edge = await prisma.vehicleOwnership.findFirst({ where: { vehicle_id: vehicleId, is_current: true }, select: { customer_id: true } });
  return edge?.customer_id ?? null;
}

/** Returns { key } or { why } — the REASON matters as much as the outcome, so it is never guessed. */
async function keyForSubject(type, id) {
  if (!id) return { why: 'no subject recorded' };
  if (type !== 'job_card' && type !== 'invoice') return { why: 'staff/operator mail — not a customer conversation' };
  let cardId = id;
  if (type === 'invoice') {
    const inv = await prisma.invoice.findUnique({ where: { id }, select: { job_card_id: true } });
    if (!inv) return { why: 'invoice no longer exists' };
    cardId = inv.job_card_id;
  }
  const card = await prisma.jobCard.findUnique({ where: { id: cardId }, select: { group_id: true, vehicle_id: true } });
  // The subject reference is LOOSE BY DESIGN (never a hard FK) so a message outlives the card it was
  // about. Unthreadable, permanently, and for a different reason than a missing ownership edge.
  if (!card) return { why: 'job card no longer exists — message outlived its subject' };
  if (!card.vehicle_id) return { why: 'job card has no vehicle' };
  const customerId = await currentOwnerId(card.vehicle_id);
  if (!customerId) return { why: 'vehicle has NO CURRENT OWNERSHIP EDGE — no customer to key on' };
  return { key: { groupId: card.group_id, customerId, vehicleId: card.vehicle_id } };
}

async function restore() {
  const snap = JSON.parse(readFileSync(RESTORE, 'utf8'));
  const ids = snap.rows.map((r) => r.id);
  const linked = await prisma.notificationLog.count({ where: { id: { in: ids }, thread_id: { not: null } } });
  console.log(`${COMMIT ? 'RESTORING' : 'DRY RUN restore'} — ${linked} of ${ids.length} snapshot rows currently carry a thread_id`);
  if (COMMIT) {
    const r = await prisma.notificationLog.updateMany({ where: { id: { in: ids } }, data: { thread_id: null } });
    console.log(`  cleared thread_id on ${r.count} rows (MessageThread rows left in place — empty threads harm nothing and deleting is not reversal)`);
  }
}

async function main() {
  if (RESTORE) return restore();

  const rows = await prisma.notificationLog.findMany({
    select: { id: true, group_id: true, template: true, recipient: true, subject_type: true, subject_id: true, created_at: true },
    orderBy: { created_at: 'asc' },
  });

  let linked = 0;
  const unlinked = [];
  const threadsSeen = new Set();

  for (const r of rows) {
    const { key, why } = await keyForSubject(r.subject_type, r.subject_id);
    if (!key) { unlinked.push({ ...r, why }); continue; }
    if (r.group_id && r.group_id !== key.groupId) { unlinked.push({ ...r, why: 'subject belongs to a different tenant — refused' }); continue; }
    const k = `${key.groupId}|${key.customerId}|${key.vehicleId}`;
    threadsSeen.add(k);
    linked++;
    if (COMMIT) {
      const where = { group_id_customer_id_vehicle_id: { group_id: key.groupId, customer_id: key.customerId, vehicle_id: key.vehicleId } };
      const t = (await prisma.messageThread.findUnique({ where, select: { id: true } }))
        ?? (await prisma.messageThread.create({ data: { group_id: key.groupId, customer_id: key.customerId, vehicle_id: key.vehicleId }, select: { id: true } }));
      await prisma.notificationLog.update({ where: { id: r.id }, data: { thread_id: t.id } });
    }
  }

  if (COMMIT) {
    // last_message_at is DERIVED — recompute from the messages rather than tracking it as we go.
    for (const t of await prisma.messageThread.findMany({ select: { id: true } })) {
      const latest = await prisma.notificationLog.findFirst({ where: { thread_id: t.id }, orderBy: { created_at: 'desc' }, select: { created_at: true } });
      await prisma.messageThread.update({ where: { id: t.id }, data: { last_message_at: latest?.created_at ?? null } });
    }
  }

  console.log(`\n${COMMIT ? '=== COMMITTED ===' : '=== DRY RUN (nothing written) ==='}`);
  console.log(`  total NotificationLog rows : ${rows.length}`);
  console.log(`  LINKED to a thread         : ${linked}`);
  console.log(`  left NULL (not a customer conversation) : ${unlinked.length}`);
  console.log(`  distinct threads           : ${threadsSeen.size}`);
  const byReason = {};
  for (const u of unlinked) byReason[u.why] = (byReason[u.why] || 0) + 1;
  console.log(`\n  --- unlinked, grouped by REASON ---`);
  for (const [w, n] of Object.entries(byReason)) console.log(`   ${String(n).padStart(3)}  ${w}`);
  console.log(`\n  --- every unlinked row ---`);
  for (const u of unlinked) console.log(`   ${u.created_at.toISOString()}  ${u.template.padEnd(17)} ${String(u.recipient).padEnd(34)} ${u.why}`);
}

main().finally(() => prisma.$disconnect());
