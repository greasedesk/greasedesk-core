/**
 * File: lib/rep-auth.ts
 * THE rep guard — layer 1. Reps are their own authenticated class (actorClass='rep'), never tenant
 * Users and never operators.
 *
 * ── TWO FAILURES, AND THEY ARE NOT THE SAME FAILURE ─────────────────────────────────────────────
 * This returned notFound for both, and that cost the front door: reps.greasedesk.com rewrites '/'
 * to /rep, /rep refused anyone without a session, and a rep typing the bare domain — which is what
 * they will type — got a 404 on the way in.
 *
 *   NO SESSION      → send them to sign in. There is nothing secret about the rep portal ON THE REP
 *                     HOST: the host IS the door, and a rep who is simply not signed in yet is the
 *                     ordinary case, not an intruder. Refusing them is refusing the product.
 *   WRONG CLASS     → 404, undiscoverable, unchanged. A tenant or an operator must not learn the
 *                     rep portal exists. In practice a tenant cookie cannot even arrive here —
 *                     session cookies are host-only — but the guard does not rely on that.
 *
 * "Not yet" and "not ever" are different refusals and must read differently; that is the same rule
 * the outbox applies with 409 against 400, and the same one three-state columns apply to nulls.
 *
 * THE SESSION IS READ HERE, WHERE IT WAS ALREADY BEING READ. Nothing moved into middleware: a JWT
 * decrypt on every request to decide a rewrite would be a real per-request cost for a decision this
 * layer already has the answer to.
 *
 * The agreement gate (a rep sees nothing until signed) lands in the rep-portal layer; this guard
 * only proves the caller IS an active rep.
 */
import type { GetServerSidePropsContext, GetServerSidePropsResult, NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';

export type RepPrincipal = { repId: string };

/** Where an unauthenticated visitor is sent. One place, so the root and every page agree. */
export const REP_SIGN_IN_PATH = '/rep/login';

type RepFailure = 'no_session' | 'wrong_class';

function classify(session: any): { ok: true; rep: RepPrincipal } | { ok: false; why: RepFailure } {
  const u = session?.user;
  // NO USER AT ALL is "not signed in". A session whose jwt callback stripped the token (a revoked
  // or expired rep session — see the 24-hour floor) also lands here, which is right: they need to
  // sign in again, not to be told the portal does not exist.
  if (!u?.id) return { ok: false, why: 'no_session' };
  if (u.actorClass !== 'rep') return { ok: false, why: 'wrong_class' };
  return { ok: true, rep: { repId: (u.repId ?? u.id) as string } };
}

/**
 * API guard: the rep principal, or 404 and null.
 *
 * BOTH FAILURES STAY 404 HERE, deliberately. An API has no user to redirect and a 302 to an HTML
 * login page is a response no fetch() caller can do anything sensible with. The page guard is where
 * the distinction belongs, because a page can act on it.
 */
export async function requireRepApi(req: NextApiRequest, res: NextApiResponse): Promise<RepPrincipal | null> {
  const c = classify(await getServerSession(req, res, authOptions));
  if (!c.ok) { res.status(404).json({ message: 'Not found.' }); return null; }
  return c.rep;
}

/**
 * Page guard. On failure it hands back the exact object the caller should return, so no page
 * re-derives which refusal goes with which reason — one predicate, many callers.
 */
export async function requireRepPage(
  ctx: GetServerSidePropsContext,
): Promise<{ ok: true; rep: RepPrincipal } | { ok: false; result: GetServerSidePropsResult<never> }> {
  const c = classify(await getServerSession(ctx.req, ctx.res, authOptions));
  if (c.ok) return { ok: true, rep: c.rep };
  if (c.why === 'no_session') {
    return { ok: false, result: { redirect: { destination: REP_SIGN_IN_PATH, permanent: false } } };
  }
  return { ok: false, result: { notFound: true } };
}
