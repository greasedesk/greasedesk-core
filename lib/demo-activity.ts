/**
 * File: lib/demo-activity.ts
 * THE TRACES A PERSON LEFT ON A TENANT IN THE LAST HOUR — the read behind
 * lib/demo-tenants::refuseRefreshWhileActive. Server-only (it reads the database); the rule and its
 * words are the pure half, in lib/demo-tenants.
 *
 * Every trace is a PERSON's: AuditLog rows with a user, messages with a sender, sign-ins. A
 * regeneration writes only to the NEW tenant, so nothing here is the refresh's own noise — the read
 * is always of the OLD group's id.
 */
import type { PrismaClient } from '@prisma/client';
import { ACTIVITY_WINDOW_MINUTES, type TenantActivity } from '@/lib/demo-tenants';

export async function tenantActivity(db: PrismaClient, groupId: string, now: Date = new Date()): Promise<TenantActivity> {
  const since = new Date(now.getTime() - ACTIVITY_WINDOW_MINUTES * 60_000);
  const window = { gte: since, lte: now };
  const [signIn, changes, lastChange, messages, lastMessage, customers, cards, bookings] = await Promise.all([
    db.user.aggregate({ where: { group_id: groupId, last_login_at: window }, _max: { last_login_at: true } }),
    db.auditLog.count({ where: { group_id: groupId, user_id: { not: null }, created_at: window } }),
    db.auditLog.aggregate({ where: { group_id: groupId, user_id: { not: null }, created_at: window }, _max: { created_at: true } }),
    db.notificationLog.count({ where: { group_id: groupId, sent_by_user: { not: null }, created_at: window } }),
    db.notificationLog.aggregate({ where: { group_id: groupId, sent_by_user: { not: null }, created_at: window }, _max: { created_at: true } }),
    db.customer.aggregate({ where: { group_id: groupId, created_at: window }, _count: { _all: true }, _max: { created_at: true } }),
    db.jobCard.aggregate({ where: { group_id: groupId, created_at: window }, _count: { _all: true }, _max: { created_at: true } }),
    db.booking.aggregate({ where: { group_id: groupId, created_at: window }, _count: { _all: true }, _max: { created_at: true } }),
  ]);
  const latestNew = [customers, cards, bookings].map((a) => a._max.created_at).filter((d): d is Date => !!d).sort((x, y) => y.getTime() - x.getTime())[0] ?? null;
  return {
    lastSignIn: signIn._max.last_login_at ?? null,
    personChanges: changes, latestPersonChange: lastChange._max.created_at ?? null,
    messagesByPeople: messages, latestMessage: lastMessage._max?.created_at ?? null,
    newRecords: customers._count._all + cards._count._all + bookings._count._all, latestNewRecord: latestNew,
  };
}
