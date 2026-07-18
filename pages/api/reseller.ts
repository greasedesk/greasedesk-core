/**
 * File: pages/api/reseller.ts
 * "Become a reseller" expression-of-interest handler. POST { name, company, area, email, phone,
 * message, website?, turnstileToken }. Turnstile-verified, then delivered via Resend to CONTACT_FORM_TO
 * (destination lives ONLY in server env — never client-shipped). Stores NOTHING beyond the email send.
 * Same never-silent-fail contract as /api/contact.
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

  const b = (req.body || {}) as Record<string, string>;
  if (typeof b.website === 'string' && b.website.trim() !== '') return res.status(200).json({ ok: true }); // honeypot

  const name = String(b.name ?? '').trim();
  const company = String(b.company ?? '').trim();
  const area = String(b.area ?? '').trim();
  const email = String(b.email ?? '').trim();
  const phone = String(b.phone ?? '').trim();
  const message = String(b.message ?? '').trim();

  if (!name || name.length > 100) return res.status(400).json({ ok: false, message: 'Please enter your name.' });
  if (!EMAIL_RE.test(email) || email.length > 200) return res.status(400).json({ ok: false, message: 'Please enter a valid email address.' });
  if (area.length > 200 || company.length > 200 || phone.length > 50 || message.length > 5000) return res.status(400).json({ ok: false, message: 'One of the fields is too long — please shorten it.' });

  const challenge = await verifyTurnstile(b.turnstileToken, clientIp(req.headers));
  if (!challenge.ok) return res.status(400).json({ ok: false, message: 'Please complete the “I’m human” check and try again.' });

  const html = `
    <h2>New reseller expression of interest</h2>
    <p><strong>Name:</strong> ${esc(name)}</p>
    <p><strong>Company / round:</strong> ${esc(company) || '—'}</p>
    <p><strong>Area covered:</strong> ${esc(area) || '—'}</p>
    <p><strong>Email:</strong> ${esc(email)}</p>
    <p><strong>Phone:</strong> ${esc(phone) || '—'}</p>
    <p><strong>Message:</strong></p>
    <p style="white-space:pre-wrap">${esc(message) || '—'}</p>
  `;

  const sent = await sendEmail(CONTACT_TO, `Reseller interest: ${name}`, html, {
    fromName: 'GreaseDesk Reseller Form',
    replyTo: email, // replies go to the enquirer — never exposes the destination
  });

  if (!sent) return res.status(502).json({ ok: false, message: `Sorry — we couldn’t send that just now. Please call us on ${COMPANY.phone} instead.` });
  return res.status(200).json({ ok: true, message: 'Thanks — we’ll be in touch about becoming a reseller.' });
}
