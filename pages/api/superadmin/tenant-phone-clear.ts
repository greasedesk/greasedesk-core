/**
 * File: pages/api/superadmin/tenant-phone-clear.ts
 * POST { userId } → OPERATOR clears a TENANT user's confirmed mobile number. CLEAR-ONLY.
 *
 * ── WHY AN OPERATOR LEVEL EXISTS AT ALL ─────────────────────────────────────────────────────────
 * The admin path (users → Clear mobile) covers a staff member. It cannot cover the case that
 * matters most: a garage sold, and the SOLE owner's handset is still the account's recovery
 * contact. There is nobody above them inside the tenant to clear it, and the previous owner keeps
 * receiving codes for a business they no longer have. Same shape of gap the 2FA reset exists for,
 * and the same answer.
 *
 * ── IT CLEARS. IT NEVER SETS, AND NEVER RE-POINTS. ──────────────────────────────────────────────
 * No endpoint anywhere writes a number onto somebody else's account, because verification requires
 * possession of the handset — that is the entire reason the number lives on the enrolment row and
 * not on the editable profile. An operator who could aim a tenant's recovery number at a phone they
 * control would hold every garage.
 *
 * It also leaves any TOTP enrolment ALONE. Clearing a number and removing a second factor are
 * different acts; the 2FA reset is a separate endpoint precisely so neither happens by accident.
 *
 * Region-scoped and dual-audited: SuperAdminAudit for us, and the tenant's own AuditLog with a null
 * actor — nobody inside the garage did this, and naming a staff member would be a lie in the one
 * trail they can read.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { requireOperatorApi, tenantInScope } from '@/lib/operator-auth';
import { clearVerifiedPhone } from '@/lib/phone-verification';
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
    select: { id: true, email: true, group_id: true, customerId: true },
  });
  // STAFF ONLY, never a customer-portal account. Missing and out-of-scope give the SAME 404 — an
  // operator outside the region must not learn the account exists.
  if (!target || !target.group_id || target.customerId) return res.status(404).json({ message: 'Not found.' });
  if (!(await tenantInScope(actor, target.group_id))) return res.status(404).json({ message: 'Not found.' });

  const cleared = await clearVerifiedPhone({ type: 'tenant', id: target.id });
  if (!cleared) return res.status(200).json({ ok: true, message: 'That account has no confirmed mobile number.' });

  await prisma.superAdminAudit.create({
    data: {
      operator_user_id: actor.userId,
      action: 'tenant.phone_cleared',
      target_group_id: target.group_id,
      target_operator_id: null,
      target_name_snapshot: target.email,
      reason: 'Confirmed mobile removed — the handset is no longer the account holder’s.',
    },
  }).catch(() => {});

  await writeUserAudit(prisma, {
    groupId: target.group_id, actorUserId: null, targetUserId: target.id,
    action: 'user.phone_cleared', diff: { email: target.email, by: 'greasedesk_support' },
  }).catch(() => {});

  return res.status(200).json({
    ok: true,
    message: `Mobile number cleared for ${target.email}. They can confirm a new one from their own account.`,
  });
}
