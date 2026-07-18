/**
 * File: pages/api/users.ts
 * User management for the caller's group. Assignment only (no roles/permission enforcement).
 *
 *   POST   { name, email, siteIds[] }        → create a PENDING user (invite stub, no email)
 *   PATCH  { id, name?, siteIds[] }           → edit name + site assignments
 *   DELETE { id }                             → remove (guarded: not self, not last user)
 *
 * Every operation is group-scoped: you can only touch users in your own group, and may only
 * assign your own group's sites. Mirrors the Settings ownership pattern.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { Prisma, UserRole } from '@prisma/client';
import { getVisibility } from '@/lib/site-visibility';
import { makeInviteToken } from '@/lib/tokens';
import { sendTeamInvitationEmail } from '@/lib/email-service';
import { writeUserAudit } from '@/lib/audit';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  const sessionUser = session?.user as any;
  if (!sessionUser?.id || !sessionUser?.group_id || !sessionUser?.site_id) {
    return res.status(401).json({ message: 'Authentication Error: Group/Site context not found.' });
  }
  const groupId = sessionUser.group_id as string;
  const sessionSiteId = sessionUser.site_id as string;
  const sessionUserId = sessionUser.id as string;

  // User management is for ADMIN (full) and SITE_MANAGER (STANDARD users at their own sites only).
  // STANDARD users have no access (also anchors them — they can't reassign themselves).
  const callerVis = await getVisibility(sessionUserId);
  if (callerVis.role === 'STANDARD') {
    return res.status(403).json({ message: 'You do not have access to user management.' });
  }
  const isManagerOnly = !callerVis.isAdmin; // SITE_MANAGER: graded — scoped to their sites + STANDARD targets

  // Keep only site ids that belong to the caller's group.
  async function groupSiteIds(ids: string[]): Promise<string[]> {
    if (!Array.isArray(ids) || ids.length === 0) return [];
    const rows = await prisma.site.findMany({ where: { id: { in: ids }, group_id: groupId }, select: { id: true } });
    return (rows as Array<{ id: string }>).map((r) => r.id);
  }
  // A site-manager may only assign sites they themselves manage.
  const managerScopeOk = (ids: string[]) => !isManagerOnly || ids.every((id) => callerVis.siteIds.includes(id));
  // A site-manager may only act on STANDARD, non-owner targets who sit at one of their sites.
  function managerMayTarget(t: { role: string; is_owner: boolean; site_assignments: Array<{ site_id: string }> }): boolean {
    if (!isManagerOnly) return true;
    if (t.is_owner || t.role !== 'STANDARD') return false;
    return t.site_assignments.some((a) => callerVis.siteIds.includes(a.site_id));
  }

  if (req.method === 'POST') {
    const { name, email, siteIds } = (req.body || {}) as { name?: string; email?: string; siteIds?: string[] };
    const cleanName = (name || '').trim();
    const cleanEmail = (email || '').trim().toLowerCase();
    if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      return res.status(400).json({ message: 'A valid email is required.' });
    }
    const existing = await prisma.user.findUnique({ where: { email: cleanEmail }, select: { id: true } });
    if (existing) return res.status(409).json({ message: 'A user with that email already exists.' });

    const validSites = await groupSiteIds(siteIds || []);
    // STEP 4 invariant: new users are STANDARD → must have at least one site.
    if (validSites.length === 0) {
      return res.status(400).json({ message: 'A standard user must be assigned at least one location.' });
    }
    // A site-manager can only invite into their own sites.
    if (!managerScopeOk(validSites)) {
      return res.status(403).json({ message: 'Site managers can only invite users to their own locations.' });
    }
    const defaultSite = validSites[0] ?? sessionSiteId;

    const invite = makeInviteToken(); // raw emailed; only the hash is stored
    try {
      const created = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const u = await tx.user.create({
          data: {
            name: cleanName || null,
            email: cleanEmail,
            group_id: groupId,
            site_id: defaultSite,
            role: 'STANDARD',            // invited/added users default to STANDARD; ADMIN is granted via edit
            is_active: false,            // pending until they set a password via the invite link
            passwordHash: 'INVITE_PENDING',
            invite_token_hash: invite.hash,
            invite_token_expires: invite.expires,
            invite_token_used_at: null,
          },
          select: { id: true },
        });
        if (validSites.length) {
          await tx.userSite.createMany({ data: validSites.map((sid) => ({ user_id: u.id, site_id: sid })) });
        }
        return u;
      });

      // Send the invite email with the RAW token (never stored). Log-fallback if Resend is unset.
      const baseUrl = process.env.NEXTAUTH_URL || 'https://greasedesk.com';
      const inviteLink = `${baseUrl}/set-password?token=${invite.raw}`;
      const group = await prisma.group.findUnique({ where: { id: groupId }, select: { group_name: true } });
      const sent = await sendTeamInvitationEmail(cleanEmail, group?.group_name ?? 'GreaseDesk', inviteLink);
      if (!sent) console.warn('Invite email not sent (Resend unset?) — link:', inviteLink);

      return res.status(201).json({
        id: created.id,
        message: sent ? 'User invited — a set-password email has been sent.' : 'User created (pending — email not sent; check server logs for the link).',
      });
    } catch (e) {
      console.error('User create error:', e);
      return res.status(500).json({ message: 'Failed to create user.' });
    }
  }

  if (req.method === 'PATCH') {
    const { id, name, siteIds, role, primarySiteId, canInvoice, isActive } = (req.body || {}) as { id?: string; name?: string; siteIds?: string[]; role?: string; primarySiteId?: string | null; canInvoice?: boolean; isActive?: boolean };
    if (!id) return res.status(400).json({ message: 'Missing id.' });
    // can_invoice is an ADMIN-only grant (a ledger power) — a site manager may manage their mechanics
    // but may not hand out invoice-raising authority.
    if (canInvoice !== undefined && isManagerOnly) {
      return res.status(403).json({ message: 'Only an admin can grant invoice-raising permission.' });
    }
    // Deactivation blocks login and kills live sessions — an account-level power, ADMIN only.
    if (isActive !== undefined && isManagerOnly) {
      return res.status(403).json({ message: 'Only an admin can deactivate or reactivate an account.' });
    }
    const target = await prisma.user.findFirst({
      where: { id, group_id: groupId },
      select: { id: true, email: true, is_owner: true, role: true, primary_site_id: true, _count: { select: { site_assignments: true } }, site_assignments: { select: { site_id: true } } },
    });
    if (!target) return res.status(404).json({ message: 'User not found.' });

    // Site managers may only manage STANDARD users at their own sites.
    if (!managerMayTarget(target)) {
      return res.status(403).json({ message: 'Site managers can only manage standard users at their own locations.' });
    }

    if (role !== undefined) {
      if (role !== 'ADMIN' && role !== 'SITE_MANAGER' && role !== 'STANDARD') {
        return res.status(400).json({ message: 'Role must be ADMIN, SITE_MANAGER or STANDARD.' });
      }
      // Escalation guard: a site manager can never grant SITE_MANAGER or ADMIN.
      if (isManagerOnly && role !== 'STANDARD') {
        return res.status(403).json({ message: 'Site managers cannot grant the site-manager or admin role.' });
      }
      // Owner is immutable: locked to ADMIN, cannot be demoted.
      if (target.is_owner && role !== 'ADMIN') {
        return res.status(409).json({ message: 'The owner account is locked to ADMIN and cannot be demoted.' });
      }
    }

    const nextSites: string[] | null = siteIds !== undefined ? await groupSiteIds(siteIds) : null;
    if (nextSites !== null && !managerScopeOk(nextSites)) {
      return res.status(403).json({ message: 'Site managers can only assign their own locations.' });
    }
    // Invariant: any non-admin role (STANDARD or SITE_MANAGER) must keep ≥1 site.
    const effectiveRole = target.is_owner ? 'ADMIN' : (role ?? target.role);
    const effectiveSiteCount = nextSites !== null ? nextSites.length : target._count.site_assignments;
    if (effectiveRole !== 'ADMIN' && effectiveSiteCount === 0) {
      return res.status(400).json({ message: 'A standard or site-manager user must keep at least one location.' });
    }

    // Deactivation lockout guards — the same three DELETE already enforces, for the same reason:
    // an account-disabling action must never be able to lock the tenant out of its own workspace.
    if (isActive === false) {
      if (sessionUserId && id === sessionUserId) {
        return res.status(409).json({ message: 'You cannot deactivate your own account.' });
      }
      if (target.is_owner) {
        return res.status(409).json({ message: 'The owner account cannot be deactivated.' });
      }
      const activeAdmins = await prisma.user.count({ where: { group_id: groupId, is_active: true, role: 'ADMIN' } });
      if (target.role === 'ADMIN' && activeAdmins <= 1) {
        return res.status(409).json({ message: 'This is the last active admin — promote another admin first.' });
      }
    }

    // Primary site (admin-set landing/default) must be one of the user's (effective) assigned sites.
    const effSites = nextSites ?? target.site_assignments.map((a: { site_id: string }) => a.site_id);
    if (primarySiteId !== undefined && primarySiteId && !effSites.includes(primarySiteId)) {
      return res.status(400).json({ message: 'The primary site must be one of the user’s assigned locations.' });
    }

    try {
      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        if (name !== undefined) {
          await tx.user.update({ where: { id }, data: { name: name.trim() || null } });
        }
        // Role change only applies to non-owners (owner stays ADMIN).
        if (role !== undefined && !target.is_owner) {
          await tx.user.update({ where: { id }, data: { role: role as UserRole } });
        }
        if (siteIds !== undefined) {
          const validSites = nextSites as string[];
          await tx.userSite.deleteMany({ where: { user_id: id } });
          if (validSites.length) {
            await tx.userSite.createMany({ data: validSites.map((sid) => ({ user_id: id, site_id: sid })) });
          }
          // Keep the user's active site_id valid: if it's no longer assigned, point at the first assignment.
          const current = await tx.user.findUnique({ where: { id }, select: { site_id: true } });
          if (validSites.length && current && !validSites.includes(current.site_id ?? '')) {
            await tx.user.update({ where: { id }, data: { site_id: validSites[0] } });
          }
        }
        // Primary site: set explicitly (also aligns the home site_id), or clear if a reassignment
        // left the old primary unassigned.
        if (primarySiteId !== undefined) {
          const val = primarySiteId || null;
          await tx.user.update({ where: { id }, data: { primary_site_id: val, ...(val ? { site_id: val } : {}) } });
        } else if (siteIds !== undefined && target.primary_site_id && !(nextSites as string[]).includes(target.primary_site_id)) {
          await tx.user.update({ where: { id }, data: { primary_site_id: null } });
        }
        // Per-user invoice-raising grant (ADMIN-only, guarded above).
        if (canInvoice !== undefined) {
          await tx.user.update({ where: { id }, data: { can_invoice: !!canInvoice } });
        }
        // Deactivate / reactivate (ADMIN-only, lockout-guarded above).
        // Deactivating stamps the revocation floor as well as blocking login: without it a
        // suspended mechanic's 90-day /m cookie would keep working — is_active is only read at
        // SIGN-IN, so it does nothing to a session that already exists. Blocking the front door
        // while leaving the window open is exactly the bug this slice exists to close.
        if (isActive !== undefined) {
          const now = new Date();
          await tx.user.update({
            where: { id },
            data: isActive
              ? { is_active: true, deactivated_at: null }
              : { is_active: false, deactivated_at: now, sessions_valid_from: now },
          });
          await writeUserAudit(tx, {
            groupId,
            actorUserId: sessionUserId,
            targetUserId: id,
            action: isActive ? 'user.reactivated' : 'user.deactivated',
            diff: { email: target.email },
          });
        }
      });
      return res.status(200).json({ message: 'User updated.' });
    } catch (e) {
      console.error('User update error:', e);
      return res.status(500).json({ message: 'Failed to update user.' });
    }
  }

  if (req.method === 'DELETE') {
    const id = (req.query.id as string) || (req.body && (req.body.id as string));
    if (!id) return res.status(400).json({ message: 'Missing id.' });
    const target = await prisma.user.findFirst({ where: { id, group_id: groupId }, select: { id: true, is_owner: true, role: true, site_assignments: { select: { site_id: true } } } });
    if (!target) return res.status(404).json({ message: 'User not found.' });

    // Site managers may only remove STANDARD users at their own sites.
    if (!managerMayTarget(target)) {
      return res.status(403).json({ message: 'Site managers can only remove standard users at their own locations.' });
    }

    // Lockout guards.
    if (sessionUserId && id === sessionUserId) {
      return res.status(409).json({ message: 'You cannot remove your own account.' });
    }
    if (target.is_owner) {
      return res.status(409).json({ message: 'The owner account cannot be removed.' });
    }
    const count = await prisma.user.count({ where: { group_id: groupId } });
    if (count <= 1) {
      return res.status(409).json({ message: 'Cannot remove the last user in the account.' });
    }

    await prisma.user.delete({ where: { id } }); // UserSite rows cascade
    return res.status(200).json({ message: 'User removed.' });
  }

  res.setHeader('Allow', 'POST, PATCH, DELETE');
  return res.status(405).json({ message: 'Method Not Allowed' });
}
