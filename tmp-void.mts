/**
 * Mirrors pages/api/invoice-void.ts step for step, reusing ITS rule functions rather than
 * restating them: same canVoid precondition, same validateVoidReason, same single transaction,
 * same audit action and diff shape. It bypasses only the HTTP/auth layer.
 */
import { PrismaClient, Prisma } from '@prisma/client';
import { canVoid, isVoidCategory, validateVoidReason } from '@/lib/invoice-void';
import { writeAudit } from '@/lib/audit';
const p = new PrismaClient();

const CATEGORY = 'test_or_demo';
const REASON = 'Demonstration card raised on the live tenant on 1 August 2026 — never a real sale, no work was carried out. The customer record attached to it is not a real customer. Voided and retained under VATREC5010.';

// CAPTURE-FIRST: re-verify the guards at the moment of writing, abort if anything moved.
const inv:any = await p.invoice.findFirst({ where: { invoice_number: '100003186' },
  select: { id: true, status: true, invoice_number: true, series: true, job_card_id: true, group_id: true,
            _count: { select: { lines: true } }, job_card: { select: { status: true } } } });
if (!inv) { console.error('ABORT: invoice not found'); process.exit(1); }
console.log(`state at the moment of writing: status=${inv.status} lines=${inv._count.lines} card=${inv.job_card?.status}`);

if (!isVoidCategory(CATEGORY)) { console.error('ABORT: bad category'); process.exit(1); }
const checked = validateVoidReason(REASON);
if (!checked.ok) { console.error('ABORT:', checked.error); process.exit(1); }

const allowed = canVoid({ status: inv.status, lineCount: inv._count.lines });
if (!allowed.ok) {
  console.log(`\nREFUSED by the endpoint's own precondition — ${allowed.code}: ${allowed.message}`);
  console.log('This is the guard working. Nothing written.');
  await p.$disconnect(); process.exit(2);
}

const admin = await p.user.findFirst({ where: { email: 'hugh.gunn@theminispecialist.com' }, select: { id: true, email: true } });
if (!admin) { console.error('ABORT: admin user not found'); process.exit(1); }
await p.$transaction(async (tx: Prisma.TransactionClient) => {
  await tx.invoice.update({ where: { id: inv.id }, data: {
    status: 'void' as any, voided_at: new Date(), voided_by: admin.id,
    void_category: CATEGORY, void_reason: checked.value } });
  await writeAudit(tx, { groupId: inv.group_id, userId: admin.id, jobCardId: inv.job_card_id,
    action: 'invoice.voided',
    diff: { number: inv.invoice_number, series: inv.series, statusBefore: inv.status, category: CATEGORY, reason: checked.value } });
});
console.log(`\nVOIDED ${inv.invoice_number} — attributed to ${admin.email}`);
await p.$disconnect();
