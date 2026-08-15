/**
 * File: pages/api/invoice-pdf.ts
 * GET ?id= → the invoice as an A4 PDF (attachment). Same guards as the invoice view
 * (group + canManageSite), same data (lib/invoice-doc), same layout engine as the email
 * attachment (lib/invoice-pdf) — one document, three surfaces.
 *
 * ── IT MINTS A PAY LINK, AND WHY THAT CANNOT BE A REUSE ─────────────────────────────────────────
 * A garage printing an invoice at the counter and handing it over is a real path, and it is the one
 * the QR exists for — so the download carries the same block the emailed copy does.
 *
 * "Mint once and reuse until expiry" is not available, and the reason is a deliberate security
 * property rather than an oversight: createMagicLink returns the raw token EXACTLY ONCE and stores
 * only sha256(raw), so a DB leak yields nothing usable. There is no way to recover an existing
 * link's URL — not for us, not for anyone. Reuse would mean storing the raw token, which trades the
 * whole model for a convenience. So each download mints its own.
 *
 * PRIOR LINKS ARE NOT REVOKED. Tempting, to keep one live link per invoice — and wrong: a garage
 * that printed a copy last week and handed it to a customer would find that customer's QR dead.
 * Links accumulate and expire on the due-date rule, each attributable to the member of staff who
 * downloaded it (created_by_user) — the CustomerMagicLink row IS the audit record, so no separate
 * AuditLog entry duplicates it.
 *
 * A SIDE EFFECT ON A GET, bounded deliberately: admin-authenticated, only for a document that
 * offers payment at all, and rate-limited per invoice. Over the limit the PDF is still served —
 * WITHOUT the block. A garage must always be able to get their own document; the payment block is
 * the part that can be withheld.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { getVisibility } from '@/lib/site-visibility';
import { canManageSite } from '@/lib/admin-guard';
import { buildInvoiceDoc } from '@/lib/invoice-doc';
import { renderInvoicePdf } from '@/lib/invoice-pdf';
import { mintInvoicePayLink, payOnlineFor, PRINTED_RECIPIENT } from '@/lib/invoice-pay-link';
import { takeToken } from '@/lib/auth-rate-limit';

/** Enough for a garage to print, reprint and print again; far short of a runaway loop. */
export const PDF_PAY_LINK_LIMIT = { max: 12, windowMinutes: 60 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ message: 'Method Not Allowed' });
  }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });

  const doc = await buildInvoiceDoc(String(req.query.id || ''), user.group_id);
  if (!doc) return res.status(404).json({ message: 'Invoice not found.' });
  const vis = await getVisibility(user.id as string);
  if (!canManageSite(vis, doc.siteId)) return res.status(403).json({ message: 'You do not have access to this invoice.' });

  // A pathological loop (a script, a stuck retry) must not mint credentials without bound. Fails
  // OPEN by design — takeToken, not takeTokenStrict: this is a READ path, and refusing a garage
  // their own invoice over a limiter blip is a worse failure than a few extra links.
  const withinBudget = await takeToken(`pdf:pay:${doc.invoiceId}`, PDF_PAY_LINK_LIMIT.max, PDF_PAY_LINK_LIMIT.windowMinutes);

  try {
    const payLink = withinBudget
      ? await mintInvoicePayLink({ doc, groupId: user.group_id as string, recipient: PRINTED_RECIPIENT, createdByUserId: user.id as string })
      : null;
    if (!withinBudget) console.warn('[invoice-pdf] pay-link budget spent for', doc.number, '— serving the document without the block');
    const pay = payLink ? await payOnlineFor({ groupId: user.group_id as string, url: payLink.url }) : null;
    const pdf = await renderInvoicePdf(doc, pay);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${(doc.number || 'invoice').replace(/[^\w.-]/g, '_')}.pdf"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.send(pdf);
  } catch (e) {
    console.error('Invoice PDF error:', e);
    return res.status(500).json({ message: 'Could not generate the PDF.' });
  }
}
