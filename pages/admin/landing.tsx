/**
 * File: pages/admin/landing.tsx
 * Role-based landing router (no UI — gssp redirect only): ADMIN → the dashboard;
 * SITE_MANAGER / STANDARD → the diary scoped to their primary site (getVisibility already falls
 * back to the first assigned site when no primary is set). A start page, never a restriction —
 * everyone keeps full nav access.
 */
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { getVisibility } from '@/lib/site-visibility';
import type { GetServerSideProps } from 'next';

export default function Landing() { return null; }

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const session = await getServerSession(ctx.req, ctx.res, authOptions);
  const user = session?.user as any;
  if (!user?.id) return { redirect: { destination: '/admin/login', permanent: false } };
  const vis = await getVisibility(user.id as string);
  if (vis.isAdmin) return { redirect: { destination: '/admin/dashboard', permanent: false } };
  const site = vis.primarySiteId ?? vis.siteIds[0] ?? null;
  return { redirect: { destination: site ? `/admin/diary?site=${encodeURIComponent(site)}` : '/admin/diary', permanent: false } };
};
