/**
 * File: lib/inbound.ts
 * THE inbound pipeline: resolve → record → fetch body → forward. Separated from the route so the
 * route is only transport (verify, dedupe, hand off) and this is only behaviour.
 *
 * ── RESOLUTION ORDER, AND THE RULE ABOUT GUESSING ───────────────────────────────────────────────
 *   1. thread token          → exact, one conversation
 *   2. tenant token + sender → only when EXACTLY ONE thread in that tenant has that sender address
 *   3. unresolved bucket
 * Never guess on more than one match. A reply filed onto the wrong customer's conversation is worse
 * than one filed nowhere: nowhere is visible and fixable, wrong is invisible and wrong.
 *
 * ── UNRESOLVED IS NOT A FAILURE ─────────────────────────────────────────────────────────────────
 * An inbound message we cannot place is still a customer talking to a garage. It is RECORDED with a
 * null thread_id, flagged, and surfaced in the Engine Room. Honest-null: unresolved means unknown,
 * not discarded. Nothing is ever dropped on the floor.
 *
 * ── THE BODY IS OURS TO KEEP ────────────────────────────────────────────────────────────────────
 * Resend's webhook carries metadata only, and Resend discards received mail after 30 DAYS. So the
 * body is fetched in a second call and persisted HERE — after that window their API cannot answer
 * and this row is the only copy of what the customer said. A body fetch that fails must NEVER fail
 * the webhook: the row is written first with a null body and backfilled later
 * (scripts/backfill-inbound-bodies.mjs). Losing the metadata because the body call blipped would
 * turn a recoverable gap into a lost message.
 */
import type { PrismaClient } from '@prisma/client';
import { parseInboundAddress, pickOurAddresses } from '@/lib/inbound-address';
import { touchThread } from '@/lib/message-threads';
import { sendNotification } from '@/lib/notify';
import { resolveOpsEmail, OPS_EMAIL_SELECT } from '@/lib/ops-email';

export type InboundPayload = {
  type?: string;
  created_at?: string;
  data?: {
    email_id?: string;
    created_at?: string;
    from?: string;
    to?: string[];
    cc?: string[];
    bcc?: string[];
    received_for?: string[];
    message_id?: string;   // the SENDER'S RFC header — never trusted, never a dedupe key
    subject?: string;
    attachments?: Array<{ filename?: string; content_type?: string; size?: number }>;
  };
};

export type InboundOutcome = {
  notificationId: string | null;
  threadId: string | null;
  resolution: 'thread_token' | 'tenant_sender' | 'unresolved';
  reason?: string;
  bodyFetched: boolean;
  forwarded: boolean;
};

const bare = (v: string | null | undefined) => {
  const s = String(v ?? '').trim().toLowerCase();
  return s.includes('<') ? (s.match(/<([^>]+)>/)?.[1] ?? s) : s;
};

/** Resolve a payload to a thread, following the settled order and refusing to guess. */
export async function resolveInbound(db: PrismaClient, payload: InboundPayload): Promise<{
  groupId: string | null; threadId: string | null; resolution: InboundOutcome['resolution']; reason?: string;
}> {
  const d = payload.data ?? {};
  const candidates = [...(d.received_for ?? []), ...(d.to ?? []), ...(d.cc ?? [])];
  const parsed = pickOurAddresses(candidates);
  const sender = bare(d.from);

  // 1 — THREAD TOKEN. Exact.
  for (const p of parsed) {
    if (!p.threadToken) continue;
    const t = await db.messageThread.findUnique({ where: { thread_token: p.threadToken }, select: { id: true, group_id: true, group: { select: { inbound_token: true } } } });
    if (!t) continue;
    // The tenant half must agree when it is present — a mismatched pair is tampering, not a typo.
    if (p.tenantToken && t.group?.inbound_token && p.tenantToken !== t.group.inbound_token) {
      return { groupId: null, threadId: null, resolution: 'unresolved', reason: 'thread token and tenant token disagree' };
    }
    return { groupId: t.group_id, threadId: t.id, resolution: 'thread_token' };
  }

  // 2 — TENANT TOKEN + SENDER, only when exactly one thread matches.
  for (const p of parsed) {
    if (!p.tenantToken) continue;
    const g = await db.group.findUnique({ where: { inbound_token: p.tenantToken }, select: { id: true } });
    if (!g) continue;
    if (!sender) return { groupId: g.id, threadId: null, resolution: 'unresolved', reason: 'no sender address to match on' };
    const matches = await db.messageThread.findMany({
      where: { group_id: g.id, customer: { email: { equals: sender, mode: 'insensitive' } } },
      select: { id: true }, take: 5,
    });
    if (matches.length === 1) return { groupId: g.id, threadId: matches[0].id, resolution: 'tenant_sender' };
    // MORE THAN ONE MATCH IS NOT A COIN TOSS. It is the unresolved bucket, with the count recorded.
    return { groupId: g.id, threadId: null, resolution: 'unresolved', reason: matches.length === 0 ? `sender ${sender} matches no conversation in this tenant` : `sender ${sender} matches ${matches.length} conversations — refusing to guess` };
  }

  return { groupId: null, threadId: null, resolution: 'unresolved', reason: 'recipient address carries no recognised token' };
}

/**
 * Fetch the body. Returns nulls on ANY failure — the caller records the row regardless — but ALWAYS
 * returns a REASON when it fails.
 *
 * The first genuine inbound message arrived with a null body and nothing anywhere recording why:
 * the failure went to a console line and was gone. Diagnosing it meant guessing between a
 * sending-only API key and a not-yet-ready body. A silent absence is the failure mode this project
 * keeps re-finding, and swallowing the status code is how it happens. Every exit here names itself.
 */
export type BodyFetch = { text: string | null; html: string | null; ok: boolean; error: string | null };

export async function fetchInboundBody(emailId: string): Promise<BodyFetch> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { text: null, html: null, ok: false, error: 'no RESEND_API_KEY in this environment' };
  if (!emailId) return { text: null, html: null, ok: false, error: 'no provider email id on the event' };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`, {
      headers: { Authorization: `Bearer ${key}` }, signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!r.ok) {
      // The provider's own words, capped. A 401/403 means the key lacks receiving access; a 404
      // usually means the content is not ready yet. The distinction is the whole diagnosis, so it
      // is stored rather than inferred later.
      const detail = (await r.text().catch(() => '')).slice(0, 300);
      return { text: null, html: null, ok: false, error: `HTTP ${r.status} ${r.statusText || ''} — ${detail}`.trim() };
    }
    const j = (await r.json()) as { text?: string; html?: string };
    const text = j.text ?? null, html = j.html ?? null;
    if (text === null && html === null) return { text: null, html: null, ok: false, error: 'HTTP 200 but the response carried neither text nor html' };
    return { text, html, ok: true, error: null };
  } catch (e: any) {
    return { text: null, html: null, ok: false, error: e?.name === 'AbortError' ? 'timed out after 8s' : `fetch threw: ${e?.message ?? e}` };
  }
}

/**
 * Record an inbound message and everything that follows from it. Idempotent on the provider's
 * email_id so a re-processed event cannot double-record even if the dedupe ledger were bypassed.
 */
export async function processInbound(db: PrismaClient, payload: InboundPayload): Promise<InboundOutcome> {
  const d = payload.data ?? {};
  const emailId = String(d.email_id ?? '');
  const sender = bare(d.from);
  const receivedAt = d.created_at ? new Date(d.created_at) : new Date();

  // Second line of defence behind the dedupe ledger, on a DIFFERENT key.
  const already = emailId ? await db.notificationLog.findFirst({ where: { provider_message_id: emailId, direction: 'in' }, select: { id: true, thread_id: true } }) : null;
  if (already) return { notificationId: already.id, threadId: already.thread_id, resolution: already.thread_id ? 'thread_token' : 'unresolved', reason: 'already recorded', bodyFetched: false, forwarded: false };

  const res = await resolveInbound(db, payload);
  const body = await fetchInboundBody(emailId);

  const row = await db.notificationLog.create({
    data: {
      group_id: res.groupId,
      channel: 'email',
      template: 'inbound_email',
      provider: 'resend',
      status: 'received',
      direction: 'in',
      recipient: sender || 'unknown',   // for an inbound row this is the OTHER party — the customer
      subject: d.subject ?? null,
      provider_message_id: emailId || null,
      body: body.text,
      body_html: body.html,
      body_error: body.error,   // null when the body arrived; the provider's reason when it did not
      received_at: receivedAt,
      sent_at: null,                     // we did not send it; a copied timestamp would claim we did
      thread_id: res.threadId,
      // The reason lives on the row so the Engine Room can say WHY, not just THAT.
      error: res.threadId ? null : (res.reason ?? 'unresolved'),
      subject_type: res.threadId ? 'message_thread' : 'inbound_unresolved',
      subject_id: res.threadId,
    },
    select: { id: true },
  });

  let forwarded = false;
  if (res.threadId) {
    await touchThread(db, res.threadId);
    // UNREAD NOW MEANS SOMETHING. An inbound message is the only thing that can set it.
    await db.messageThread.update({ where: { id: res.threadId }, data: { unread_count: { increment: 1 }, state: 'open' } });
    forwarded = await forwardToTenant(db, res.groupId, payload, body.text);
  }

  return { notificationId: row.id, threadId: res.threadId, resolution: res.resolution, reason: res.reason, bodyFetched: body.ok, forwarded };
}

/**
 * Forward a copy to the garage's OWN mailbox, so turning inbound on never stops mail arriving where
 * staff already read it. Deliberately addressed to the tenant's real address (invoice_reply_to or
 * billing_email) and NEVER through resolveReplyTo — that now returns the inbound address, and
 * forwarding to it would put the message straight back into this pipeline in a loop.
 */
async function forwardToTenant(db: PrismaClient, groupId: string | null, payload: InboundPayload, text: string | null): Promise<boolean> {
  if (!groupId) return false;
  const g = await db.group.findUnique({ where: { id: groupId }, select: { group_name: true, trading_name: true, ...OPS_EMAIL_SELECT } });
  // The same chain this used to spell out by hand, now the ONE resolver — so a tenant that sets an
  // ops address gets its forwarded mail there too, and the two paths cannot drift.
  const to = resolveOpsEmail(g).address;
  if (!to) return false;
  const d = payload.data ?? {};
  const r = await sendNotification({
    recipient: to,
    template: 'inbound_forward',
    channel: 'email',
    groupId,
    subject: { type: 'inbound_forward', id: String(d.email_id ?? '') },
    data: {
      garageName: (g?.trading_name || g?.group_name || 'your garage') as string,
      from: bare(d.from),
      subjectLine: d.subject ?? '(no subject)',
      body: text ?? '(the message body could not be retrieved — open it in GreaseDesk)',
    },
  });
  return r.ok;
}
