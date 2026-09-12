/**
 * File: pages/api/rep-site/interest.ts
 * The reseller site's expression-of-interest handler. MOVED HERE from /api/reseller, which was
 * deleted: the apex /reseller page it served is now a 301 to reps.greasedesk.com, and /api/* is not
 * reachable on the rep host except /api/rep/* and /api/auth/* — so the endpoint had to move inside
 * the one named boundary this site is allowed, /rep-site (middleware.ts).
 *
 * ── IT NOW STORES, AND THE TWO HALVES ARE INDEPENDENT ───────────────────────────────────────────
 * The old handler emailed CONTACT_FORM_TO and stored NOTHING, so a provider failure lost the enquiry
 * with no record and no number anybody could read back (owner, 2026-09-12). Both still happen, each
 * in its own try, and lib/reseller-interest::interestOutcome decides what the person is told from
 * what actually landed. A store failure must not lose the email; an email failure must not lose the
 * store. Neither is allowed to throw past the other.
 *
 * Turnstile and the honeypot are unchanged, and the destination still lives only in server env.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { sendEmail } from '@/lib/email-service';
import { COMPANY } from '@/lib/company-info';
import { verifyTurnstile, clientIp } from '@/lib/turnstile';
import { validateInterest, interestOutcome } from '@/lib/reseller-interest';

const CONTACT_TO = process.env.CONTACT_FORM_TO || 'hugh@greasedesk.com';
const esc = (s: string) => s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] as string));

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ ok: false, message: 'Method Not Allowed' }); }

  const b = (req.body || {}) as Record<string, unknown>;
  // Honeypot: answer as though it worked, store nothing, send nothing.
  if (typeof b.website === 'string' && b.website.trim() !== '') return res.status(200).json({ ok: true });

  const v = validateInterest(b);
  if (!v.ok) return res.status(400).json({ ok: false, message: v.message });
  const f = v.fields;

  const challenge = await verifyTurnstile(typeof b.turnstileToken === 'string' ? b.turnstileToken : undefined, clientIp(req.headers));
  if (!challenge.ok) return res.status(400).json({ ok: false, message: 'Please complete the “I’m human” check and try again.' });

  // ── THE EMAIL ────────────────────────────────────────────────────────────────────────────────
  let emailed = false;
  try {
    emailed = await sendEmail(CONTACT_TO, `Reseller interest: ${f.name}`, `
      <h2>New reseller expression of interest</h2>
      <p><strong>Name:</strong> ${esc(f.name)}</p>
      <p><strong>Company / round:</strong> ${esc(f.company) || '—'}</p>
      <p><strong>Area covered:</strong> ${esc(f.area) || '—'}</p>
      <p><strong>Email:</strong> ${esc(f.email)}</p>
      <p><strong>Phone:</strong> ${esc(f.phone) || '—'}</p>
      <p><strong>Message:</strong></p>
      <p style="white-space:pre-wrap">${esc(f.message) || '—'}</p>
    `, {
      fromName: 'GreaseDesk Reseller Form',
      replyTo: f.email, // replies reach the enquirer — never exposes the destination
    });
  } catch (e) {
    console.error('[rep-site/interest] the notification email threw — the enquiry is still stored', e);
  }

  // ── THE RECORD ───────────────────────────────────────────────────────────────────────────────
  // AFTER the send, and deliberately: email_delivered is a fact about what happened, and writing the
  // row first would mean either a second UPDATE or a column that lies until it is corrected.
  let stored = false;
  try {
    await prisma.resellerEnquiry.create({
      data: {
        name: f.name,
        email: f.email,
        company: f.company || null,
        area: f.area || null,
        phone: f.phone || null,
        message: f.message || null,
        email_delivered: emailed,
      },
      select: { id: true },
    });
    stored = true;
  } catch (e) {
    console.error('[rep-site/interest] could not store the enquiry — the email was', emailed ? 'sent' : 'NOT sent either', e);
  }

  const out = interestOutcome({ stored, emailed }, COMPANY.phone);
  if (!out.ok) console.error('[rep-site/interest] NEITHER stored nor emailed — the enquiry is lost and the person was told to call');
  return res.status(out.status).json({ ok: out.ok, message: out.message });
}
