/**
 * File: pages/api/company.ts
 * Edit the caller's own Group (company) details. ADMIN/owner only — gated server-side via the
 * same getVisibility().isAdmin check used for user-management / location-create. Group-scoped.
 *
 *   PATCH { group_name?, company_number?, address?, vat_number?, vat_registered?, default_vat_rate? }
 *
 * vat_registered is the master switch; default_vat_rate is the ONE company default that cascades as
 * an editable pre-fill to quotes + overheads. Both gate/feed via lib/tenant-vat.ts.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { getVisibility } from '@/lib/site-visibility';
import { deleteObject } from '@/lib/r2';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'PATCH') {
    res.setHeader('Allow', 'PATCH');
    return res.status(405).json({ message: 'Method Not Allowed' });
  }
  const session = await getServerSession(req, res, authOptions);
  const sUser = session?.user as any;
  if (!sUser?.id || !sUser?.group_id) return res.status(401).json({ message: 'Not authenticated.' });

  const vis = await getVisibility(sUser.id as string);
  if (!vis.isAdmin) {
    return res.status(403).json({ message: 'Only an admin can edit company details.' });
  }
  const groupId = sUser.group_id as string;

  const {
    group_name, company_number, address, vat_number, vat_registered, default_vat_rate, invoice_prefix, invoice_pad_width,
    invoice_fy_digits, fy_start_month, invoice_warranty_prefix, invoice_email_footer, invoice_next_number, paid_confirm_window_hours,
    invoice_reply_to, invoice_sender_name, invoice_bcc, invoice_footer_text, logo_r2_key, tax_label,
  } = (req.body || {}) as {
    group_name?: string; company_number?: string; address?: string; vat_number?: string; vat_registered?: boolean; default_vat_rate?: number | string;
    invoice_prefix?: string; invoice_pad_width?: number | string;
    invoice_fy_digits?: number | string; fy_start_month?: number | string; invoice_warranty_prefix?: string; invoice_email_footer?: boolean;
    invoice_next_number?: number | string; paid_confirm_window_hours?: number | string;
    invoice_reply_to?: string; invoice_sender_name?: string; invoice_bcc?: string; invoice_footer_text?: string; logo_r2_key?: string; tax_label?: string;
  };

  const data: any = {};
  if (group_name !== undefined) {
    const clean = group_name.trim();
    if (!clean) return res.status(400).json({ message: 'Company name cannot be empty.' });
    data.group_name = clean;
  }
  if (company_number !== undefined) data.company_number = company_number.trim() || null;
  if (address !== undefined) data.address = address.trim() || null;
  if (vat_number !== undefined) data.vat_number = vat_number.trim() || null;
  if (vat_registered !== undefined) data.vat_registered = !!vat_registered;
  if (default_vat_rate !== undefined) {
    const r = Number(default_vat_rate);
    if (!Number.isFinite(r) || r < 0 || r > 100) return res.status(400).json({ message: 'Default VAT rate must be between 0 and 100.' });
    data.default_vat_rate = new Prisma.Decimal(r.toFixed(2));
  }
  if (invoice_prefix !== undefined) data.invoice_prefix = String(invoice_prefix).trim();
  if (invoice_pad_width !== undefined) {
    const w = Math.trunc(Number(invoice_pad_width));
    if (!Number.isFinite(w) || w < 0 || w > 10) return res.status(400).json({ message: 'Invoice padding must be between 0 and 10.' });
    data.invoice_pad_width = w;
  }

  if (invoice_fy_digits !== undefined) {
    const d = Math.trunc(Number(invoice_fy_digits));
    if (![0, 2, 4].includes(d)) return res.status(400).json({ message: 'Fiscal-year digits must be 0, 2 or 4.' });
    data.invoice_fy_digits = d;
  }
  if (fy_start_month !== undefined) {
    const m = Math.trunc(Number(fy_start_month));
    if (!Number.isFinite(m) || m < 1 || m > 12) return res.status(400).json({ message: 'Fiscal-year start month must be 1–12.' });
    data.fy_start_month = m;
  }
  if (invoice_warranty_prefix !== undefined) {
    const p = String(invoice_warranty_prefix).trim();
    if (!p) return res.status(400).json({ message: 'The warranty prefix cannot be empty — it keeps warranty numbers distinct from chargeable ones.' });
    data.invoice_warranty_prefix = p;
  }
  if (invoice_email_footer !== undefined) data.invoice_email_footer = !!invoice_email_footer;
  const emailish = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
  if (invoice_reply_to !== undefined) {
    const v = String(invoice_reply_to).trim();
    if (v && !emailish(v)) return res.status(400).json({ message: 'The Reply-To address doesn’t look like an email address.' });
    data.invoice_reply_to = v || null;
  }
  if (invoice_bcc !== undefined) {
    const v = String(invoice_bcc).trim();
    if (v && !emailish(v)) return res.status(400).json({ message: 'The copy (BCC) address doesn’t look like an email address.' });
    data.invoice_bcc = v || null;
  }
  if (invoice_sender_name !== undefined) data.invoice_sender_name = String(invoice_sender_name).trim() || null;
  if (invoice_footer_text !== undefined) data.invoice_footer_text = String(invoice_footer_text).slice(0, 2000).trim() || null;
  if (tax_label !== undefined) {
    const v = String(tax_label).trim();
    if (!v || v.length > 20) return res.status(400).json({ message: 'The tax label must be 1–20 characters (e.g. VAT, GST, Sales Tax).' });
    data.tax_label = v;
  }
  // Logo key must belong to THIS tenant's branding space (defence against pointing at another
  // tenant's object). Old object is deleted after a successful swap.
  let oldLogoKey: string | null = null;
  if (logo_r2_key !== undefined) {
    const v = String(logo_r2_key).trim();
    if (!v.startsWith(`${groupId}/branding/`)) return res.status(400).json({ message: 'Invalid logo reference.' });
    const cur = (await prisma.group.findUnique({ where: { id: groupId }, select: { logo_r2_key: true } })) as any;
    oldLogoKey = cur?.logo_r2_key && cur.logo_r2_key !== v ? cur.logo_r2_key : null;
    data.logo_r2_key = v;
  }
  if (paid_confirm_window_hours !== undefined) {
    const h = Math.trunc(Number(paid_confirm_window_hours));
    if (!Number.isFinite(h) || h < 1 || h > 168) return res.status(400).json({ message: 'The payment clearance window must be between 1 and 168 hours.' });
    data.paid_confirm_window_hours = h;
  }

  // Starting-number seed — allowed ONLY while the chargeable sequence is unused (no chargeable
  // invoice exists). Once a number is minted the counter is immutable (the no-gaps guarantee).
  let seedTo: number | null = null;
  if (invoice_next_number !== undefined && String(invoice_next_number).trim() !== '') {
    const n = Math.trunc(Number(invoice_next_number));
    if (!Number.isFinite(n) || n < 1 || n > 100_000_000) return res.status(400).json({ message: 'The next invoice number must be a positive whole number.' });
    const used = await prisma.invoice.count({ where: { group_id: groupId, series: 'chargeable' } });
    if (used > 0) return res.status(409).json({ message: 'Invoices have already been issued — the number sequence can no longer be re-seeded.' });
    seedTo = n - 1; // last_value; the next mint returns n
  }

  if (Object.keys(data).length === 0 && seedTo === null) {
    return res.status(400).json({ message: 'Nothing to update.' });
  }

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    if (Object.keys(data).length) await tx.group.update({ where: { id: groupId }, data });
    if (seedTo !== null) {
      await tx.invoiceSequence.upsert({
        where: { group_id: groupId },
        update: { last_value: seedTo },
        create: { group_id: groupId, last_value: seedTo },
      });
    }
  });
  // Old logo object is orphaned after a successful swap — tidy it (best-effort; never fails the save).
  if (oldLogoKey) { try { await deleteObject(oldLogoKey); } catch { /* orphan is harmless */ } }
  return res.status(200).json({ message: 'Company details saved.' });
}
