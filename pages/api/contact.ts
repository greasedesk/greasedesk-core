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
 *
 * ── A SIGNED-IN GARAGE IS NOT A BOT ─────────────────────────────────────────────────────────────
 * /admin/support posts here too. For a tenant session the name and email come from the SESSION, not
 * the body — there is nothing to type and nothing to typo — and no Turnstile is asked for: the
 * challenge exists to stop anonymous abuse of a public form, and we already know exactly who this
 * is. The identity is resolved SERVER-SIDE from the session; a client claiming to be signed in
 * proves nothing and is never believed.
 *
 * The garage's name and ref ride along in the email, so support knows who is asking without a reply
 * that says "which garage is this?".
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { sendEmail } from '@/lib/email-service';
import { COMPANY } from '@/lib/company-info';
import { verifyTurnstile, clientIp } from '@/lib/turnstile';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { prisma } from '@/lib/db';

const CONTACT_TO = process.env.CONTACT_FORM_TO || 'hugh@greasedesk.com';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const esc = (s: string) => s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] as string));

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ ok: false, message: 'Method Not Allowed' }); }

  const { name, email, message, website, turnstileToken } = (req.body || {}) as { name?: string; email?: string; message?: string; website?: string; turnstileToken?: string };

  // Honeypot: a real user never fills the hidden field. Accept-and-drop so bots see success.
  if (typeof website === 'string' && website.trim() !== '') return res.status(200).json({ ok: true });

  // WHO IS ASKING, from the session — never from the body. A tenant gets their identity filled in
  // and skips the challenge; everyone else takes the public path unchanged.
  const session = await getServerSession(req, res, authOptions);
  const su = session?.user as { id?: string; email?: string; name?: string; group_id?: string } | undefined;
  const tenant = su?.id && su?.group_id ? su : null;
  const tenantGroup = tenant?.group_id
    ? await prisma.group.findUnique({ where: { id: tenant.group_id }, select: { group_name: true, ref: true } }).catch(() => null)
    : null;

  const cleanName = String(tenant?.name || tenant?.email || name || '').trim();
  const cleanEmail = String(tenant?.email || email || '').trim();
  const cleanMessage = String(message ?? '').trim();

  if (!cleanName || cleanName.length > 100) return res.status(400).json({ ok: false, message: 'Please enter your name.' });
  if (!EMAIL_RE.test(cleanEmail) || cleanEmail.length > 200) return res.status(400).json({ ok: false, message: 'Please enter a valid email address.' });
  if (!cleanMessage || cleanMessage.length > 5000) return res.status(400).json({ ok: false, message: 'Please enter a message (up to 5000 characters).' });

  // Turnstile: verify BEFORE the send, and ONLY for the public form. A missing/failed challenge is
  // a CLEAR error, never a silent drop. An authenticated tenant is skipped — see the header.
  if (!tenant) {
    const challenge = await verifyTurnstile(turnstileToken, clientIp(req.headers));
    if (!challenge.ok) return res.status(400).json({ ok: false, message: 'Please complete the “I’m human” check and try again.' });
  }

  // The garage line is present ONLY for a tenant, and is built from the session-resolved group —
  // so it cannot be spoofed by a body field, and its absence means "this came from the public site".
  const fromGarage = tenantGroup
    ? `<p><strong>Garage:</strong> ${esc(tenantGroup.group_name)} (${esc(String(tenantGroup.ref ?? '—'))})</p>`
    : '';
  const html = `
    <h2>New GreaseDesk ${tenant ? 'support request' : 'contact enquiry'}</h2>
    <p><strong>Name:</strong> ${esc(cleanName)}</p>
    <p><strong>Email:</strong> ${esc(cleanEmail)}</p>
    ${fromGarage}
    <p><strong>Message:</strong></p>
    <p style="white-space:pre-wrap">${esc(cleanMessage)}</p>
  `;

  const sent = await sendEmail(CONTACT_TO, tenant ? `Support: ${tenantGroup?.group_name ?? cleanName}` : `Contact form: ${cleanName}`, html, {
    fromName: 'GreaseDesk Contact Form',
    replyTo: cleanEmail, // replies go to the ENQUIRER — never exposes the destination address
  });

  if (!sent) {
    // Never a silent failure — the client shows an error pointing at the phone (the only public route).
    return res.status(502).json({ ok: false, message: `Sorry — we couldn’t send your message just now. Please call us on ${COMPANY.phone} instead.` });
  }
  return res.status(200).json({ ok: true, message: 'Thanks — we’ll be in touch shortly.' });
}
