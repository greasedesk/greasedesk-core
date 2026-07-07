/**
 * File: pages/api/invoice-pdf.ts
 * GET ?id= → the invoice as an A4 PDF (attachment). Same guards as the invoice view
 * (group + canManageSite), same data (lib/invoice-doc), same layout engine as the email
 * attachment (lib/invoice-pdf) — one document, three surfaces.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { getVisibility } from '@/lib/site-visibility';
import { canManageSite } from '@/lib/admin-guard';
import { buildInvoiceDoc } from '@/lib/invoice-doc';
import { renderInvoicePdf } from '@/lib/invoice-pdf';

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

  try {
    const pdf = await renderInvoicePdf(doc);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${(doc.number || 'invoice').replace(/[^\w.-]/g, '_')}.pdf"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.send(pdf);
  } catch (e) {
    console.error('Invoice PDF error:', e);
    return res.status(500).json({ message: 'Could not generate the PDF.' });
  }
}
