/**
 * File: lib/rep-auth.ts
 * THE rep (field-sales PWA) guard — layer 1. Reps are their own authenticated class
 * (actorClass='rep'), never tenant Users or operators. Wrong actor class → 404 (undiscoverable,
 * same discipline as the operator/superadmin guards): a tenant or operator hitting /rep must not
 * learn the rep portal exists. The agreement gate (a rep sees nothing until signed) lands in the
 * rep-portal layer; this guard only proves the caller IS an active rep.
 */
import type { GetServerSidePropsContext, NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';

export type RepPrincipal = { repId: string };

function repFrom(session: any): RepPrincipal | null {
  const u = session?.user;
  if (!u?.id || u.actorClass !== 'rep') return null;
  return { repId: (u.repId ?? u.id) as string };
}

/** API guard: the rep principal, or 404 and null. */
export async function requireRepApi(req: NextApiRequest, res: NextApiResponse): Promise<RepPrincipal | null> {
  const rep = repFrom(await getServerSession(req, res, authOptions));
  if (!rep) { res.status(404).json({ message: 'Not found.' }); return null; }
  return rep;
}

/** Page guard: { ok, rep } or a notFound (404). */
export async function requireRepPage(ctx: GetServerSidePropsContext): Promise<{ ok: true; rep: RepPrincipal } | { ok: false; notFound: true }> {
  const rep = repFrom(await getServerSession(ctx.req, ctx.res, authOptions));
  if (!rep) return { ok: false, notFound: true };
  return { ok: true, rep };
}
