/**
 * File: lib/notify.ts
 * THE chokepoint for sending a message to a person. Every outbound customer/staff message goes
 * through sendNotification — one place that decides the provider, renders the template, and RECORDS
 * the send (NotificationLog). Never call a provider SDK from a page or an API route.
 *
 * PROVIDER IS CONFIGURATION, NOT CODE. A channel resolves to an adapter via the registry below,
 * chosen from env. Email = Resend today. SMS has a declared adapter slot that is unconfigured, so an
 * SMS send records `skipped` with a clear reason instead of throwing — the day an SMS provider key
 * lands in Vercel, the channel activates with no logic change (the same dormant-until-keyed pattern
 * as lib/stripe and lib/dvsa).
 *
 * NEVER THROWS. A notification failure must not take down the operation that triggered it (issuing an
 * invoice, approving a quote). Callers get {ok:false} and the row records why. Nothing is silent:
 * even a refusal to send is a row.
 */
import { prisma } from '@/lib/db';
import { sendEmail, type SendEmailOpts } from '@/lib/email-service';
import { NOTIFICATION_TEMPLATES, type TemplateKey, type TemplateData } from '@/lib/notification-templates';
import { linkMessageToThread, touchThread } from '@/lib/message-threads';
import { smsText } from '@/lib/sms-text';

export type NotifyChannel = 'email' | 'sms';

export type SendNotificationArgs = {
  /** Email address or E.164 phone, per channel. */
  recipient: string;
  template: TemplateKey;
  channel?: NotifyChannel; // default 'email'
  data?: TemplateData;
  /** Tenant scope — null/undefined for platform-level sends (operator invite, reseller enquiry). */
  groupId?: string | null;
  /** What the message is ABOUT, for support lookups. Loose by design — never a hard FK. */
  subject?: { type: string; id: string } | null;
  /** Email-only transport extras (tenant reply-to, garage BCC, invoice PDF). */
  emailOpts?: SendEmailOpts;
  /** The words a PERSON wrote, for free_text only. Kept on the row because for a composed message
   *  the body IS the record of what the customer was told. Null for templated sends. */
  body?: string | null;
  /** WHO pressed send. Null/absent = the system emitted it — a quote going out, the receipt cron. */
  sentByUserId?: string | null;
  /** Attach to THIS thread rather than deriving one from the subject. Used when the caller already
   *  knows the conversation (composing on a thread); everything else still derives from the subject. */
  threadId?: string | null;
};

export type SendNotificationResult = {
  ok: boolean;
  notificationId: string | null;
  status: 'sent' | 'failed' | 'skipped';
  reason?: string;
  /** True when a contact preference REFUSED this send. Distinct from every other skip: the message
   *  was deliverable and we chose not to deliver it. Callers must handle it as a refusal, never as
   *  a quiet success. */
  suppressed?: boolean;
};

// ── Provider registry: channel → adapter. Configuration decides availability, not a code branch. ──
type Adapter = {
  provider: string;
  configured: () => boolean;
  /**
   * Resolves true when the provider ACCEPTED the message. An adapter may instead return the
   * provider's own answer — its message id and whatever it told us — which is recorded so a row can
   * be reconciled against the provider's console later. A bare boolean stays valid: email does that.
   */
  send: (to: string, rendered: { subject?: string; body: string }, opts?: SendEmailOpts)
    => Promise<boolean | { accepted: boolean; providerMessageId?: string; meta?: Record<string, unknown> }>;
};

const ADAPTERS: Record<NotifyChannel, Adapter> = {
  email: {
    provider: 'resend',
    configured: () => !!process.env.RESEND_API_KEY,
    send: (to, rendered, opts) => sendEmail(to, rendered.subject ?? '', rendered.body, opts ?? {}),
  },
  /**
   * ── SMS (Twilio REST, no SDK) ─────────────────────────────────────────────────────────────────
   * `fetch`, not the SDK: this is one POST with basic auth, and a dependency for a single call is
   * weight we would carry forever.
   *
   * CONFIGURED REQUIRES A SENDER. Provider + key alone used to satisfy it, which would have let the
   * adapter declare itself ready and then fail every send with a provider error — the worst shape,
   * because sendNotification would record `failed` rather than the honest `skipped`.
   *
   * MESSAGING SERVICE FIRST, bare sender ID as the documented fallback. A Messaging Service can hold
   * the alphanumeric `GreaseDesk` AND the real number together and fall back when a network rejects
   * the alphanumeric one; with a bare sender a rejection is simply a failed message. It is also the
   * only shape that survives leaving GB, where alphanumeric senders are not universally supported.
   */
  sms: {
    provider: process.env.SMS_PROVIDER || 'none',
    configured: () => !!process.env.SMS_PROVIDER && !!process.env.SMS_API_KEY
      && !!process.env.SMS_ACCOUNT_SID
      && !!(process.env.SMS_MESSAGING_SERVICE_SID || process.env.SMS_SENDER_ID),
    send: async (to, rendered) => {
      const sid = process.env.SMS_ACCOUNT_SID as string;
      const form = new URLSearchParams({ To: toE164Plus(to), Body: rendered.body });
      if (process.env.SMS_MESSAGING_SERVICE_SID) form.set('MessagingServiceSid', process.env.SMS_MESSAGING_SERVICE_SID);
      else form.set('From', process.env.SMS_SENDER_ID as string);
      // ASK FOR THE TRUTH TO BE SENT BACK. Twilio only calls a status webhook if a message names
      // one, so without this the callback route is dead code and every row stays at the create
      // response forever. Optional on purpose: unset means no callbacks, which is exactly the
      // behaviour we had before, rather than a send that fails because a webhook is not configured.
      // The value MUST be byte-identical to SMS_STATUS_CALLBACK_URL — the same string is what the
      // signature is computed over at the other end.
      if (process.env.SMS_STATUS_CALLBACK_URL) form.set('StatusCallback', process.env.SMS_STATUS_CALLBACK_URL);
      const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + Buffer.from(`${sid}:${process.env.SMS_API_KEY}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form,
      });
      if (!r.ok) {
        // Surface the provider's own words — "provider rejected the message" is undiagnosable, and
        // Twilio's error codes are the only way to tell a bad number from a blocked sender.
        const detail = await r.text().catch(() => '');
        throw new Error(`sms ${r.status}: ${detail.slice(0, 300)}`);
      }
      // ACCEPTED, not delivered. Twilio returns `queued`; a delivery webhook would upgrade the
      // NotificationLog row later. We must never render "delivered" off the back of this.
      //
      // `from` IS THE POINT of recording this. A Messaging Service can fall back from the
      // alphanumeric sender to a bare number without telling anyone, and the only evidence is what
      // the provider echoes back. num_segments is the provider's own count — a second opinion on
      // lib/sms-text's smsCost, and the one that gets billed.
      const j: any = await r.json().catch(() => ({}));
      return {
        accepted: true,
        providerMessageId: j?.sid ?? undefined,
        meta: { sid: j?.sid ?? null, status: j?.status ?? null, from: j?.from ?? null, numSegments: j?.num_segments ?? null },
      };
    },
  },
};

/** Twilio wants a leading +; toE164Digits stores digits only, so the + is added at the boundary. */
const toE164Plus = (raw: string): string => {
  const d = String(raw ?? '').replace(/\D/g, '');
  return d ? `+${d}` : '';
};

/**
 * ── CONTACT-PREFERENCE SUPPRESSION ────────────────────────────────────────────────────────────────
 * REFUSES, never filters. Checked HERE and not at the call sites, because there are fourteen of
 * them and the ones that matter most are the ones nobody remembers to update.
 *
 * Matching is by RECIPIENT STRING within the tenant — the caller doesn't have to know it's talking
 * to a customer, which is the whole point of putting it in the chokepoint. A recipient that matches
 * no customer (staff, operator, platform enquiry) is never suppressed.
 *
 * HONEST-NULL: only `true` suppresses. NULL means no record — unknown — and for the service
 * messages this system sends (your quote is ready, here is your invoice) unknown means SEND.
 * A null must never be read, or rendered, as consent.
 */
async function isSuppressed(groupId: string | null | undefined, channel: NotifyChannel, recipient: string): Promise<boolean> {
  if (!groupId) return false; // platform-level send — no tenant customer list to consult
  const to = recipient.trim();
  if (!to) return false;
  try {
    const where = channel === 'email'
      ? { group_id: groupId, email: { equals: to, mode: 'insensitive' as const } }
      // SMS addresses the dialable column first; the raw column is a fallback for rows written
      // before normalisation existed (and never backfilled).
      : { group_id: groupId, OR: [{ phone_e164: to }, { phone: to }] };
    // ANY match refuses, not the first. One number can belong to two customer rows (a couple, a
    // household, a company handset — TMBS has such a pair today). If either person has asked not to
    // be contacted, the handset must not buzz: findFirst would have made that a coin toss on row
    // order. Suppression is the conservative side of an ambiguous match, deliberately.
    const hits = await prisma.customer.findMany({ where, select: { sms_opt_out: true, email_opt_out: true }, take: 20 });
    return hits.some((h: { sms_opt_out: boolean | null; email_opt_out: boolean | null }) =>
      (channel === 'email' ? h.email_opt_out : h.sms_opt_out) === true);
  } catch {
    // A lookup failure must not silently suppress (that would drop service messages) and must not
    // silently send. Sending is the safer default for a SERVICE message; the row records the send.
    return false;
  }
}

/** Record-only helper (also used to log sends made by legacy transports during migration). */
async function record(args: {
  groupId?: string | null; channel: NotifyChannel; template: string; provider: string;
  status: 'queued' | 'sent' | 'failed' | 'skipped'; recipient: string; subject?: string | null;
  error?: string | null; subjectRef?: { type: string; id: string } | null; sentAt?: Date | null;
  body?: string | null; sentByUserId?: string | null; threadId?: string | null;
  providerMessageId?: string | null; providerMeta?: Record<string, unknown> | null;
}): Promise<string | null> {
  try {
    const row = await prisma.notificationLog.create({
      data: {
        group_id: args.groupId ?? null,
        channel: args.channel,
        template: args.template,
        provider: args.provider,
        status: args.status,
        recipient: args.recipient,
        subject: args.subject ?? null,
        error: args.error ?? null,
        subject_type: args.subjectRef?.type ?? null,
        subject_id: args.subjectRef?.id ?? null,
        sent_at: args.sentAt ?? null,
        body: args.body ?? null,
        sent_by_user: args.sentByUserId ?? null,
        thread_id: args.threadId ?? null,
        provider_message_id: args.providerMessageId ?? null,
        provider_meta: (args.providerMeta ?? undefined) as any,
      },
      select: { id: true },
    });
    // THREADING happens HERE, for EVERY recorded row — sent, failed and skipped alike. A refusal
    // ("they've opted out of email") is part of the conversation history, not an absence from it;
    // threading only the successes would make the thread quietly disagree with the log. Best-effort
    // and non-fatal: the message is already recorded, and a threading error must never turn a
    // delivered message into a reported failure.
    // A caller that already knows the thread has set it above; only derive when it didn't.
    if (!args.threadId) await linkMessageToThread(prisma, row.id, args.subjectRef?.type ?? null, args.subjectRef?.id ?? null);
    else await touchThread(prisma, args.threadId);
    return row.id;
  } catch {
    return null; // logging must never break the send path
  }
}

export async function sendNotification(args: SendNotificationArgs): Promise<SendNotificationResult> {
  const channel: NotifyChannel = args.channel ?? 'email';
  const adapter = ADAPTERS[channel];
  const tpl = NOTIFICATION_TEMPLATES[args.template] as { label: string; security?: boolean; email?: Function; sms?: Function } | undefined;
  const common = { groupId: args.groupId, channel, template: args.template, provider: adapter?.provider ?? 'none', recipient: args.recipient, subjectRef: args.subject,
    body: args.body ?? null, sentByUserId: args.sentByUserId ?? null, threadId: args.threadId ?? null };

  if (!args.recipient?.trim()) {
    const id = await record({ ...common, status: 'skipped', error: 'no recipient' });
    return { ok: false, notificationId: id, status: 'skipped', reason: 'no recipient' };
  }
  if (!tpl) {
    const id = await record({ ...common, status: 'failed', error: `unknown template '${args.template}'` });
    return { ok: false, notificationId: id, status: 'failed', reason: 'unknown template' };
  }

  // CONTACT PREFERENCE — checked before rendering and before any provider call. The row is written
  // as `skipped` with an explicit reason: a suppressed message is NEVER recorded as sent, and never
  // silently vanishes either. ok:false + suppressed:true is the caller's signal to surface it.
  // A SECURITY template bypasses it entirely — see NotificationTemplate.security. The
  // NotificationLog row is still written by the normal path below, so a bypassed send is as
  // recorded as any other; bypassing the preference must never mean bypassing the record.
  if (!tpl.security && await isSuppressed(args.groupId, channel, args.recipient)) {
    const id = await record({ ...common, status: 'skipped', error: `recipient has opted out of ${channel}` });
    return { ok: false, notificationId: id, status: 'skipped', reason: `opted out of ${channel}`, suppressed: true };
  }

  // Render for the channel. A template with no renderer for this channel is a skip, never a guess.
  let subject: string | undefined;
  let body: string;
  try {
    if (channel === 'email') {
      if (!tpl.email) {
        const id = await record({ ...common, status: 'skipped', error: 'template has no email renderer' });
        return { ok: false, notificationId: id, status: 'skipped', reason: 'no email renderer' };
      }
      const r = tpl.email(args.data ?? {}) as { subject: string; html: string };
      subject = r.subject; body = r.html;
    } else {
      if (!tpl.sms) {
        const id = await record({ ...common, status: 'skipped', error: 'template has no sms renderer' });
        return { ok: false, notificationId: id, status: 'skipped', reason: 'no sms renderer' };
      }
      // ONE transliteration, at the ONE place an SMS body is produced. Typographic characters
      // force UCS-2 and can triple the segment count for a message that reads identically — see
      // lib/sms-text. Template authors must not have to remember this, so it is applied here
      // rather than in each renderer, and it never touches stored data or the email path.
      body = smsText((tpl.sms(args.data ?? {}) as { text: string }).text);
    }
  } catch (e: any) {
    const id = await record({ ...common, status: 'failed', error: `render failed: ${e?.message ?? e}` });
    return { ok: false, notificationId: id, status: 'failed', reason: 'render failed' };
  }

  if (!adapter.configured()) {
    const id = await record({ ...common, status: 'skipped', subject, error: `${channel} provider not configured` });
    return { ok: false, notificationId: id, status: 'skipped', reason: `${channel} provider not configured` };
  }

  let accepted = false;
  let error: string | null = null;
  let providerMessageId: string | null = null;
  let providerMeta: Record<string, unknown> | null = null;
  try {
    const out = await adapter.send(args.recipient, { subject, body }, args.emailOpts);
    if (typeof out === 'boolean') accepted = out;
    else { accepted = out.accepted; providerMessageId = out.providerMessageId ?? null; providerMeta = out.meta ?? null; }
  } catch (e: any) {
    error = e?.message ?? String(e);
  }

  const id = await record({
    ...common,
    status: accepted ? 'sent' : 'failed',
    subject,
    error: accepted ? null : (error ?? 'provider rejected the message'),
    sentAt: accepted ? new Date() : null,
    providerMessageId, providerMeta,
  });
  return accepted
    ? { ok: true, notificationId: id, status: 'sent' }
    : { ok: false, notificationId: id, status: 'failed', reason: error ?? 'provider rejected' };
}

/** Log a send that a legacy transport performed directly (migration bridge — see docs). */
export const recordNotification = record;
