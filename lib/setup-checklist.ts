/**
 * File: lib/setup-checklist.ts
 * The OPTIONAL post-signup checklist (item-13) — things a new owner should do but that are NOT in the
 * required onboarding gate (the app degrades gracefully without them; forcing them into signup would
 * cost conversion for no functional reason). Derived done-flags (no stored flag), same discipline as
 * the onboarding gate. Surfaced on the dashboard; each item says WHY it matters and links to where
 * it's done. Add an item = add a row here + its i18n keys.
 *
 * Resources/lifts is the motivating case: a job card can be created with no resource, but the DIARY
 * is unusable until at least one lift/bay exists — so it's flagged "needed to schedule jobs".
 */
import { prisma } from '@/lib/db';

export type SetupChecklistItem = {
  key: string;       // i18n key + stable id
  done: boolean;     // derived
  href: string;      // where to complete it
};

export async function getSetupChecklist(groupId: string, primarySiteId: string | null): Promise<SetupChecklistItem[]> {
  const [resourceCount, userCount] = await Promise.all([
    prisma.resource.count({ where: { site: { group_id: groupId } } }),
    prisma.user.count({ where: { group_id: groupId } }),
  ]);

  const diaryHref = primarySiteId ? `/admin/diary?site=${encodeURIComponent(primarySiteId)}` : '/admin/diary';

  return [
    // Needed to schedule jobs in the diary (the diary empty-state also offers an inline add).
    { key: 'resources', done: resourceCount > 0, href: diaryHref },
    // The owner is user #1; >1 means at least one teammate has been added/invited.
    { key: 'team', done: userCount > 1, href: '/admin/settings/users' },
  ];
}
