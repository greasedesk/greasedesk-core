/**
 * File: pages/api/contact.ts
 * Public contact-form handler. POST { name, email, message, website? }. Sends to CONTACT_FORM_TO via
 * Resend, with the submitter as Reply-To so a reply goes straight back to them. The DESTINATION lives
 * ONLY in this server-side route's env — it is never in company-info, any client bundle, the schema,
 * a reply-to the submitter sees, or an API response. Validates every field and returns a real status
 * — NEVER a silent failure. `website` is a honeypot (bots fill hidden fields); when set we accept-and-drop.
 *
 * CONTACT_FORM_TO is read from the environment (set it in Vercel). The fallback below lives ONLY in
 * this server function — API-route source is never shipped to the browser — so it stays unscrapable.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { sendEmail } from '@/lib/email-service';
import { COMPANY } from '@/lib/company-info';
import { verifyTurnstile, clientIp } from '@/lib/turnstile';

const CONTACT_TO = process.env.CONTACT_FORM_TO || 'hugh@greasedesk.com';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const esc = (s: string) => s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] as string));

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ ok: false, message: 'Method Not Allowed' }); }

  const { name, email, message, website, turnstileToken } = (req.body || {}) as { name?: string; email?: string; message?: string; website?: string; turnstileToken?: string };

  // Honeypot: a real user never fills the hidden field. Accept-and-drop so bots see success.
  if (typeof website === 'string' && website.trim() !== '') return res.status(200).json({ ok: true });

  const cleanName = String(name ?? '').trim();
  const cleanEmail = String(email ?? '').trim();
  const cleanMessage = String(message ?? '').trim();

  if (!cleanName || cleanName.length > 100) return res.status(400).json({ ok: false, message: 'Please enter your name.' });
  if (!EMAIL_RE.test(cleanEmail) || cleanEmail.length > 200) return res.status(400).json({ ok: false, message: 'Please enter a valid email address.' });
  if (!cleanMessage || cleanMessage.length > 5000) return res.status(400).json({ ok: false, message: 'Please enter a message (up to 5000 characters).' });

  // Turnstile: verify BEFORE the send. A missing/failed challenge is a CLEAR error, never a silent drop.
  const challenge = await verifyTurnstile(turnstileToken, clientIp(req.headers));
  if (!challenge.ok) return res.status(400).json({ ok: false, message: 'Please complete the “I’m human” check and try again.' });

  const html = `
    <h2>New GreaseDesk contact enquiry</h2>
    <p><strong>Name:</strong> ${esc(cleanName)}</p>
    <p><strong>Email:</strong> ${esc(cleanEmail)}</p>
    <p><strong>Message:</strong></p>
    <p style="white-space:pre-wrap">${esc(cleanMessage)}</p>
  `;

  const sent = await sendEmail(CONTACT_TO, `Contact form: ${cleanName}`, html, {
    fromName: 'GreaseDesk Contact Form',
    replyTo: cleanEmail, // replies go to the ENQUIRER — never exposes the destination address
  });

  if (!sent) {
    // Never a silent failure — the client shows an error pointing at the phone (the only public route).
    return res.status(502).json({ ok: false, message: `Sorry — we couldn’t send your message just now. Please call us on ${COMPANY.phone} instead.` });
  }
  return res.status(200).json({ ok: true, message: 'Thanks — we’ll be in touch shortly.' });
}
