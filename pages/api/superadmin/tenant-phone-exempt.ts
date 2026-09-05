/**
 * File: pages/api/superadmin/tenant-phone-exempt.ts
 * POST { groupId, reason } → OPERATOR exempts a tenant from the signup phone step. Owner-only.
 *
 * ── IT EXEMPTS. IT NEVER VERIFIES. ──────────────────────────────────────────────────────────────
 * The obvious shortcut — write phone_verified_at and let them through — is the one thing this must
 * not do. That column means "a handset answered a code", and SMS 2FA is built on it. Faking it to
 * unblock a signup would put a lie in the exact place a second factor later trusts, and nothing
 * downstream could tell the difference. So the exemption lives on the GROUP and the phone columns
 * are left untouched: the tenant passes the gate with no phone, honestly recorded as such.
 *
 * ── WHY IT EXISTS ───────────────────────────────────────────────────────────────────────────────
 * The step is mandatory, which makes any delivery failure a signup outage — and some failures are
 * permanent for the person in front of us: a landline-only garage, a number no carrier will deliver
 * to, both channels down. The email fallback removes most of it; this covers the remainder, at our
 * speed rather than theirs.
 *
 * REASON IS MANDATORY, same argument as the void reason: an exemption with no explanation is
 * indistinguishable from a mistake when somebody finds it six months later.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { requireOperatorApi, tenantInScope } from '@/lib/operator-auth';

const MIN_REASON = 12;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).end(); }
  const actor = await requireOperatorApi(req, res, { minRole: 'owner' });
  if (!actor) return;

  const { groupId, reason, revoke } = (req.body || {}) as { groupId?: string; reason?: string; revoke?: boolean };
  if (!groupId) return res.status(400).json({ message: 'Missing groupId.' });
  if (!(await tenantInScope(actor, groupId))) return res.status(404).json({ message: 'Not found.' });

  const group = await prisma.group.findUnique({
    where: { id: groupId },
    select: { id: true, group_name: true, ref: true, phone_step_exempt_at: true },
  });
  if (!group) return res.status(404).json({ message: 'Not found.' });

  // REVOKABLE. An exemption granted while SMS was down should not outlive the outage, and an
  // operator who cannot take it back would simply never grant one.
  if (revoke) {
    if (!group.phone_step_exempt_at) return res.status(200).json({ ok: true, message: 'That tenant is not exempt.' });
    await prisma.group.update({
      where: { id: groupId },
      data: { phone_step_exempt_at: null, phone_step_exempt_reason: null, phone_step_exempt_by: null },
    });
    await audit(actor.userId, groupId, group, 'tenant.phone_step_exempt_revoked', 'Exemption revoked — the step applies again.');
    return res.status(200).json({ ok: true, message: `${group.group_name} is no longer exempt from the phone step.` });
  }

  const text = String(reason ?? '').trim();
  if (text.length < MIN_REASON || new Set(text.replace(/\s+/g, '')).size <= 1) {
    return res.status(400).json({ message: 'Say why this tenant cannot complete the step — it is the record that explains the exemption.' });
  }
  if (group.phone_step_exempt_at) return res.status(200).json({ ok: true, message: 'That tenant is already exempt.' });

  await prisma.group.update({
    where: { id: groupId },
    data: { phone_step_exempt_at: new Date(), phone_step_exempt_reason: text.slice(0, 500), phone_step_exempt_by: actor.userId },
  });
  await audit(actor.userId, groupId, group, 'tenant.phone_step_exempted', text.slice(0, 500));

  return res.status(200).json({
    ok: true,
    message: `${group.group_name} is exempt from the phone step. No phone number has been recorded or verified for them.`,
  });
}

/**
 * THIS STILL WRITES ONLY THE OPERATOR LEDGER, and the sentence below described an intention nothing
 * implemented — corrected 2026-09-05 rather than left to mislead.
 *
 * WHAT IT SHOULD BE: both ledgers. Ours for accountability, theirs because somebody outside the
 * business changed what their account is required to do, with a null tenant-side actor since nobody
 * inside did. pages/api/superadmin/trial-extend is the first operator write that does it — one of
 * eleven. This file OWES THE TENANT a row, and so do the other nine; trial-extend-gate pins the
 * count so the debt is visible and shrinking it is deliberate.
 */
async function audit(operatorId: string, groupId: string, group: { group_name: string; ref: number | string | null }, action: string, reason: string) {
  await prisma.superAdminAudit.create({
    data: {
      operator_user_id: operatorId, action, target_group_id: groupId, target_operator_id: null,
      target_name_snapshot: group.group_name, target_ref_snapshot: group.ref == null ? null : String(group.ref), reason,
    },
  }).catch(() => {});
}
