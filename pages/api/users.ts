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

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  const sessionUser = session?.user as any;
  if (!sessionUser?.id || !sessionUser?.group_id || !sessionUser?.site_id) {
    return res.status(401).json({ message: 'Authentication Error: Group/Site context not found.' });
  }
  const groupId = sessionUser.group_id as string;
  const sessionSiteId = sessionUser.site_id as string;
  const sessionUserId = sessionUser.id as string;

  // STEP 3: user management is ADMIN-only. A STANDARD caller is refused (also makes STANDARD
  // users anchored — they cannot reassign themselves because they cannot call this API).
  const callerVis = await getVisibility(sessionUserId);
  if (!callerVis.isAdmin) {
    return res.status(403).json({ message: 'Only an admin can manage users.' });
  }

  // Keep only site ids that belong to the caller's group.
  async function groupSiteIds(ids: string[]): Promise<string[]> {
    if (!Array.isArray(ids) || ids.length === 0) return [];
    const rows = await prisma.site.findMany({ where: { id: { in: ids }, group_id: groupId }, select: { id: true } });
    return (rows as Array<{ id: string }>).map((r) => r.id);
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
    const defaultSite = validSites[0] ?? sessionSiteId;

    try {
      const created = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const u = await tx.user.create({
          data: {
            name: cleanName || null,
            email: cleanEmail,
            group_id: groupId,
            site_id: defaultSite,
            role: 'STANDARD',            // invited/added users default to STANDARD; ADMIN is granted via edit
            is_active: false,            // pending — matches existing invite stub
            passwordHash: 'INVITE_PENDING',
          },
          select: { id: true },
        });
        if (validSites.length) {
          await tx.userSite.createMany({ data: validSites.map((sid) => ({ user_id: u.id, site_id: sid })) });
        }
        return u;
      });
      // NOTE: invite email is intentionally NOT sent yet (stub, matches current behaviour).
      return res.status(201).json({ id: created.id, message: 'User created (pending — no email sent).' });
    } catch (e) {
      console.error('User create error:', e);
      return res.status(500).json({ message: 'Failed to create user.' });
    }
  }

  if (req.method === 'PATCH') {
    const { id, name, siteIds, role } = (req.body || {}) as { id?: string; name?: string; siteIds?: string[]; role?: string };
    if (!id) return res.status(400).json({ message: 'Missing id.' });
    const target = await prisma.user.findFirst({
      where: { id, group_id: groupId },
      select: { id: true, is_owner: true, role: true, _count: { select: { site_assignments: true } } },
    });
    if (!target) return res.status(404).json({ message: 'User not found.' });

    if (role !== undefined) {
      if (role !== 'ADMIN' && role !== 'STANDARD') {
        return res.status(400).json({ message: 'Role must be ADMIN or STANDARD.' });
      }
      // Owner is immutable: locked to ADMIN, cannot be demoted.
      if (target.is_owner && role !== 'ADMIN') {
        return res.status(409).json({ message: 'The owner account is locked to ADMIN and cannot be demoted.' });
      }
    }

    // STEP 4 invariant: a STANDARD user must always keep ≥1 site.
    const effectiveRole = target.is_owner ? 'ADMIN' : (role ?? target.role);
    const nextSites: string[] | null = siteIds !== undefined ? await groupSiteIds(siteIds) : null;
    const effectiveSiteCount = nextSites !== null ? nextSites.length : target._count.site_assignments;
    if (effectiveRole === 'STANDARD' && effectiveSiteCount === 0) {
      return res.status(400).json({ message: 'A standard user must keep at least one location.' });
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
    const target = await prisma.user.findFirst({ where: { id, group_id: groupId }, select: { id: true, is_owner: true } });
    if (!target) return res.status(404).json({ message: 'User not found.' });

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
