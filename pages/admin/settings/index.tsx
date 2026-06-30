/**
 * File: pages/admin/settings/index.tsx
 * /admin/settings → role-aware landing (routed through getVisibility, so it can't drift from the
 * per-tab gating): STANDARD has only Profile; ADMIN/SITE_MANAGER land on Locations & Resources.
 */
import { GetServerSideProps } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { getVisibility } from '@/lib/site-visibility';

export default function SettingsIndex() {
  return null;
}

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const session = await getServerSession(ctx.req, ctx.res, authOptions);
  const u = session?.user as any;
  if (!u?.id) return { redirect: { destination: '/admin/login', permanent: false } };

  const vis = await getVisibility(u.id as string);
  // STANDARD users only have the Profile tab; everyone else lands on the first tab (Locations).
  const destination = vis.role === 'STANDARD' ? '/admin/settings/profile' : '/admin/settings/locations';
  return { redirect: { destination, permanent: false } };
};
