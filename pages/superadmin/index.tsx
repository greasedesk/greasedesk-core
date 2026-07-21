/**
 * File: pages/superadmin/index.tsx
 * THE Engine Room front door. er.greasedesk.com/ rewrites here (middleware); this page decides where
 * the visitor goes ENTIRELY from the session principal — server-side, never a request param, reusing
 * the actorClass + operatorRole already on the JWT. It renders nothing; every path is a redirect or
 * a 404:
 *   • operator session  → the role's landing (lib/operator-auth.operatorLanding): owner / country
 *                         manager → the tenants dashboard; support → the read-only overview.
 *   • tenant / rep session (wrong actor class present) → 404 — exactly as the boundary does elsewhere.
 *   • no session (logged out) → the operator login form. This is the ONLY thing a logged-out visitor
 *                               ever sees; nothing distinguishes it from "there is nothing here".
 * Distinguishing logged-out (→ login) from wrong-class (→ 404) is why this reads the session directly
 * rather than requireOperatorPage (which collapses both to notFound).
 */
import type { GetServerSideProps } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { operatorLanding, type OperatorRoleName } from '@/lib/operator-auth';

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const session = await getServerSession(ctx.req, ctx.res, authOptions);
  const u = session?.user as any;

  if (u?.actorClass === 'operator' && u.operatorRole) {
    return { redirect: { destination: operatorLanding(u.operatorRole as OperatorRoleName), permanent: false } };
  }
  // A session that is NOT an operator (tenant/rep) is undiscoverable here — 404, not the login.
  if (u?.id) return { notFound: true };
  // Logged out → the login form, and nothing else.
  return { redirect: { destination: '/superadmin/login', permanent: false } };
};

export default function EngineRoomIndex() {
  return null;
}
