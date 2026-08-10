/**
 * File: pages/api/cron/demo-lifecycle.ts
 * The demo clock: email the owner on the last day, purge the day after. CRON_SECRET-guarded;
 * ?dryRun=1 reports exactly what it would do and writes nothing.
 *
 * ── THE PREDICATE IS THE WHOLE SAFETY STORY ─────────────────────────────────────────────────────
 * Only tenants with `is_demo` AND a NON-NULL `demo_expires_at` IN THE PAST are purged, and that
 * test lives in lib/demo-lifecycle rather than in this query, so the banner, the email and the
 * deletion cannot drift apart. A null expiry — the long-lived sales demo — is invisible to this
 * endpoint at every stage. The failure mode of a missing expiry is therefore an immortal demo,
 * which somebody notices in the Engine Room; the opposite mistake deletes a customer's garage.
 *
 * ── THE REMINDER IS IDEMPOTENT WITHOUT A NEW COLUMN ─────────────────────────────────────────────
 * "Have we already warned them?" is answered by NotificationLog — a row for this group with this
 * template. That table is the record of what was sent, so asking it is asking the only thing that
 * actually knows; a `demo_warned_at` column would be a second answer to the same question, free to
 * disagree the first time a send fails after the flag is written.
 *
 * ── PURGE IS THE EXISTING CHOKEPOINT, UNTOUCHED ─────────────────────────────────────────────────
 * purgeTenant cancels Stripe first (a demo has no subscription, so it is a no-op), clears R2, and
 * sweeps the subject-keyed tables — including the phone numbers the generator invented. Nothing
 * about a demo justifies a second deletion path.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { purgeTenant } from '@/lib/tenant-purge';
import { sendNotification } from '@/lib/notify';
import { demoLifecycle, isPurgeable, demoExpiredLoginUrl, DEMO_EXPIRY_TEMPLATE } from '@/lib/demo-lifecycle';
import { COMPANY } from '@/lib/company-info';

const OPERATOR = 'cron:demo-lifecycle';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ message: 'Unauthorized.' });

  const dryRun = String(req.query.dryRun ?? '') === '1';
  const now = new Date();

  // EVERY demo, then filtered by the shared rule — not a clever where-clause. The population is
  // tiny, and a predicate written twice is a predicate that will eventually mean two things.
  const demos = (await prisma.group.findMany({
    where: { is_demo: true },
    select: { id: true, group_name: true, ref: true, demo_expires_at: true, is_demo: true },
  })) as Array<{ id: string; group_name: string; ref: string | null; demo_expires_at: Date | null; is_demo: boolean }>;

  const emailed: string[] = [];
  const purged: string[] = [];
  const skipped: Array<{ name: string; why: string }> = [];

  for (const g of demos) {
    const life = demoLifecycle(g, now);

    if (life.phase === 'none') { skipped.push({ name: g.group_name, why: 'no expiry — never expires' }); continue; }

    // ── PURGE ────────────────────────────────────────────────────────────────────────────────
    if (isPurgeable(g, now)) {
      if (dryRun) { purged.push(`${g.group_name} (would purge)`); continue; }
      try {
        const r = await purgeTenant(OPERATOR, g.id);
        const left = Object.entries(r.after).filter(([, n]) => (n as number) > 0);
        purged.push(`${g.group_name}${left.length ? ` (LEFTOVER ${JSON.stringify(left)})` : ''}`);
      } catch (e: any) {
        // A purge that cannot confirm Stripe aborts by design. Record it and move on — one stuck
        // tenant must not stop the sweep reaching the others.
        skipped.push({ name: g.group_name, why: `purge failed: ${String(e?.message ?? e).slice(0, 120)}` });
      }
      continue;
    }

    // ── THE LAST-DAY EMAIL ───────────────────────────────────────────────────────────────────
    if (life.phase === 'final') {
      const already = await prisma.notificationLog.count({
        where: { group_id: g.id, template: DEMO_EXPIRY_TEMPLATE },
      });
      if (already > 0) { skipped.push({ name: g.group_name, why: 'already emailed' }); continue; }

      const owner = await prisma.user.findFirst({
        where: { group_id: g.id, is_owner: true }, select: { email: true, name: true },
      });
      if (!owner) { skipped.push({ name: g.group_name, why: 'no owner to email' }); continue; }
      if (dryRun) { emailed.push(`${g.group_name} → ${owner.email} (would email)`); continue; }

      const when = life.expiresAt
        ? life.expiresAt.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })
        : 'tomorrow';
      const sent = await sendNotification({
        groupId: g.id, channel: 'email', template: DEMO_EXPIRY_TEMPLATE, recipient: owner.email,
        subject: { type: 'user', id: g.id },
        data: { name: owner.name ?? 'there', when, link: demoExpiredLoginUrl(COMPANY.siteUrl) },
      });
      emailed.push(`${g.group_name} → ${owner.email} (${sent.status})`);
      continue;
    }

    skipped.push({ name: g.group_name, why: `${life.phase}, ${life.daysLeft} day(s) left` });
  }

  return res.status(200).json({ ok: true, dryRun, now: now.toISOString(), demos: demos.length, emailed, purged, skipped });
}
