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
};

export type SendNotificationResult = {
  ok: boolean;
  notificationId: string | null;
  status: 'sent' | 'failed' | 'skipped';
  reason?: string;
};

// ── Provider registry: channel → adapter. Configuration decides availability, not a code branch. ──
type Adapter = {
  provider: string;
  configured: () => boolean;
  /** Resolves true when the provider ACCEPTED the message. */
  send: (to: string, rendered: { subject?: string; body: string }, opts?: SendEmailOpts) => Promise<boolean>;
};

const ADAPTERS: Record<NotifyChannel, Adapter> = {
  email: {
    provider: 'resend',
    configured: () => !!process.env.RESEND_API_KEY,
    send: (to, rendered, opts) => sendEmail(to, rendered.subject ?? '', rendered.body, opts ?? {}),
  },
  // Declared, deliberately unconfigured. Adding SMS = fill this adapter + set the key; no new send path.
  sms: {
    provider: process.env.SMS_PROVIDER || 'none',
    configured: () => !!process.env.SMS_API_KEY && !!process.env.SMS_PROVIDER,
    send: async () => false,
  },
};

/** Record-only helper (also used to log sends made by legacy transports during migration). */
async function record(args: {
  groupId?: string | null; channel: NotifyChannel; template: string; provider: string;
  status: 'queued' | 'sent' | 'failed' | 'skipped'; recipient: string; subject?: string | null;
  error?: string | null; subjectRef?: { type: string; id: string } | null; sentAt?: Date | null;
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
      },
      select: { id: true },
    });
    return row.id;
  } catch {
    return null; // logging must never break the send path
  }
}

export async function sendNotification(args: SendNotificationArgs): Promise<SendNotificationResult> {
  const channel: NotifyChannel = args.channel ?? 'email';
  const adapter = ADAPTERS[channel];
  const tpl = NOTIFICATION_TEMPLATES[args.template] as { label: string; email?: Function; sms?: Function } | undefined;
  const common = { groupId: args.groupId, channel, template: args.template, provider: adapter?.provider ?? 'none', recipient: args.recipient, subjectRef: args.subject };

  if (!args.recipient?.trim()) {
    const id = await record({ ...common, status: 'skipped', error: 'no recipient' });
    return { ok: false, notificationId: id, status: 'skipped', reason: 'no recipient' };
  }
  if (!tpl) {
    const id = await record({ ...common, status: 'failed', error: `unknown template '${args.template}'` });
    return { ok: false, notificationId: id, status: 'failed', reason: 'unknown template' };
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
      body = (tpl.sms(args.data ?? {}) as { text: string }).text;
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
  try {
    accepted = await adapter.send(args.recipient, { subject, body }, args.emailOpts);
  } catch (e: any) {
    error = e?.message ?? String(e);
  }

  const id = await record({
    ...common,
    status: accepted ? 'sent' : 'failed',
    subject,
    error: accepted ? null : (error ?? 'provider rejected the message'),
    sentAt: accepted ? new Date() : null,
  });
  return accepted
    ? { ok: true, notificationId: id, status: 'sent' }
    : { ok: false, notificationId: id, status: 'failed', reason: error ?? 'provider rejected' };
}

/** Log a send that a legacy transport performed directly (migration bridge — see docs). */
export const recordNotification = record;
