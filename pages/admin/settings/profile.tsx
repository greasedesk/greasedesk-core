/**
 * File: pages/admin/settings/profile.tsx
 * The standalone Profile tab was dissolved into the Users tab (per-user detail) in the settings
 * restructure. This is a permanent-behaviour redirect shim so old bookmarks / callbacks
 * (e.g. set-password) and ?user=<id> links keep working:
 *   /admin/settings/profile            → /admin/settings/users/<self>
 *   /admin/settings/profile?user=<id>  → /admin/settings/users/<id>
 */
import { GetServerSideProps } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';

export default function ProfileRedirect() {
  return null;
}

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const session = await getServerSession(ctx.req, ctx.res, authOptions);
  const u = session?.user as any;
  if (!u?.id) return { redirect: { destination: '/admin/login', permanent: false } };
  const target = (typeof ctx.query.user === 'string' && ctx.query.user) || (u.id as string);
  return { redirect: { destination: `/admin/settings/users/${target}`, permanent: false } };
};
