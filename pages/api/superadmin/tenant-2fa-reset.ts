/**
 * File: pages/api/superadmin/tenant-2fa-reset.ts
 * POST { userId } → OPERATOR resets a TENANT user's two-factor authentication. DISABLE-ONLY.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────────
 * A garage OWNER who loses their phone and their recovery codes has nobody above them. Every other
 * lockout has an answer — a staff member is reset by their admin — but the sole owner of a
 * single-admin garage is the one person the tenant-side reset cannot help, and that describes most
 * of our tenants. Without this the only remedy is a hand-written DELETE against the production
 * database, which is not a support process and leaves no trace anyone can audit.
 *
 * ── IT ONLY EVER DISABLES ───────────────────────────────────────────────────────────────────────
 * There is no enable, no re-enrol, no "set it to this secret". An operator can lower an account to
 * a single factor and nothing else; the owner then re-enrols from their own handset. An operator who
 * could ENABLE 2FA on a tenant account, or point it at a device, would hold a key to every garage.
 *
 * ── SCOPE AND TRACE ─────────────────────────────────────────────────────────────────────────────
 * Region-scoped through tenantInScope, exactly like every other tenant-touching operator
 * action, and written to SuperAdminAudit — the operator ledger — with the target named. It ALSO
 * writes the tenant's own AuditLog, because the garage is entitled to see that someone outside their
 * business changed the protection on an account. One act, two ledgers, neither optional.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { requireOperatorApi, tenantInScope } from '@/lib/operator-auth';
import { isEnabled, resetTwoFactor } from '@/lib/two-factor';
import { writeUserAudit } from '@/lib/audit';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).end(); }

  const actor = await requireOperatorApi(req, res); // wrong actor class → 404, never 403
  if (!actor) return;

  const { userId } = (req.body || {}) as { userId?: string };
  if (!userId) return res.status(400).json({ message: 'Missing userId.' });

  const target = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, group_id: true, customerId: true },
  });
  // STAFF ONLY, and never a customer-portal account. A missing target and an out-of-scope one give
  // the same 404 — an operator outside the region must not learn that this user exists.
  if (!target || !target.group_id || target.customerId) return res.status(404).json({ message: 'Not found.' });

  // Region scope, through the SAME helper every tenant-touching operator action uses. Out-of-region
  // is a 404, not a 403 — an operator outside the region must not learn the account exists.
  if (!(await tenantInScope(actor, target.group_id))) return res.status(404).json({ message: 'Not found.' });

  if (!(await isEnabled({ type: 'tenant', id: target.id }))) {
    return res.status(200).json({ ok: true, message: 'Two-factor authentication is already off for that account.' });
  }

  await resetTwoFactor({ type: 'tenant', id: target.id });

  await prisma.superAdminAudit.create({
    data: {
      operator_user_id: actor.userId,
      action: 'tenant.2fa_reset',
      target_group_id: target.group_id,
      target_operator_id: null,
      target_name_snapshot: target.email,
      reason: 'Lost device and recovery codes — account lowered to a single factor until re-enrolment.',
    },
  }).catch(() => {});

  // THE TENANT'S OWN LEDGER TOO. actorUserId is null: nobody inside the garage did this, and
  // attributing it to a staff member would be a lie in the one trail they can read.
  await writeUserAudit(prisma, {
    groupId: target.group_id, actorUserId: null, targetUserId: target.id,
    action: 'user.2fa_reset', diff: { email: target.email, by: 'greasedesk_support' },
  }).catch(() => {});

  return res.status(200).json({
    ok: true,
    message: `Two-factor authentication reset for ${target.email}. They sign in with their password alone until they re-enrol.`,
  });
}
