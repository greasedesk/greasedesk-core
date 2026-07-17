/**
 * File: pages/api/contact.ts
 * Public contact-form handler. POST { name, email, message, website? }. Sends to COMPANY.email via
 * Resend, with the submitter as Reply-To so a reply goes straight back to them. Validates every field
 * and returns a real status — the form NEVER silently fails: a send error is surfaced to the user.
 * `website` is a honeypot (bots fill hidden fields); when present we accept-and-drop.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { sendEmail } from '@/lib/email-service';
import { COMPANY } from '@/lib/company-info';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const esc = (s: string) => s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] as string));

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ ok: false, message: 'Method Not Allowed' }); }

  const { name, email, message, website } = (req.body || {}) as { name?: string; email?: string; message?: string; website?: string };

  // Honeypot: a real user never fills the hidden field. Accept-and-drop so bots see success.
  if (typeof website === 'string' && website.trim() !== '') return res.status(200).json({ ok: true });

  const cleanName = String(name ?? '').trim();
  const cleanEmail = String(email ?? '').trim();
  const cleanMessage = String(message ?? '').trim();

  if (!cleanName || cleanName.length > 100) return res.status(400).json({ ok: false, message: 'Please enter your name.' });
  if (!EMAIL_RE.test(cleanEmail) || cleanEmail.length > 200) return res.status(400).json({ ok: false, message: 'Please enter a valid email address.' });
  if (!cleanMessage || cleanMessage.length > 5000) return res.status(400).json({ ok: false, message: 'Please enter a message (up to 5000 characters).' });

  const html = `
    <h2>New GreaseDesk contact enquiry</h2>
    <p><strong>Name:</strong> ${esc(cleanName)}</p>
    <p><strong>Email:</strong> ${esc(cleanEmail)}</p>
    <p><strong>Message:</strong></p>
    <p style="white-space:pre-wrap">${esc(cleanMessage)}</p>
  `;

  const sent = await sendEmail(COMPANY.email, `Contact form: ${cleanName}`, html, {
    fromName: 'GreaseDesk Contact Form',
    replyTo: cleanEmail, // replies go straight to the enquirer
  });

  if (!sent) {
    // Never a silent failure — the client shows an error and the phone/email fallback.
    return res.status(502).json({ ok: false, message: 'Sorry — we couldn’t send your message just now. Please email or call us instead.' });
  }
  return res.status(200).json({ ok: true, message: 'Thanks — we’ll be in touch shortly.' });
}
