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
import {
  getProgrammeSettings, saveTrialDays, refuseTrialLength,
  PUBLIC_COPY_PAGES, revalidationTargets, readPublicCopy, publicOrigin,
} from '@/lib/programme-settings';

/**
 * WHICH SITE TO READ BACK — and it is NEVER the host this request came in on.
 *
 * That is the whole lesson of 2026-10-25. This screen is served from er.greasedesk.com, which
 * middleware declares is the Engine Room and nothing else: `/` there is rewritten to /superadmin
 * and `/pricing` is a 404. A refresh aimed at that host, or a read-back of it, is addressing a
 * different site that has none of these pages on it.
 *
 * Production: the apex, from lib/company-info, which is the one place the site's own address
 * lives. Development: the SAME dev server, but addressed as the tenant host rather than the
 * Engine Room one — localhost on this request's port. The first draft used req.headers.host here
 * and the gate went red exactly as production had, which is the clause earning its keep.
 */
const originFor = (req: NextApiRequest): string => {
  if (process.env.NODE_ENV === 'production') return publicOrigin();
  const port = (req.headers.host ?? '').split(':')[1] || '3010';
  return `http://localhost:${port}`;
};

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
    // ── THE LIVE READ IS A SEPARATE CALL ────────────────────────────────────────────────────
    // ?check=1 goes and reads the public site. It is NOT folded into the main GET: that read is
    // two HTTP round trips to another host, and putting it in front of the screen makes a settings
    // page take seconds to appear in exchange for an answer the operator has not asked for yet.
    // The screen loads, then asks.
    if (req.query.check) {
      const checks = await readPublicCopy(originFor(req), s.trial_days);
      res.status(200).json({
        trialDays: s.trial_days,
        publicCopy: checks,
        publicAgrees: checks.length > 0 && checks.every((c) => c.agrees),
      });
      return;
    }
    res.status(200).json({
      trialDays: s.trial_days,
      publicPaths: PUBLIC_COPY_PAGES,
      revalidationTargets: revalidationTargets(),
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
      origin: originFor(req),
    });
    // THE MESSAGE NO LONGER CLAIMS A REFRESH IT HAS NOT SEEN. "the public pages were refreshed" was
    // printed on the strength of res.revalidate() not throwing, and it was wrong for an hour.
    res.status(200).json({
      message: result.verified
        ? `Saved, and the public pages now show ${result.days} days.`
        : result.revalidateError
          ? `Saved: new garages now get ${result.days} days. THE PUBLIC SITE WAS NOT REFRESHED — ${result.revalidateError}. It corrects itself within the minute, or save again to retry.`
          : `Saved: new garages now get ${result.days} days. NOT YET CONFIRMED ON THE PUBLIC SITE — ${result.note}. Reload this screen in a moment; it corrects itself within the minute.`,
      ...result,
    });
    return;
  }

  res.setHeader('Allow', ['GET', 'PATCH']);
  res.status(405).json({ message: 'Method not allowed.' });
}
