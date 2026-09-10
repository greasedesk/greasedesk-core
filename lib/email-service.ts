// File: lib/email-service.ts - Final P.7 Notification System Fix (using Resend)

// We replace nodemailer with Resend for better SaaS transactional email support.
import { Resend } from 'resend';

// --- P.7 Authentication Check ---
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || 'no-reply@greasedesk.com';

if (!RESEND_API_KEY) {
  console.error('FATAL: P.7 Notification System (Email) failed authentication. RESEND_API_KEY is missing in the environment config.');
}

// -- CONSTRUCTED ONLY WHEN THERE IS A KEY (2026-09-10) --------------------------------------------
// This was `new Resend(RESEND_API_KEY)` unconditionally. The current SDK THROWS in its constructor when
// the key is missing, so importing this module crashed -- and lib/notify imports it, so every route that
// can send anything would have failed at LOAD rather than degrading. The rest of this file already
// intends the graceful path (the FATAL log above is a log, not a throw; sendEmail returns false on a
// missing key), and lib/notify's adapter treats "no key" as an ordinary `not_configured` skip. The
// unconditional construction made all of that unreachable. Found when prospect-gate blanked the key to
// guarantee it could never send real prospecting mail, and the import itself fell over.
const resend: Resend | null = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;


export type SendEmailOpts = {
  /** Display name rendered on the GreaseDesk-owned From address (deliverability-correct: the
   *  address stays ours, the tenant appears as the sender name). */
  fromName?: string;
  /** Tenant's real address — replies go to them, not to our no-reply. */
  replyTo?: string;
  /** Silent copies (e.g. the garage's own record of an invoice send). */
  bcc?: string[];
  attachments?: Array<{ filename: string; content: Buffer }>;
  /** Extra message headers — List-Unsubscribe and List-Unsubscribe-Post (RFC 8058) for prospecting mail. */
  headers?: Record<string, string>;
};

/**
 * Sends a generic email using the configured Resend service.
 * @returns {boolean} True if the email was successfully accepted by Resend.
 */
export const sendEmail = async (to: string, subject: string, html: string, opts: SendEmailOpts = {}) => {
  if (!resend) {
    // Fail gracefully if config is missing -- the CLIENT is the precondition, so the guard names it.
    return false;
  }

  try {
    // EMAIL_FROM may itself be "Name <addr>" — extract the bare address before re-naming,
    // otherwise the from field nests brackets and Resend rejects it (422).
    const bareFrom = EMAIL_FROM.includes('<') ? (EMAIL_FROM.match(/<([^>]+)>/)?.[1] ?? EMAIL_FROM) : EMAIL_FROM;
    const { data, error } = await resend.emails.send({
      from: opts.fromName ? `${opts.fromName.replace(/[<>"]/g, '')} <${bareFrom}>` : EMAIL_FROM,
      to: [to], // Resend expects an array for 'to'
      subject: subject,
      html: html,
      ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
      ...(opts.bcc?.length ? { bcc: opts.bcc } : {}),
      ...(opts.attachments?.length ? { attachments: opts.attachments.map((a) => ({ filename: a.filename, content: a.content })) } : {}),
      ...(opts.headers && Object.keys(opts.headers).length ? { headers: opts.headers } : {}),
    });

    if (error) {
      console.error('P.7 Resend API Failed:', error);
      return false;
    }

    console.log(`Email sent successfully to: ${to}. Resend ID: ${data?.id}`);
    return true;

  } catch (error) {
    // Catch any connection/network errors
    console.error('P.7 Notification System Failed:', error);
    return false;
  }
};

// P.7 Notification System: Send team invitation email (Template remains the same)
export const sendTeamInvitationEmail = async (to: string, garageName: string, inviteLink: string) => {
  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
      <h2>Join ${garageName} on GreaseDesk!</h2>
      <p>You've been invited to join the team at ${garageName}.</p>
      <p><a href="${inviteLink}" style="background-color: #4CAF50; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">Accept Invitation</a></p>
      <p>Best regards,</p>
      <p>The GreaseDesk Team</p>
    </div>
  `;

  return sendEmail(to, `You've been invited to join ${garageName} on GreaseDesk`, html);
};