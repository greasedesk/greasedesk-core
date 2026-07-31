/**
 * File: lib/message-threads.ts
 * THE message-thread chokepoint. One conversation per (tenant, customer, vehicle); resolution,
 * creation and reading all go through here so the key can never be derived two different ways.
 *
 * ── HOW THE CUSTOMER IS RESOLVED ────────────────────────────────────────────────────────────────
 * Through the CURRENT VehicleOwnership edge (lib/vehicle-identity::getCurrentOwnerId) — exactly as
 * the job card resolves it. NEVER through JobCard.customer_id: that column is nullable and is not
 * the source of truth for who owns the car. A card whose vehicle has no current edge yields NO
 * thread rather than a guess (ZZ11 GATE is such a card today).
 *
 * ── WHY THE KEY INCLUDES THE CUSTOMER ───────────────────────────────────────────────────────────
 * Ownership transfer has never been performed in this codebase, so keying on (customer, vehicle)
 * versus (vehicle) makes no observable difference on today's data. It will the day transfer lands:
 * the new owner must not inherit the previous owner's messages. The cost of the extra key column now
 * is one index; the cost of discovering it later is a migration of live conversation history.
 *
 * ── WHAT A THREAD IS NOT ────────────────────────────────────────────────────────────────────────
 * It is an INDEX over NotificationLog, not a second log. No body, no recipient, no status lives
 * here. Drop the table and you lose the grouping, never a message.
 */
import type { PrismaClient, Prisma } from '@prisma/client';
import { getCurrentOwnerId } from '@/lib/vehicle-identity';

type Db = PrismaClient | Prisma.TransactionClient;

export type ThreadKey = { groupId: string; customerId: string; vehicleId: string };

/** The states a thread can be in. No per-staff assignment in v1 — a thread belongs to the garage. */
export const THREAD_STATES = ['open', 'resolved'] as const;
export type ThreadState = typeof THREAD_STATES[number];

/**
 * The thread key for a job card: its vehicle, plus the vehicle's CURRENT owner. Returns null when
 * the card has no vehicle or the vehicle has no current ownership edge — an honest "no thread here",
 * never a fabricated one.
 */
export async function threadKeyForJobCard(db: Db, jobCardId: string): Promise<ThreadKey | null> {
  const card = (await (db as any).jobCard.findUnique({
    where: { id: jobCardId },
    select: { group_id: true, vehicle_id: true },
  })) as { group_id: string; vehicle_id: string | null } | null;
  if (!card?.vehicle_id) return null;
  const customerId = await getCurrentOwnerId(db as any, card.vehicle_id);
  if (!customerId) return null;
  return { groupId: card.group_id, customerId, vehicleId: card.vehicle_id };
}

/** The thread key behind an invoice — resolved through its job card, so one rule serves both. */
export async function threadKeyForInvoice(db: Db, invoiceId: string): Promise<ThreadKey | null> {
  const inv = (await (db as any).invoice.findUnique({ where: { id: invoiceId }, select: { job_card_id: true } })) as { job_card_id: string } | null;
  return inv?.job_card_id ? threadKeyForJobCard(db, inv.job_card_id) : null;
}

/**
 * The thread for a NotificationLog row's SUBJECT. The subject is what the message was about, so it
 * is what decides the conversation — not the recipient string, which can be a garage address.
 */
export async function threadKeyForSubject(db: Db, subjectType: string | null, subjectId: string | null): Promise<ThreadKey | null> {
  if (!subjectId) return null;
  if (subjectType === 'job_card') return threadKeyForJobCard(db, subjectId);
  if (subjectType === 'invoice') return threadKeyForInvoice(db, subjectId);
  return null; // 'user' and anything else: staff/operator mail is not a customer conversation
}

/** Find-or-create, idempotent on the unique key. */
export async function ensureThread(db: Db, key: ThreadKey): Promise<string> {
  const where = { group_id_customer_id_vehicle_id: { group_id: key.groupId, customer_id: key.customerId, vehicle_id: key.vehicleId } };
  const existing = await (db as any).messageThread.findUnique({ where, select: { id: true } });
  if (existing) return existing.id;
  const row = await (db as any).messageThread.create({
    data: { group_id: key.groupId, customer_id: key.customerId, vehicle_id: key.vehicleId },
    select: { id: true },
  });
  return row.id;
}

/**
 * Recompute last_message_at from the messages themselves. DERIVED, never authored — if it ever
 * disagrees with the log, the log wins and this is what re-derives it.
 */
export async function touchThread(db: Db, threadId: string): Promise<void> {
  const latest = await (db as any).notificationLog.findFirst({
    where: { thread_id: threadId }, orderBy: { created_at: 'desc' }, select: { created_at: true },
  });
  await (db as any).messageThread.update({ where: { id: threadId }, data: { last_message_at: latest?.created_at ?? null } });
}

/**
 * Attach a just-written message to its thread. Best-effort by design: a threading failure must never
 * fail the send it describes, and NotificationLog is already complete without it.
 */
export async function linkMessageToThread(db: Db, notificationId: string, subjectType: string | null, subjectId: string | null): Promise<string | null> {
  try {
    const key = await threadKeyForSubject(db, subjectType, subjectId);
    if (!key) return null;
    const threadId = await ensureThread(db, key);
    await (db as any).notificationLog.update({ where: { id: notificationId }, data: { thread_id: threadId } });
    await touchThread(db, threadId);
    return threadId;
  } catch {
    return null;
  }
}

// ── READ SIDE ─────────────────────────────────────────────────────────────────────────────────────

/** One message as the conversation renders it. */
export type ThreadMessage = {
  id: string;
  at: string;            // ISO
  channel: string;       // 'email' | 'sms'
  direction: 'out';      // see note below
  template: string;
  status: string;        // 'sent' | 'failed' | 'skipped' | 'queued'
  recipient: string;
  subject: string | null;
  error: string | null;
};

/**
 * DIRECTION IS DERIVED, NOT STORED, and it is always 'out'. There is no inbound path anywhere in the
 * product — no provider webhook, no parse route — so every row in NotificationLog is, by
 * construction, something the garage sent. A stored column would carry no information today and
 * would invite a future reader to trust it before anything populates it. When inbound lands, that
 * slice adds the column and this constant goes.
 */
export async function listThreadMessages(db: Db, threadId: string): Promise<ThreadMessage[]> {
  const rows = await (db as any).notificationLog.findMany({
    where: { thread_id: threadId },
    orderBy: { created_at: 'asc' },
    select: { id: true, created_at: true, channel: true, template: true, status: true, recipient: true, subject: true, error: true },
  });
  return rows.map((r: any) => ({
    id: r.id, at: r.created_at.toISOString(), channel: r.channel, direction: 'out' as const,
    template: r.template, status: r.status, recipient: r.recipient, subject: r.subject ?? null, error: r.error ?? null,
  }));
}

/** The conversation for a job card: its thread (if any) and every message on it, oldest first. */
export async function conversationForJobCard(db: Db, jobCardId: string): Promise<{ threadId: string | null; messages: ThreadMessage[] }> {
  const key = await threadKeyForJobCard(db, jobCardId);
  if (!key) return { threadId: null, messages: [] };
  const t = await (db as any).messageThread.findUnique({
    where: { group_id_customer_id_vehicle_id: { group_id: key.groupId, customer_id: key.customerId, vehicle_id: key.vehicleId } },
    select: { id: true },
  });
  // No thread yet is an EMPTY CONVERSATION, not an error — a car nobody has messaged about is normal.
  if (!t) return { threadId: null, messages: [] };
  return { threadId: t.id, messages: await listThreadMessages(db, t.id) };
}

/**
 * The nav count. OPEN THREADS, not unread messages — and the distinction is deliberate. `unread_count`
 * is inbound-driven and structurally 0 (nothing in the product can receive a message), so a badge
 * reading unread could never be anything but blank: decoration pretending to be information. Open
 * conversations is a real number that changes. See the Messages screen, which says which it is.
 */
export async function openThreadCount(db: Db, groupId: string): Promise<number> {
  return (db as any).messageThread.count({ where: { group_id: groupId, state: 'open', last_message_at: { not: null } } });
}
