/**
 * File: pages/admin/setup-location.tsx
 * Graceful empty state for a VALID session with no location yet (ruling 2026-07-14): a tenant
 * between signup and first-site must NEVER be bounced to /admin/login — that reads as a logout.
 * The site_id guards on job-card/rates/financial pages send a siteless session HERE instead.
 * Central + stale-JWT-safe: it reads fresh DB truth (getVisibility). If the tenant actually has a
 * site (their session JWT is just stale — site_id is only stamped at login), it forwards to the
 * dashboard rather than dead-ending; only a genuinely siteless tenant sees the "add a location" state.
 */
import Head from 'next/head';
import Link from 'next/link';
import { GetServerSideProps } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { getVisibility } from '@/lib/site-visibility';

export default function SetupLocation() {
  return (
    <>
      <Head><title>Add a location — GreaseDesk</title></Head>
      <div className="max-w-xl mx-auto py-16 px-4 text-center">
        <div className="text-4xl mb-4">📍</div>
        <h1 className="text-2xl font-semibold text-ink mb-2">No location set up yet</h1>
        <p className="text-muted mb-6">Your account is ready, but you haven’t added a workshop location. Add one to start booking jobs and raising invoices.</p>
        <Link href="/onboarding/setup" className="inline-block bg-accent hover:bg-accent-hover text-white rounded-lg px-5 py-2.5 text-sm font-medium">
          Add your location
        </Link>
        <p className="mt-4"><Link href="/admin/dashboard" className="text-sm text-muted underline">Back to dashboard</Link></p>
      </div>
    </>
  );
}

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const session = await getServerSession(ctx.req, ctx.res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return { redirect: { destination: '/admin/login', permanent: false } };
  // Fresh DB truth — a stale-JWT session that actually HAS a site is forwarded, never dead-ended here.
  const vis = await getVisibility(user.id as string);
  if (vis.siteIds.length > 0) return { redirect: { destination: '/admin/dashboard', permanent: false } };
  return { props: {} };
};
