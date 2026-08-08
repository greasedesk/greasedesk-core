/**
 * File: pages/api/messages/send.ts
 * Staff compose on a thread. POST { threadId, body, channel? } sends; GET ?threadId= re-reads the
 * thread so the screen can render WHAT THE LOG SAYS rather than what it hoped happened.
 *
 * NO NEW SEND PATH. This calls sendNotification like everything else — which means the
 * contact-preference refusal, the NotificationLog row and the threading all apply here for free,
 * because they live in the chokepoint and not in the callers.
 *
 * CHANNEL IS AN ARGUMENT, defaulting to email. SMS needs no restructuring here: the template already
 * has an sms renderer, and an SMS send today is recorded as `skipped` by the unconfigured adapter —
 * refused for the right reason (no provider), never silently dropped.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { Prisma } from '@prisma/client';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { sendNotification } from '@/lib/notify';
import { writeThreadAudit } from '@/lib/audit';
import { resolveReplyTo } from '@/lib/reply-to';
import { listThreadMessages, threadReachability, reachabilityForJobCard, threadKeyForJobCard, ensureThread, ensureThreadToken, type NotifyChannelName } from '@/lib/message-threads';
import { hasModule } from '@/lib/modules';

const MAX_BODY = 2000;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });
  const groupId = user.group_id as string;

  // TWO WAYS IN. A thread id when the conversation exists; a JOB CARD id when it does not yet —
  // otherwise you could only write to customers you had already written to, and the first message
  // would be impossible. Either way the thread is resolved through the ownership edge.
  const src = req.method === 'GET' ? req.query : (req.body ?? {});
  const threadId = String(src.threadId ?? '');
  const jobCardId = String(src.jobCardId ?? '');
  if (!threadId && !jobCardId) return res.status(400).json({ message: 'Missing threadId or jobCardId.' });

  // TENANT SCOPE on whichever key arrived — anything from another tenant is a 404, never a read.
  let thread = threadId
    ? await prisma.messageThread.findFirst({ where: { id: threadId, group_id: groupId }, select: { id: true, vehicle: { select: { registration: true } } } })
    : null;
  let card: { id: string; vehicle: { registration: string | null } | null } | null = null;
  if (!thread && jobCardId) {
    card = (await prisma.jobCard.findFirst({ where: { id: jobCardId, group_id: groupId }, select: { id: true, vehicle: { select: { registration: true } } } })) as any;
    if (!card) return res.status(404).json({ message: 'Job card not found.' });
    const key = await threadKeyForJobCard(prisma, card.id);
    if (!key) return res.status(409).json({ code: 'no_owner', message: 'This vehicle has no current owner on record, so there is nobody to write to.' });
    // Find WITHOUT creating on a GET — reading must never write.
    const existing = await prisma.messageThread.findUnique({
      where: { group_id_customer_id_vehicle_id: { group_id: key.groupId, customer_id: key.customerId, vehicle_id: key.vehicleId } },
      select: { id: true, vehicle: { select: { registration: true } } },
    });
    thread = existing;
    if (!thread && req.method === 'POST') {
      const id = await ensureThread(prisma, key);
      thread = await prisma.messageThread.findUnique({ where: { id }, select: { id: true, vehicle: { select: { registration: true } } } });
    }
  }
  if (!thread && req.method === 'GET') {
    // No conversation yet is not an error — return the empty one plus whether it can be written to.
    return res.status(200).json({ messages: [], reachability: card ? await reachabilityForJobCard(prisma, card.id, 'email') : null });
  }
  if (!thread) return res.status(404).json({ message: 'Conversation not found.' });

  if (req.method === 'GET') {
    const channel = (String(req.query.channel ?? 'email') as NotifyChannelName);
    return res.status(200).json({
      messages: await listThreadMessages(prisma, thread.id),
      reachability: await threadReachability(prisma, thread.id, channel),
    });
  }

  if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  // NOT GATED (2026-08-06): talking to a customer is continuing work. A garage that cannot answer
  // its own customers is not restricted, it is broken.

  const channel = ((req.body ?? {}).channel === 'sms' ? 'sms' : 'email') as NotifyChannelName;
  const body = String((req.body ?? {}).body ?? '').trim();
  if (!body) return res.status(400).json({ message: 'Write a message first.' });
  if (body.length > MAX_BODY) return res.status(400).json({ message: `Keep it under ${MAX_BODY} characters.` });

  // REACHABILITY BEFORE ANYTHING ELSE. The compose box already checked this, but a request can
  // arrive without it, and accepting text we cannot deliver is exactly the failure this refuses.
  const reach = await threadReachability(prisma, thread.id, channel);
  if (!reach) return res.status(404).json({ message: 'Conversation not found.' });
  if (!reach.ok) return res.status(409).json({ code: 'unreachable', message: reach.reason });

  const group = await prisma.group.findUnique({
    where: { id: groupId },
    select: { group_name: true, trading_name: true, billing_email: true, invoice_reply_to: true, invoice_sender_name: true, inbound_token: true, phone: true },
  });
  const garageName = (group?.trading_name || group?.group_name || 'Your garage') as string;

  const sent = await sendNotification({
    recipient: reach.address,
    template: 'free_text',
    channel,
    groupId,
    threadId: thread.id,          // the conversation is already known — don't re-derive it
    body,                          // the words themselves, kept on the row
    sentByUserId: user.id as string, // WHO decided to contact this customer
    subject: { type: 'message_thread', id: thread.id },
    data: {
      body,
      garageName,
      // One-way sender: a customer replying to this SMS reaches nobody, so the number goes in the
      // body. Group-level here — a thread is not site-scoped, so there is no site number to prefer.
      garagePhone: group?.phone ?? null,
      greeting: `Hello ${reach.customerName}`,
      subject: `Message from ${garageName}${thread.vehicle?.registration ? ` — ${thread.vehicle.registration}` : ''}`,
    },
    emailOpts: {
      fromName: (group?.invoice_sender_name || '').trim() || garageName,
      // Entitled tenants get the THREAD's own inbound address, so a customer's reply lands back on
      // this conversation. Unentitled tenants keep their existing reply-to, unchanged.
      replyTo: resolveReplyTo(group, { inboundEnabled: await hasModule(groupId, 'inbound'), threadToken: await ensureThreadToken(prisma, thread.id) }),
    },
  });

  // A PERSON DECIDING TO CONTACT A CUSTOMER is an act worth recording in its own right, distinct
  // from the system emitting a quote. Written whatever the outcome: choosing to send and being
  // refused is still a decision that was made, and the diff records which way it went.
  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await writeThreadAudit(tx, {
      groupId, actorUserId: user.id as string, threadId: thread.id, action: 'message.sent_by_staff',
      diff: { channel, recipient: reach.address, chars: body.length, status: sent.status, suppressed: !!sent.suppressed, notificationId: sent.notificationId },
    });
  });

  // Always return the thread AS THE LOG HAS IT. The screen re-renders from this, so a refused send
  // shows as refused — there is no local "sending…" state that can disagree with the record.
  const messages = await listThreadMessages(prisma, thread.id);
  if (sent.suppressed) {
    return res.status(409).json({ code: 'suppressed', message: `${reach.customerName} has opted out of ${channel} — nothing was sent. It is recorded in the conversation.`, messages });
  }
  if (!sent.ok) {
    return res.status(502).json({ code: sent.status, message: sent.reason ?? 'The message was not accepted.', messages });
  }
  return res.status(200).json({ ok: true, messages });
}
