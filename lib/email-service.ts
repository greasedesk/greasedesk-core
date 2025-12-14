// File: lib/email-service.ts - Final P.7 Notification System Fix (using Resend)

// We replace nodemailer with Resend for better SaaS transactional email support.
import { Resend } from 'resend';

// --- P.7 Authentication Check ---
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || 'no-reply@greasedesk.com';

if (!RESEND_API_KEY) {
  console.error('FATAL: P.7 Notification System (Email) failed authentication. RESEND_API_KEY is missing in the environment config.');
}

// Initialise Resend Client
const resend = new Resend(RESEND_API_KEY);


/**
 * Sends a generic email using the configured Resend service.
 * @returns {boolean} True if the email was successfully accepted by Resend.
 */
export const sendEmail = async (to: string, subject: string, html: string) => {
  if (!RESEND_API_KEY) {
    // Fail gracefully if config is missing
    return false;
  }

  try {
    const { data, error } = await resend.emails.send({
      from: EMAIL_FROM,
      to: [to], // Resend expects an array for 'to'
      subject: subject,
      html: html,
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