/**
 * File: lib/notification-templates.ts
 * THE template registry. A notification names a TEMPLATE KEY, never a body — so the same send can be
 * rendered for email today and SMS tomorrow without the caller changing, and so every message the
 * product can send is enumerable in one file (support: "which template was that?").
 *
 * Each template renders per channel. A template with no `sms` renderer simply cannot be sent by SMS —
 * sendNotification records that as `skipped` rather than inventing a body.
 */
export type TemplateData = Record<string, string | number | null | undefined>;

export type RenderedEmail = { subject: string; html: string };
export type RenderedSms = { text: string };

export type NotificationTemplate = {
  /** Human label for the Engine Room / support view. */
  label: string;
  email?: (d: TemplateData) => RenderedEmail;
  sms?: (d: TemplateData) => RenderedSms;
};

const esc = (v: unknown): string =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

/** Shared shell so every GreaseDesk email looks like one product, not N hand-rolled tables. */
const shell = (bodyHtml: string): string => `
  <div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;line-height:1.6;color:#0f172a;max-width:560px;margin:0 auto;padding:8px">
    ${bodyHtml}
    <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0" />
    <p style="font-size:12px;color:#64748b;margin:0">Sent by GreaseDesk on behalf of your garage.</p>
  </div>`;

const button = (href: string, label: string): string =>
  `<p style="margin:24px 0"><a href="${esc(href)}" style="background:#2563eb;color:#fff;padding:12px 22px;text-decoration:none;border-radius:8px;display:inline-block;font-weight:600">${esc(label)}</a></p>`;

export const NOTIFICATION_TEMPLATES = {
  // ── Customer-facing (magic-link bearing) ────────────────────────────────────────────────────────
  quote_ready: {
    label: 'Quote ready for approval',
    email: (d) => ({
      subject: `Your quote from ${d.garageName ?? 'your garage'}${d.registration ? ` — ${d.registration}` : ''}`,
      html: shell(`
        <h2 style="margin:0 0 8px">Your quote is ready</h2>
        <p>${esc(d.garageName)} has prepared a quote${d.registration ? ` for <strong>${esc(d.registration)}</strong>` : ''}${d.total ? `, totalling <strong>${esc(d.total)}</strong>` : ''}.</p>
        ${button(String(d.link ?? ''), 'View your quote')}
        <p style="font-size:13px;color:#475569">This link works for ${esc(d.expiryDays ?? 14)} days. Anyone with the link can view the quote, so please don't forward it.</p>`),
    }),
    sms: (d) => ({
      text: `${d.garageName ?? 'Your garage'}: your quote${d.registration ? ` for ${d.registration}` : ''} is ready${d.total ? ` (${d.total})` : ''}. View: ${d.link}`,
    }),
  },

  job_card_link: {
    label: 'Job progress link',
    email: (d) => ({
      subject: `Your vehicle${d.registration ? ` ${d.registration}` : ''} at ${d.garageName ?? 'your garage'}`,
      html: shell(`
        <h2 style="margin:0 0 8px">Track your job</h2>
        <p>${esc(d.garageName)} has shared the progress of your vehicle${d.registration ? ` <strong>${esc(d.registration)}</strong>` : ''}.</p>
        ${button(String(d.link ?? ''), 'View progress')}
        <p style="font-size:13px;color:#475569">This link works for ${esc(d.expiryDays ?? 14)} days. Anyone with the link can view it.</p>`),
    }),
    sms: (d) => ({ text: `${d.garageName ?? 'Your garage'}: track your vehicle${d.registration ? ` ${d.registration}` : ''} here: ${d.link}` }),
  },

  // ── Garage-facing: the customer answered ────────────────────────────────────────────────────────
  quote_accepted: {
    label: 'Customer accepted a quote',
    email: (d) => ({
      subject: `Quote ACCEPTED — ${d.registration ?? 'job'} (${d.total ?? ''})`,
      html: shell(`
        <h2 style="margin:0 0 8px">${esc(d.customerName)} accepted the quote</h2>
        <p><strong>${esc(d.registration)}</strong>${d.total ? ` · ${esc(d.total)}` : ''} — quote v${esc(d.version)}.</p>
        <p>Book it into the diary when you're ready.</p>
        ${d.link ? button(String(d.link), 'Open the job card') : ''}
        <p style="font-size:13px;color:#475569">Accepted ${esc(d.when)}.</p>`),
    }),
    sms: (d) => ({ text: `Quote ACCEPTED: ${d.registration ?? 'job'} ${d.total ?? ''} (v${d.version}) — book it in.` }),
  },

  quote_declined: {
    label: 'Customer declined a quote',
    email: (d) => ({
      subject: `Quote declined — ${d.registration ?? 'job'}`,
      html: shell(`
        <h2 style="margin:0 0 8px">${esc(d.customerName)} declined the quote</h2>
        <p><strong>${esc(d.registration)}</strong> — quote v${esc(d.version)}${d.total ? ` · ${esc(d.total)}` : ''}.</p>
        <p>Worth a call if you want to understand why.</p>
        ${d.link ? button(String(d.link), 'Open the job card') : ''}
        <p style="font-size:13px;color:#475569">Declined ${esc(d.when)}.</p>`),
    }),
    sms: (d) => ({ text: `Quote declined: ${d.registration ?? 'job'} (v${d.version}).` }),
  },

  // ── Staff / account (migrated from the ad-hoc senders) ──────────────────────────────────────────
  team_invite: {
    label: 'Team invitation',
    email: (d) => ({
      subject: `You've been invited to join ${d.garageName ?? 'a garage'} on GreaseDesk`,
      html: shell(`
        <h2 style="margin:0 0 8px">Join ${esc(d.garageName)} on GreaseDesk</h2>
        <p>You've been invited to join the team at ${esc(d.garageName)}.</p>
        ${button(String(d.link ?? ''), 'Accept invitation')}`),
    }),
  },

  // The invoice/receipt document email. The BODY LINES arrive already localised because the invoice
  // document owns the tenant's locale (lib/invoice-doc → tServer) and this registry has no locale —
  // so the caller translates and this template assembles. Everything structural (shell, order,
  // footer rule) still lives here, which is the point: no caller hand-rolls invoice HTML again.
  // The PDF rides as an emailOpts attachment, not as template data.
  invoice_document: {
    label: 'Invoice / receipt',
    email: (d) => ({
      subject: String(d.subject ?? ''),
      html: shell(`
        <p>${esc(d.greeting)}</p>
        <p>${esc(d.body)}</p>
        ${d.vehicleLine ? `<p>${esc(d.vehicleLine)}</p>` : ''}
        <p>${esc(d.signoff)}<br/>${esc(d.garageName)}</p>
        ${d.footerLine ? `<p style="font-size:12px;color:#64748b">${esc(d.footerLine)}</p>` : ''}`),
    }),
  },

  // Signup email verification. Previously the ONE send with its own inline Resend client, recorded
  // nowhere — the first email a tenant ever receives went down a path nothing else used.
  signup_verify: {
    label: 'Verify your email (signup)',
    email: (d) => ({
      subject: 'Welcome to GreaseDesk — verify your email',
      html: shell(`
        <h2 style="margin:0 0 8px">Verify your email address</h2>
        <p>Hi ${esc(d.name ?? 'there')},</p>
        <p>Thanks for signing up. Verify your email to activate your GreaseDesk trial and finish setting up your garage.</p>
        ${button(String(d.link ?? ''), 'Verify email address')}
        <p style="font-size:13px;color:#475569">If the button doesn't work, paste this into your browser:<br/>${esc(d.link)}</p>`),
    }),
  },

  // FREE TEXT — the one template whose body a PERSON supplies. Everything structural still lives
  // here (shell, greeting, sign-off, the garage's name), so a staff member writes a message, not an
  // email: they cannot inject markup, and every free-text message still looks like the product sent
  // it. The body is escaped and rendered as plain paragraphs; newlines become line breaks and
  // nothing else is interpreted.
  free_text: {
    label: 'Message from the garage',
    email: (d) => ({
      subject: String(d.subject || `Message from ${d.garageName ?? 'your garage'}`),
      html: shell(`
        <p>${esc(d.greeting ?? 'Hello')},</p>
        <div style="white-space:pre-wrap">${esc(d.body)}</div>
        <p style="margin-top:20px">${esc(d.garageName)}</p>`),
    }),
    // Declared so `channel` is a real field rather than decoration: an SMS free-text send renders
    // here and is then recorded as skipped by the unconfigured SMS adapter — refused for the right
    // reason (no provider), not silently unsupported.
    sms: (d) => ({ text: `${d.garageName ?? 'Your garage'}: ${String(d.body ?? '')}` }),
  },

  // A COPY of an inbound customer reply, forwarded to the garage's own mailbox so that switching
  // inbound on never stops mail arriving where staff already read it. Addressed to the tenant's REAL
  // address, never to the inbound address — that would loop straight back into the pipeline.
  inbound_forward: {
    label: 'Customer reply (copy)',
    email: (d) => ({
      subject: `Reply from ${d.from ?? 'a customer'}: ${d.subjectLine ?? ''}`,
      html: shell(`
        <p style="font-size:13px;color:#475569">${esc(d.from)} replied to ${esc(d.garageName)}. It is on the conversation in GreaseDesk; this is your copy.</p>
        <p style="font-weight:600">${esc(d.subjectLine)}</p>
        <div style="white-space:pre-wrap">${esc(d.body)}</div>`),
    }),
  },

  password_reset: {
    label: 'Password reset',
    email: (d) => ({
      subject: 'Reset your GreaseDesk password',
      html: shell(`
        <h2 style="margin:0 0 8px">Reset your password</h2>
        <p>Use the button below to set a new password. If you didn't ask for this, you can ignore this email.</p>
        ${button(String(d.link ?? ''), 'Set a new password')}
        <p style="font-size:13px;color:#475569">This link expires in ${esc(d.expiryMinutes ?? 60)} minutes.</p>`),
    }),
  },
} satisfies Record<string, NotificationTemplate>;

export type TemplateKey = keyof typeof NOTIFICATION_TEMPLATES;

export const isTemplateKey = (k: string): k is TemplateKey =>
  Object.prototype.hasOwnProperty.call(NOTIFICATION_TEMPLATES, k);
