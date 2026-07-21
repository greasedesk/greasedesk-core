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
import { requireOperatorApi, requireOperatorPage } from '@/lib/operator-auth';

/** The live dogfood tenant — archive/purge on it needs a SECOND explicit confirmation. */
export const TMBS_GROUP_ID = '854d38e7-6dd4-4836-af61-a0d169639a78';

/**
 * REPOINTED (layer 1): the SAP gate now reads an OPERATOR SESSION (actorClass='operator', its own
 * identity + /superadmin/login), not a tenant User on the PlatformOperator allowlist. These thin
 * wrappers keep the existing callers (tenants page, archive/purge APIs) unchanged — they still get an
 * `operatorUserId` — while the identity underneath is the new Operator. Role-gating of specific
 * lifecycle actions (purge = owner only) lands with the lifecycle layer; today any operator passes,
 * exactly as any allowlisted operator did before. The returned id is now an Operator.id, recorded as
 * SuperAdminAudit.operator_user_id going forward (historical rows keep their old User ids).
 */

/** Page guard: { ok, operatorUserId } or a notFound (404) — never a redirect, never a 403. */
export async function requireSuperAdminPage(ctx: GetServerSidePropsContext): Promise<{ ok: true; operatorUserId: string } | { ok: false; notFound: true }> {
  const g = await requireOperatorPage(ctx);
  return g.ok ? { ok: true, operatorUserId: g.op.userId } : { ok: false, notFound: true };
}

/** API guard: the operator id, or sends 404 and returns null. */
export async function requireSuperAdminApi(req: NextApiRequest, res: NextApiResponse): Promise<string | null> {
  const op = await requireOperatorApi(req, res); // 404 if not an operator session — undiscoverable
  return op ? op.userId : null;
}
