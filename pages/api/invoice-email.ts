/**
 * File: pages/api/invoice-email.ts
 * POST { invoiceId } → email the invoice PDF to the vehicle's current owner. Thin session-authed
 * wrapper over lib/invoice-email-send (THE one send implementation, shared with the clearance
 * cron): deliverability-correct From/Reply-To, garage BCC, audit invoice.sent, and receipt_sent_at
 * stamping on confirmed invoices all live there.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { prisma } from '@/lib/db';
import { getVisibility } from '@/lib/site-visibility';
import { canManageSite } from '@/lib/admin-guard';
import { sendInvoiceEmail } from '@/lib/invoice-email-send';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ message: 'Method Not Allowed' });
  }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });

  const { invoiceId } = (req.body || {}) as { invoiceId?: string };
  if (!invoiceId) return res.status(400).json({ message: 'Missing invoiceId.' });

  const invoice = (await prisma.invoice.findFirst({ where: { id: invoiceId, group_id: user.group_id }, select: { site_id: true } })) as any;
  if (!invoice) return res.status(404).json({ message: 'Invoice not found.' });
  const vis = await getVisibility(user.id as string);
  if (!canManageSite(vis, invoice.site_id)) return res.status(403).json({ message: 'You do not have access to this invoice.' });

  const result = await sendInvoiceEmail(invoiceId, user.group_id as string, user.id as string);
  if (!result.ok) {
    const status = result.code === 'NOT_FOUND' ? 404 : result.code === 'NO_RECIPIENT' ? 409 : result.code === 'SEND_FAILED' ? 502 : 500;
    return res.status(status).json({ message: result.message });
  }
  return res.status(200).json({ message: 'Invoice sent.' });
}
