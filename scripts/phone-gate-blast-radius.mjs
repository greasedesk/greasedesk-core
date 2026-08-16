/**
 * File: scripts/phone-gate-blast-radius.mjs
 * READ-ONLY. Who would the phone step block RIGHT NOW, if it were live for everyone?
 *
 * The gate is mandatory and un-skippable, so "how many admins does it stand in front of" is not a
 * detail — it is the entire risk. Five of five live tenants have zero recorded numbers, which is
 * why PHONE_STEP_REQUIRED_FROM exists; this script is the evidence that the cutoff is doing its job
 * rather than the assumption that it is.
 *
 * Prints, per group: created_at, whether it is exempt, and each admin's recorded/verified state,
 * then the verdict the live rule would reach.
 */
import './_gate-preflight.mjs';
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

// Mirrors lib/onboarding — deliberately re-stated rather than imported, so a change to the rule
// shows up as a DISAGREEMENT here instead of both sides moving together silently.
const CUTOFF = new Date('2026-08-09T00:00:00.000Z');

const groups = await prisma.group.findMany({
  select: {
    id: true, group_name: true, created_at: true, is_internal: true,
    phone_step_exempt_at: true, phone_step_exempt_reason: true,
  },
  orderBy: { created_at: 'asc' },
});

let blocked = 0;
for (const g of groups) {
  const admins = await prisma.user.findMany({
    where: { group_id: g.id, OR: [{ role: 'ADMIN' }, { is_owner: true }] },
    select: { id: true, email: true, role: true, is_owner: true },
  });
  const rows = await prisma.twoFactorSecret.findMany({
    where: { subject_type: 'tenant', subject_id: { in: admins.map((a) => a.id) } },
    select: { subject_id: true, phone_recorded_at: true, phone_verified_at: true, phone_confirmed_via: true },
  });
  const by = new Map(rows.map((r) => [r.subject_id, r]));

  const afterCutoff = g.created_at >= CUTOFF;
  const exempt = !!g.phone_step_exempt_at;
  const wouldGate = afterCutoff && !exempt;
  const stuck = wouldGate ? admins.filter((a) => !by.get(a.id)?.phone_recorded_at) : [];
  blocked += stuck.length;

  console.log(
    `${g.group_name}${g.is_internal ? ' [internal]' : ''}  created ${g.created_at.toISOString().slice(0, 10)}` +
    `  ${afterCutoff ? 'AFTER cutoff' : 'grandfathered'}${exempt ? ' EXEMPT' : ''}` +
    `  →  ${wouldGate ? (stuck.length ? `BLOCKS ${stuck.length}/${admins.length} admin(s)` : 'passes') : 'not gated'}`,
  );
  for (const a of admins) {
    const r = by.get(a.id);
    console.log(`    ${a.email}  recorded=${r?.phone_recorded_at ? r.phone_recorded_at.toISOString().slice(0, 10) : '—'}` +
      `  verified=${r?.phone_verified_at ? 'yes' : 'no'}  via=${r?.phone_confirmed_via ?? '—'}`);
  }
}

console.log(`\nAdmins the live rule would stop today: ${blocked}`);
await prisma.$disconnect();
