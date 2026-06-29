/**
 * File: lib/admin-guard.ts
 * ONE chokepoint for admin-only access — built on getVisibility (single source of truth).
 *   requireAdminPage(ctx) → for getServerSideProps of admin-only pages (redirects non-admins).
 *   requireAdminApi(req,res) → for admin-only API routes (sends 401/403, returns null if blocked).
 * Use these instead of scattered inline role checks so a missed page/endpoint can't recur.
 */
import type { GetServerSidePropsContext } from 'next';
import type { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { getVisibility, type Visibility } from '@/lib/site-visibility';

type RedirectResult = { ok: false; redirect: { destination: string; permanent: boolean } };

export async function requireAdminPage(
  ctx: GetServerSidePropsContext
): Promise<{ ok: true; vis: Visibility } | RedirectResult> {
  const session = await getServerSession(ctx.req, ctx.res, authOptions);
  const u = session?.user as any;
  if (!u?.id) return { ok: false, redirect: { destination: '/admin/login', permanent: false } };
  const vis = await getVisibility(u.id as string);
  if (!vis.isAdmin) return { ok: false, redirect: { destination: '/admin/dashboard', permanent: false } };
  return { ok: true, vis };
}

export async function requireAdminApi(req: NextApiRequest, res: NextApiResponse): Promise<Visibility | null> {
  const session = await getServerSession(req, res, authOptions);
  const u = session?.user as any;
  if (!u?.id) { res.status(401).json({ message: 'Not authenticated.' }); return null; }
  const vis = await getVisibility(u.id as string);
  if (!vis.isAdmin) { res.status(403).json({ message: 'Admin access required.' }); return null; }
  return vis;
}
