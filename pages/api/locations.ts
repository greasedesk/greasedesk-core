/**
 * File: pages/api/locations.ts
 * Locations = Sites. Tenant-scoped to the caller's group.
 *
 *   GET                                   → { currentSiteId, locations: [{id, site_name}] }
 *   POST   { site_name, address? }        → create a Location (Site) in the caller's group
 *   PATCH  { id, site_name?, address?, is_active? } → update a Location
 *   DELETE { id }                         → delete a Location (guarded; empty locations only)
 *
 * NOTE (billing): a Site is a billable unit (see CLAUDE.md — "Billing is driven by site count").
 * Creating/removing a Location should adjust the Group's billing when the billing module exists.
 * The hooks are marked with TODO(billing) below. No billing is implemented here.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { getVisibility } from '@/lib/site-visibility';
import { getTenantPermissions, canViewInvoices } from '@/lib/permissions';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) {
    return res.status(401).json({ message: 'Not authenticated.' });
  }
  const groupId = user.group_id as string;
  const currentSiteId = (user.site_id as string) ?? null;
  const vis = await getVisibility(user.id as string); // visible sites + admin-ness

  // A Site is in scope only if the caller may see it (ADMIN → all group sites; STANDARD → assigned).
  async function visibleSite(id: string) {
    if (!id || !vis.siteIds.includes(id)) return null;
    return prisma.site.findFirst({ where: { id, group_id: groupId }, select: { id: true } });
  }

  if (req.method === 'GET') {
    const sites = await prisma.site.findMany({
      where: { group_id: groupId, id: { in: vis.siteIds } }, // visible only
      orderBy: { site_name: 'asc' },
      select: { id: true, site_name: true },
    });
    // primarySiteId drives the nav's default-location highlight when no ?site is set.
    // canViewInvoices gates the Invoices nav item (the page + API re-check server-side).
    const perms = await getTenantPermissions(groupId);
    return res.status(200).json({ currentSiteId, primarySiteId: vis.primarySiteId, locations: sites, canViewInvoices: canViewInvoices(vis, perms) });
  }

  if (req.method === 'POST') {
    // Creating a new (billable) location is an ADMIN-only action.
    if (!vis.isAdmin) return res.status(403).json({ message: 'Only an admin can add a location.' });
    const { site_name, address } = (req.body || {}) as { site_name?: string; address?: string };
    const cleanName = (site_name || '').trim();
    if (!cleanName) return res.status(400).json({ message: 'Location name is required.' });

    const created = await prisma.site.create({
      data: { group_id: groupId, site_name: cleanName, address: address?.trim() || null },
      select: { id: true },
    });

    // TODO(billing): a new Site is a billable unit. When the billing module exists, increment
    // the Group's active site count / re-rate the subscription here (and reflect it on the
    // Licences & Subscriptions page). See CLAUDE.md "Group = tenant = billing entity".

    return res.status(201).json({ id: created.id, message: 'Location created.' });
  }

  if (req.method === 'PATCH') {
    // Editing a location (a billable unit) is admin/owner-only — site managers manage resources, not locations.
    if (!vis.isAdmin) return res.status(403).json({ message: 'Only an admin can edit a location.' });
    const { id, site_name, address, is_active } = (req.body || {}) as {
      id?: string; site_name?: string; address?: string; is_active?: boolean;
    };
    if (!id) return res.status(400).json({ message: 'Missing id.' });
    if (!(await visibleSite(id))) return res.status(404).json({ message: 'Location not found.' });

    const data: any = {};
    if (site_name !== undefined) {
      const cleanName = site_name.trim();
      if (!cleanName) return res.status(400).json({ message: 'Location name cannot be empty.' });
      data.site_name = cleanName;
    }
    if (address !== undefined) data.address = address.trim() || null;
    if (is_active !== undefined) data.is_active = !!is_active;

    await prisma.site.update({ where: { id }, data });
    return res.status(200).json({ message: 'Location updated.' });
  }

  if (req.method === 'DELETE') {
    // Deleting a location (a billable unit) is admin/owner-only.
    if (!vis.isAdmin) return res.status(403).json({ message: 'Only an admin can delete a location.' });
    const id = (req.query.id as string) || (req.body && (req.body.id as string));
    if (!id) return res.status(400).json({ message: 'Missing id.' });
    if (!(await visibleSite(id))) return res.status(404).json({ message: 'Location not found.' });

    if (id === currentSiteId) {
      return res.status(409).json({ message: 'You cannot delete the location you are currently signed in to.' });
    }
    const siteCount = await prisma.site.count({ where: { group_id: groupId } });
    if (siteCount <= 1) {
      return res.status(409).json({ message: 'Cannot delete the only location in the account.' });
    }

    // Guard: only empty locations can be removed (job cards/bookings have NoAction FKs; customers cascade).
    const [jobCards, bookings, customers] = await Promise.all([
      prisma.jobCard.count({ where: { site_id: id } }),
      prisma.booking.count({ where: { site_id: id } }),
      prisma.customer.count({ where: { site_id: id } }),
    ]);
    if (jobCards > 0 || bookings > 0 || customers > 0) {
      return res.status(409).json({
        message: `Cannot delete: location has ${jobCards} job card(s), ${bookings} booking(s), ${customers} customer(s). Deactivate it instead.`,
      });
    }

    // Resources / profit centres / features / services on the site cascade-delete.
    await prisma.site.delete({ where: { id } });

    // TODO(billing): removing a Site reduces billable units — adjust the Group's billing here
    // when the billing module exists.

    return res.status(200).json({ message: 'Location deleted.' });
  }

  res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
  return res.status(405).json({ message: 'Method Not Allowed' });
}
