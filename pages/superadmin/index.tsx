/**
 * File: pages/superadmin/index.tsx
 * THE Engine Room front door. er.greasedesk.com/ rewrites here (middleware); this decides everything
 * from the SESSION PRINCIPAL, server-side:
 *   • operator session → the role's landing (operatorLanding).
 *   • tenant / rep session (wrong actor class) → 404, as the boundary does elsewhere.
 *   • logged out → RENDER the login form right here, at the bare root (er.greasedesk.com/), so the
 *     address bar never shows /superadmin/login. The login POST is relative, so it still works.
 * Reading the session directly (not requireOperatorPage) is what lets logged-out (→login) and
 * wrong-class (→404) diverge.
 */
import Head from 'next/head';
import type { GetServerSideProps } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { operatorLanding, type OperatorRoleName } from '@/lib/operator-auth';
import OperatorLoginForm from '@/components/engine-room/OperatorLoginForm';

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const session = await getServerSession(ctx.req, ctx.res, authOptions);
  const u = session?.user as any;
  if (u?.actorClass === 'operator' && u.operatorRole) {
    return { redirect: { destination: operatorLanding(u.operatorRole as OperatorRoleName), permanent: false } };
  }
  if (u?.id) return { notFound: true }; // wrong actor class → undiscoverable
  return { props: {} };                 // logged out → render login at the root (below)
};

export default function EngineRoomIndex() {
  return (
    <>
      <Head><title>Engine Room</title><meta name="robots" content="noindex" /></Head>
      <OperatorLoginForm />
    </>
  );
}
