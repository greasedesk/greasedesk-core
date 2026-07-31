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
import { mintToken } from '@/lib/inbound-address';

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
    // The thread token is minted WITH the thread, so every conversation has a reply address from
    // the moment it exists — there is no window where a thread cannot be replied to.
    data: { group_id: key.groupId, customer_id: key.customerId, vehicle_id: key.vehicleId, thread_token: mintToken() },
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
    where: { thread_id: threadId }, orderBy: { created_at: 'desc' }, select: { created_at: true, direction: true },
  });
  await (db as any).messageThread.update({
    where: { id: threadId },
    // BOTH derived from the log, never authored. last_message_direction === 'in' is precisely what
    // "unresponded" means: the customer spoke last and nobody has answered.
    data: { last_message_at: latest?.created_at ?? null, last_message_direction: latest?.direction ?? null },
  });
}

/**
 * Clearing unread is AN ACT BY A PERSON and is attributed like one. Opening a thread is what does
 * it — there is no bulk "mark all read", because that is a button for making a number go away
 * rather than for having read anything.
 */
export async function markThreadRead(db: Db, threadId: string, userId: string): Promise<void> {
  await (db as any).messageThread.updateMany({
    where: { id: threadId, unread_count: { gt: 0 } },
    data: { unread_count: 0, last_read_at: new Date(), last_read_by: userId },
  });
}

/** Ensure a tenant has an inbound mailbox token. Idempotent; rotatable by nulling and re-calling. */
export async function ensureTenantInboundToken(db: Db, groupId: string): Promise<string> {
  const g = await (db as any).group.findUnique({ where: { id: groupId }, select: { inbound_token: true } });
  if (g?.inbound_token) return g.inbound_token;
  const token = mintToken();
  await (db as any).group.update({ where: { id: groupId }, data: { inbound_token: token } });
  return token;
}

/** Ensure a thread has a reply token (older threads predate the column). Idempotent. */
export async function ensureThreadToken(db: Db, threadId: string): Promise<string> {
  const t = await (db as any).messageThread.findUnique({ where: { id: threadId }, select: { thread_token: true } });
  if (t?.thread_token) return t.thread_token;
  const token = mintToken();
  await (db as any).messageThread.update({ where: { id: threadId }, data: { thread_token: token } });
  return token;
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

/**
 * CAN WE REACH THIS CUSTOMER ON THIS CHANNEL? Resolved from the thread's customer, per channel.
 *
 * HONEST-NULL: "no email on file" is UNKNOWN, not an error and not a fault of the staff member. The
 * compose box reads this BEFORE it lets anyone type, so nobody writes a message that cannot be sent
 * — accepting the text and failing afterwards wastes the words and teaches staff to distrust the box.
 * On TMBS only 36.5% of customers have an email, so this is the common case, not the edge case.
 */
export type Reachability =
  | { ok: true; address: string; customerName: string; channel: NotifyChannelName }
  | { ok: false; reason: string; customerName: string; channel: NotifyChannelName };

export type NotifyChannelName = 'email' | 'sms';

export async function threadReachability(db: Db, threadId: string, channel: NotifyChannelName = 'email'): Promise<Reachability | null> {
  const t = await (db as any).messageThread.findUnique({
    where: { id: threadId },
    select: { customer: { select: { name: true, email: true, phone_e164: true } } },
  });
  if (!t) return null;
  return reachabilityOf(t.customer, channel);
}

/**
 * Reachability for a JOB CARD's current owner, WITHOUT requiring a thread to exist yet.
 *
 * This matters more than it looks. A thread is only created when a message is sent, so keying the
 * compose box on an existing thread would mean you could only write to customers you had already
 * written to — the first message would be impossible. The card resolves its owner through the
 * ownership edge exactly as the thread does, so the box opens on the right customer from the start
 * and the thread is created by the send.
 */
export async function reachabilityForJobCard(db: Db, jobCardId: string, channel: NotifyChannelName = 'email'): Promise<Reachability | null> {
  const key = await threadKeyForJobCard(db, jobCardId);
  if (!key) return null; // no vehicle, or no current ownership edge — nobody to write to
  const customer = await (db as any).customer.findUnique({ where: { id: key.customerId }, select: { name: true, email: true, phone_e164: true } });
  return reachabilityOf(customer, channel);
}

function reachabilityOf(customer: { name?: string | null; email?: string | null; phone_e164?: string | null } | null, channel: NotifyChannelName): Reachability {
  const t = { customer };
  const name = t.customer?.name ?? 'this customer';
  if (channel === 'email') {
    const email = (t.customer?.email ?? '').trim();
    if (!email) return { ok: false, reason: `No email address on file for ${name}. Add one on the Customer Details tab and the message box will open.`, customerName: name, channel };
    return { ok: true, address: email, customerName: name, channel };
  }
  const phone = (t.customer?.phone_e164 ?? '').trim();
  if (!phone) return { ok: false, reason: `No dialable mobile number on file for ${name}.`, customerName: name, channel };
  return { ok: true, address: phone, customerName: name, channel };
}

// ── READ SIDE ─────────────────────────────────────────────────────────────────────────────────────

/** One message as the conversation renders it. */
export type ThreadMessage = {
  id: string;
  at: string;            // ISO
  channel: string;       // 'email' | 'sms'
  direction: 'out' | 'in';
  template: string;
  status: string;        // 'sent' | 'failed' | 'skipped' | 'queued'
  recipient: string;
  subject: string | null;
  error: string | null;
  /** The words a person wrote (free_text only); null for templated sends. */
  body: string | null;
  /** WHO sent it. Null = the system did — a quote, a receipt, the cron. Rendered as such. */
  sentByName: string | null;
};

/**
 * DIRECTION IS NOW A REAL FIELD. It was derived-and-always-outbound while nothing could arrive; the
 * inbound slice added the column, exactly as that comment said it would. An inbound row is ordered
 * by received_at, because created_at is when WE wrote the row, not when the customer sent it.
 */
export async function listThreadMessages(db: Db, threadId: string): Promise<ThreadMessage[]> {
  const rows = await (db as any).notificationLog.findMany({
    where: { thread_id: threadId },
    orderBy: { created_at: 'asc' },
    select: { id: true, created_at: true, channel: true, template: true, status: true, recipient: true, subject: true, error: true, body: true, sent_by_user: true, direction: true, received_at: true },
  });
  // Resolve sender names in one read rather than per row.
  const ids = [...new Set(rows.map((r: any) => r.sent_by_user).filter(Boolean))] as string[];
  const users = ids.length
    ? new Map((await (db as any).user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((u: any) => [u.id, u.name]))
    : new Map<string, string>();
  return rows.map((r: any) => ({
    id: r.id, at: (r.received_at ?? r.created_at).toISOString(), channel: r.channel,
    direction: (r.direction === 'in' ? 'in' : 'out') as 'in' | 'out',
    template: r.template, status: r.status, recipient: r.recipient, subject: r.subject ?? null, error: r.error ?? null,
    body: r.body ?? null,
    sentByName: r.sent_by_user ? (users.get(r.sent_by_user) ?? 'A team member') : null,
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
 * THE NAV COUNT — now UNREAD, as originally intended.
 *
 * It counted open conversations while nothing could arrive, because an unread badge that could only
 * ever read zero is decoration pretending to be information. Inbound makes unread a real number, so
 * the badge means what a badge is supposed to mean. This is the change that makes it honest.
 */
export async function unreadThreadCount(db: Db, groupId: string): Promise<number> {
  const r = await (db as any).messageThread.aggregate({ where: { group_id: groupId }, _sum: { unread_count: true } });
  return r._sum.unread_count ?? 0;
}

/** Conversations where the CUSTOMER spoke last. The point of the whole feature. */
export async function unrespondedThreadCount(db: Db, groupId: string): Promise<number> {
  return (db as any).messageThread.count({ where: { group_id: groupId, last_message_direction: 'in' } });
}

/** Kept for callers that still want it; no longer what the nav shows. */
export async function openThreadCount(db: Db, groupId: string): Promise<number> {
  return (db as any).messageThread.count({ where: { group_id: groupId, state: 'open', last_message_at: { not: null } } });
}
