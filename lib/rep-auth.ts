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
import { prisma } from '@/lib/db';
import { portalSignInPath, type PortalParty } from '@/lib/party-portal';

export type RepPrincipal = { repId: string };

/**
 * Where an unauthenticated visitor is sent. One place, so the root and every page agree — and since
 * the affiliate portal shipped, that place is lib/party-portal: this constant READS the table rather
 * than repeating the string, or there would be two homes for one address and only one of them would
 * be updated the day it moves.
 */
export const REP_SIGN_IN_PATH = portalSignInPath('rep');

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
  // PARTY-AWARE SINCE THE AFFILIATE PORTAL SHIPPED. An affiliate's session carries actorClass 'rep'
  // — they are the same row in the same table — so without the party check an affiliate's cookie
  // would reach the rep APIs: another garage's prospects, somebody else's commission runs. The
  // reverse direction is requireAffiliateApi. Both 404, so neither refusal reveals the other portal.
  return requirePartyApi(req, res, 'rep');
}

/**
 * Page guard. On failure it hands back the exact object the caller should return, so no page
 * re-derives which refusal goes with which reason — one predicate, many callers.
 */
export async function requireRepPage(
  ctx: GetServerSidePropsContext,
): Promise<{ ok: true; rep: RepPrincipal } | { ok: false; result: GetServerSidePropsResult<never> }> {
  // Same widening as requireRepApi, and REP_SIGN_IN_PATH still holds the destination — it is what
  // lib/party-portal returns for 'rep', and the constant stays exported because callers import it.
  return requirePartyPage(ctx, 'rep');
}

/**
 * ── THE PARTY IS PART OF THE AUTHORISATION, AND IT COSTS ONE QUERY ──────────────────────────────
 * A rep and an affiliate carry the SAME actorClass ('rep') because they are the same row in the
 * same table with the same credential. The guards above therefore cannot tell them apart, and
 * before the affiliate portal existed they did not need to: there was one portal.
 *
 * There are two now, on two hosts, showing two different things — a rep sees other garages'
 * prospects and their own commission runs; an affiliate sees their referral code and their bank
 * details. So the guard has to read party_type, and that read IS the authorisation rather than a
 * convenience. One indexed primary-key lookup per page load is the price, and it is the right price.
 *
 * HOST ISOLATION IS NOT RELIED ON. Middleware 404s the other host's paths, so in practice a rep's
 * cookie cannot even arrive at the affiliate portal — session cookies are host-only. The guard does
 * not lean on that, for the same reason requireRepPage does not lean on it today: a guard whose
 * premise lives in another file is a guard that stops being true when that file changes.
 *
 * BOTH DIRECTIONS 404. "You are the wrong kind of party" must not be distinguishable from "there is
 * nothing here", or the refusal tells a rep that an affiliate portal exists and vice versa.
 */
async function partyOf(repId: string): Promise<string | null> {
  const row = await prisma.rep.findUnique({ where: { id: repId }, select: { party_type: true } });
  return row?.party_type ?? null;
}

/**
 * Page guard for ONE party. On failure it hands back the object the caller should return, and the
 * sign-in destination is that party's own — sending an affiliate to /rep/login would be sending
 * them to a host that 404s it.
 */
export async function requirePartyPage(
  ctx: GetServerSidePropsContext,
  party: PortalParty,
): Promise<{ ok: true; rep: RepPrincipal } | { ok: false; result: GetServerSidePropsResult<never> }> {
  const c = classify(await getServerSession(ctx.req, ctx.res, authOptions));
  if (!c.ok) {
    if (c.why === 'no_session') {
      return { ok: false, result: { redirect: { destination: portalSignInPath(party), permanent: false } } };
    }
    return { ok: false, result: { notFound: true } };
  }
  // A SESSION FOR A DELETED REP lands here as null and 404s, which is right: the cookie is valid
  // and the account is gone, so there is nothing to show and nothing to sign in to.
  if ((await partyOf(c.rep.repId)) !== party) return { ok: false, result: { notFound: true } };
  return { ok: true, rep: c.rep };
}

/** API guard for one party. 404 on every failure, for the reason requireRepApi gives. */
export async function requirePartyApi(
  req: NextApiRequest,
  res: NextApiResponse,
  party: PortalParty,
): Promise<RepPrincipal | null> {
  const c = classify(await getServerSession(req, res, authOptions));
  if (!c.ok) { res.status(404).json({ message: 'Not found.' }); return null; }
  if ((await partyOf(c.rep.repId)) !== party) { res.status(404).json({ message: 'Not found.' }); return null; }
  return c.rep;
}

/** The affiliate portal's guards. Named, so a page cannot pass the wrong party by typo. */
export const requireAffiliatePage = (ctx: GetServerSidePropsContext) => requirePartyPage(ctx, 'affiliate');
export const requireAffiliateApi = (req: NextApiRequest, res: NextApiResponse) => requirePartyApi(req, res, 'affiliate');
