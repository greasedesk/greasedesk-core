/**
 * File: pages/api/superadmin/programme-settings.ts
 * THE write surface for the ProgrammeSettings singleton. OWNER-ONLY, server-enforced: a non-owner
 * gets 404, never a 403 that would confirm the screen exists — same undiscoverability as operators
 * and rates.
 *
 * Today it carries one field: the TRIAL LENGTH. That number used to be two hard-coded constants
 * and seven lines of marketing copy; changing it meant a code change and a deploy, which is why it
 * had been 60 for a year while the only email that mentioned a number said 30. It is one integer
 * now, and this route is the only thing that may write it.
 *
 * THE REVALIDATION IS NOT OPTIONAL and does not live in the caller: lib/programme-settings'
 * saveTrialDays does the validation, the audit row and the refresh of the public copy together, so
 * there is no order of operations in which the setting changes and greasedesk.com does not.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { requireOperatorApi } from '@/lib/operator-auth';
import { getProgrammeSettings, saveTrialDays, refuseTrialLength, PUBLIC_COPY_PATHS } from '@/lib/programme-settings';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  const actor = await requireOperatorApi(req, res);
  if (!actor) return;
  if (actor.role !== 'owner') { res.status(404).json({ message: 'Not found.' }); return; }

  if (req.method === 'GET') {
    const s = await getProgrammeSettings(prisma);
    // WHO CHANGED IT AND WHEN comes from the audit log, not from columns on the row: the audit is
    // append-only and already answers "and what was it before?", which a pair of columns cannot.
    const last = await prisma.superAdminAudit.findFirst({
      where: { action: 'programme_trial_days' },
      orderBy: { created_at: 'desc' },
      select: { created_at: true, target_ref_snapshot: true, operator_user_id: true },
    }).catch(() => null);
    // SuperAdminAudit carries operator_user_id as a plain column, with no relation declared — the
    // name is looked up, not joined. A deleted operator leaves the row intact and unattributed,
    // which is the correct answer for an append-only log: the action happened, the person is gone.
    //
    // IT IS AN Operator ID, NOT A User ID, despite the column's name. This read looked in `user`
    // first and every change came back attributed to "an operator no longer on the system" — a
    // sentence that is never wrong enough to look wrong. Caught only by driving the real screen.
    const by = last?.operator_user_id
      ? await prisma.operator.findUnique({ where: { id: last.operator_user_id }, select: { name: true, email: true } }).catch(() => null)
      : null;
    res.status(200).json({
      trialDays: s.trial_days,
      publicPaths: PUBLIC_COPY_PATHS,
      copyRevalidatedAt: s.copy_revalidated_at ? s.copy_revalidated_at.toISOString() : null,
      copyRevalidateError: s.copy_revalidate_error,
      lastChange: last ? {
        at: last.created_at.toISOString(),
        by: by?.name || by?.email || 'an operator no longer on the system',
        what: last.target_ref_snapshot,
      } : null,
    });
    return;
  }

  if (req.method === 'PATCH') {
    const days = Number((req.body ?? {}).trialDays);
    const refusal = refuseTrialLength(days);
    if (refusal) { res.status(400).json({ message: refusal }); return; }
    const result = await saveTrialDays(prisma, {
      days,
      actorId: actor.userId,
      // res.revalidate is the Next on-demand hook. It is handed in rather than imported because it
      // belongs to this response; the gate hands in its own.
      revalidate: (p) => res.revalidate(p),
    });
    res.status(200).json({
      message: result.revalidateError
        ? `Saved: new garages now get ${result.days} days. BUT THE PUBLIC SITE WAS NOT REFRESHED — ${result.revalidateError}. It will correct itself within the hour, or save again to retry.`
        : `Saved. New garages now get ${result.days} days, and the public pages were refreshed.`,
      ...result,
    });
    return;
  }

  res.setHeader('Allow', ['GET', 'PATCH']);
  res.status(405).json({ message: 'Method not allowed.' });
}
