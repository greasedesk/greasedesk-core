/**
 * File: lib/superadmin.ts
 * THE platform-operator gate for /superadmin — entirely separate from tenant authority. It reads
 * the session user id and checks the PlatformOperator allowlist. It does NOT touch getVisibility /
 * admin-guard (those are tenant-scoped, the wrong axis) and shares no code path with them.
 *
 * UNDISCOVERABLE: a non-operator (incl. any tenant ADMIN) gets a 404 — never a 403. A 403 would
 * confirm the portal exists; a tenant must not learn other tenants (or an operator tier) exist.
 */
import type { GetServerSidePropsContext, NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { prisma } from '@/lib/db';

/** The live dogfood tenant — archive/purge on it needs a SECOND explicit confirmation. */
export const TMBS_GROUP_ID = '854d38e7-6dd4-4836-af61-a0d169639a78';

async function operatorId(userId: string | undefined | null): Promise<string | null> {
  if (!userId) return null;
  const op = await prisma.platformOperator.findUnique({ where: { user_id: userId }, select: { user_id: true } });
  return op ? op.user_id : null;
}

/** Page guard: returns { ok, operatorUserId } or a notFound (404) — never a redirect, never a 403. */
export async function requireSuperAdminPage(ctx: GetServerSidePropsContext): Promise<{ ok: true; operatorUserId: string } | { ok: false; notFound: true }> {
  const session = await getServerSession(ctx.req, ctx.res, authOptions);
  const uid = (session?.user as any)?.id as string | undefined;
  const opId = await operatorId(uid);
  if (!opId) return { ok: false, notFound: true };
  return { ok: true, operatorUserId: opId };
}

/** API guard: returns the operator user id, or sends 404 and returns null. */
export async function requireSuperAdminApi(req: NextApiRequest, res: NextApiResponse): Promise<string | null> {
  const session = await getServerSession(req, res, authOptions);
  const uid = (session?.user as any)?.id as string | undefined;
  const opId = await operatorId(uid);
  if (!opId) { res.status(404).json({ message: 'Not found.' }); return null; } // 404, not 403 — undiscoverable
  return opId;
}
