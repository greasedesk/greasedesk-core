/**
 * File: pages/api/superadmin/operators.ts
 * OPERATOR MANAGEMENT — the surface that mints keys to every tenant. OWNER-ONLY, server-enforced
 * (requireOperatorApi({ minRole:'owner' }) → 404 for CM/support/anyone else), and every mutation is
 * audited to SuperAdminAudit with actor, target, before/after and reason.
 *
 *   GET   → list all operators (NOT region-scoped: operator management is Owner-only and an Owner is
 *           not region-bound, so they see every operator).
 *   POST  → create { email, name, role, regions }. No password is typed: the operator is created
 *           INVITE_PENDING with a single-use set-password token, emailed to them (browser is not a
 *           source of credentials). regions required for country_manager/support, forced [] for owner.
 *   PATCH → { id, action: 'role'|'regions'|'suspend'|'unsuspend', ... }.
 *
 * NO DELETE — suspend only. An operator who has taken platform actions stays in the audit trail.
 *
 * SELF-PROTECTION / LOCKOUT invariants (server-side): an Owner cannot suspend or demote themselves,
 * and no action may leave ZERO active owners (leavesZeroActiveOwners) — the last active owner is
 * un-suspendable and un-demotable.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requireOperatorApi, leavesZeroActiveOwners, type OperatorRoleName } from '@/lib/operator-auth';
import { makeInviteToken } from '@/lib/tokens';
import { sendEmail } from '@/lib/email-service';

const ROLES: OperatorRoleName[] = ['owner', 'country_manager', 'support'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Audit chokepoint for operator-target actions. */
async function audit(actorId: string, action: string, target: { id: string; name: string }, extra: { reason?: string; detail?: any } = {}) {
  await prisma.superAdminAudit.create({
    data: {
      operator_user_id: actorId, action,
      target_group_id: null, target_operator_id: target.id, target_name_snapshot: target.name,
      reason: extra.reason ?? null, detail: extra.detail ?? Prisma.JsonNull,
    },
  });
}

/** The ids of currently-active owners (the set the lockout invariant guards). */
async function activeOwnerIds(): Promise<string[]> {
  const rows = await prisma.operator.findMany({ where: { role: 'owner', status: 'active' }, select: { id: true } });
  return rows.map((r: { id: string }) => r.id);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  // Operator management is MAXIMALLY undiscoverable: a valid-but-non-owner operator gets 404 here, not
  // the 403 the generic minRole check returns. On this surface even "you are an operator but not an
  // owner, and this exists" must not leak — so we require any operator (404 otherwise) then 404 a
  // non-owner. Matches how the /superadmin/operators PAGE guard already hides itself.
  const actor = await requireOperatorApi(req, res);
  if (!actor) return; // not an operator at all → 404
  if (actor.role !== 'owner') { res.status(404).json({ message: 'Not found.' }); return; }

  // ── LIST ─────────────────────────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const ops = await prisma.operator.findMany({
      orderBy: { created_at: 'asc' },
      select: {
        id: true, email: true, name: true, role: true, regions: true, status: true,
        suspended_at: true, created_at: true, last_login_at: true, passwordHash: true, invite_token_used_at: true,
      },
    });
    // Which operators have 2FA on (so the screen can show a lock + a Reset action).
    const twoFA = new Set(
      (await prisma.twoFactorSecret.findMany({ where: { subject_type: 'operator', enabled: true }, select: { subject_id: true } })).map((r: { subject_id: string }) => r.subject_id),
    );
    return res.status(200).json({
      operators: ops.map((o: (typeof ops)[number]) => ({
        id: o.id, email: o.email, name: o.name, role: o.role, regions: o.regions, status: o.status,
        suspendedAt: o.suspended_at, createdAt: o.created_at, lastLoginAt: o.last_login_at,
        pending: o.passwordHash === 'INVITE_PENDING' && !o.invite_token_used_at, // hasn't set a password yet
        twoFactorEnabled: twoFA.has(o.id),
        isSelf: o.id === actor.userId,
      })),
    });
  }

  // ── CREATE ───────────────────────────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const b = (req.body || {}) as { email?: string; name?: string; role?: string; regions?: string[] };
    const email = String(b.email ?? '').trim().toLowerCase();
    const name = String(b.name ?? '').trim();
    const role = b.role as OperatorRoleName;
    if (!EMAIL_RE.test(email) || email.length > 200) return res.status(400).json({ message: 'Enter a valid email.' });
    if (!name) return res.status(400).json({ message: 'Enter a name.' });
    if (!ROLES.includes(role)) return res.status(400).json({ message: 'Choose a valid role.' });
    const regions = role === 'owner' ? [] : (Array.isArray(b.regions) ? b.regions.map((r) => String(r).trim().toUpperCase()).filter(Boolean) : []);
    if (role !== 'owner' && regions.length === 0) return res.status(400).json({ message: 'A country manager or support operator needs at least one region.' });

    const invite = makeInviteToken();
    let op;
    try {
      op = await prisma.operator.create({
        data: {
          email, name, role, regions, status: 'active', passwordHash: 'INVITE_PENDING',
          invite_token_hash: invite.hash, invite_token_expires: invite.expires, invite_token_used_at: null,
        },
        select: { id: true, email: true },
      });
    } catch (e: any) {
      if (e?.code === 'P2002') return res.status(409).json({ message: 'An operator with that email already exists.' });
      throw e;
    }

    await audit(actor.userId, 'operator.created', { id: op.id, name: email }, { detail: { role, regions } });

    // Email the set-password link on THIS host (er.). Never return the raw token in the response.
    const host = req.headers.host || 'er.greasedesk.com';
    const link = `https://${host}/superadmin/set-password?token=${invite.raw}`;
    let sent = false;
    try {
      sent = await sendEmail(email, 'Set your Engine Room password',
        `<p>Hi ${name},</p><p>You've been added to the GreaseDesk Engine Room. Set your password to sign in:</p>` +
        `<p><a href="${link}">Set your password</a></p><p>This link expires in 5 days and can be used once.</p>`);
    } catch { sent = false; }
    if (!sent) console.warn('[operators] invite email not sent (Resend unset?) — link:', link);
    // The set-password link is RETURNED to the creating owner (this endpoint is owner-only). That is
    // deliberate: the owner initiated the invite, mailboxes may not exist yet (e.g. hugh@ before it is
    // provisioned), so the link is surfaced on screen to share directly — a one-time token, not a
    // password. (The public forgot-password flow does NOT surface it — that would be a takeover vector.)
    return res.status(200).json({
      ok: true, id: op.id, emailSent: sent, setupLink: link, operatorEmail: email,
      message: sent ? 'Operator created — a set-password email was sent.' : 'Operator created — email not sent; use the link below.',
    });
  }

  // ── MUTATE (role / regions / suspend / unsuspend) ─────────────────────────────────────────────
  if (req.method === 'PATCH') {
    const b = (req.body || {}) as { id?: string; action?: string; role?: string; regions?: string[]; reason?: string };
    const id = String(b.id ?? '');
    if (!id) return res.status(400).json({ message: 'Missing operator id.' });
    const target = await prisma.operator.findUnique({ where: { id }, select: { id: true, email: true, role: true, regions: true, status: true } });
    if (!target) return res.status(404).json({ message: 'Operator not found.' });
    const isSelf = target.id === actor.userId;

    if (b.action === 'role') {
      const role = b.role as OperatorRoleName;
      if (!ROLES.includes(role)) return res.status(400).json({ message: 'Invalid role.' });
      if (role === target.role) return res.status(200).json({ ok: true, message: 'No change.' });
      // Demoting an owner (self OR the last active owner) is the lockout risk.
      if (target.role === 'owner' && role !== 'owner') {
        if (isSelf) return res.status(409).json({ code: 'self_demote', message: 'You cannot demote yourself out of owner.' });
        if (leavesZeroActiveOwners(await activeOwnerIds(), target.id)) return res.status(409).json({ code: 'last_owner', message: 'This is the last active owner — demoting it would lock out the platform.' });
      }
      const regions = role === 'owner' ? [] : target.regions;
      await prisma.operator.update({ where: { id }, data: { role, regions } });
      await audit(actor.userId, 'operator.role_changed', { id, name: target.email }, { detail: { from: target.role, to: role } });
      return res.status(200).json({ ok: true, message: 'Role changed.' });
    }

    if (b.action === 'regions') {
      if (target.role === 'owner') return res.status(409).json({ message: 'Owners are not region-bound; regions do not apply.' });
      const regions = (Array.isArray(b.regions) ? b.regions.map((r) => String(r).trim().toUpperCase()).filter(Boolean) : []);
      if (regions.length === 0) return res.status(400).json({ message: 'At least one region is required.' });
      await prisma.operator.update({ where: { id }, data: { regions } });
      await audit(actor.userId, 'operator.regions_changed', { id, name: target.email }, { detail: { from: target.regions, to: regions } });
      return res.status(200).json({ ok: true, message: 'Regions changed.' });
    }

    if (b.action === 'suspend') {
      const reason = String(b.reason ?? '').trim();
      if (!reason) return res.status(400).json({ message: 'A reason is required to suspend.' });
      if (target.status === 'suspended') return res.status(200).json({ ok: true, message: 'Already suspended.' });
      if (isSelf) return res.status(409).json({ code: 'self_suspend', message: 'You cannot suspend yourself.' });
      if (target.role === 'owner' && leavesZeroActiveOwners(await activeOwnerIds(), target.id)) return res.status(409).json({ code: 'last_owner', message: 'This is the last active owner — suspending it would lock out the platform.' });
      await prisma.operator.update({ where: { id }, data: { status: 'suspended', suspended_at: new Date() } });
      await audit(actor.userId, 'operator.suspended', { id, name: target.email }, { reason });
      return res.status(200).json({ ok: true, message: 'Operator suspended.' });
    }

    if (b.action === 'unsuspend') {
      if (target.status === 'active') return res.status(200).json({ ok: true, message: 'Already active.' });
      await prisma.operator.update({ where: { id }, data: { status: 'active', suspended_at: null } });
      await audit(actor.userId, 'operator.unsuspended', { id, name: target.email });
      return res.status(200).json({ ok: true, message: 'Operator un-suspended.' });
    }

    // OWNER RESET of another operator's 2FA — the account-recovery path for a lost device + lost
    // recovery codes. Turns 2FA off so they can sign in with their password again and re-enrol.
    // (An operator disables their OWN 2FA via Settings, which requires a code; this owner path does
    // not — it exists precisely for when the operator can no longer produce one.)
    if (b.action === 'reset_2fa') {
      const { disable } = await import('@/lib/two-factor');
      await disable({ type: 'operator', id });
      await audit(actor.userId, 'operator.2fa_reset', { id, name: target.email });
      return res.status(200).json({ ok: true, message: `Two-factor authentication reset for ${target.email}. They can now sign in with their password alone and re-enrol.` });
    }

    return res.status(400).json({ message: 'Unknown action.' });
  }

  res.setHeader('Allow', 'GET, POST, PATCH');
  return res.status(405).json({ message: 'Method Not Allowed' });
}
