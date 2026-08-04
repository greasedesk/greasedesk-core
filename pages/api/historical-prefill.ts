/**
 * File: pages/api/historical-prefill.ts
 * ADMIN-ONLY. POST { rawText } — parse an extracted text layer and return everything the form can
 * be pre-filled with, plus what the tenant's own records already know.
 *
 * The BROWSER extracts the text (pdfjs-dist — Poppler is not on Vercel) and the SERVER parses it.
 * That split is deliberate: the parser is the one already proven 42/42 against the May set, and
 * keeping it server-side means the screen and the commit path cannot drift apart.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/pages/api/auth/[...nextauth]';
import { getVisibility } from '@/lib/site-visibility';
import { parseInvoiceText } from '@/lib/invoice-parser';
import { looksLikeSourceInvoice } from '@/lib/historical-invoice';

const norm = (r: string) => r.replace(/\s+/g, '').toUpperCase();

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ message: 'Method Not Allowed' }); }
  const session = await getServerSession(req, res, authOptions);
  const user = session?.user as any;
  if (!user?.id || !user?.group_id) return res.status(401).json({ message: 'Not authenticated.' });
  const vis = await getVisibility(user.id as string);
  if (!vis.isAdmin) return res.status(403).json({ message: 'Only an admin can record a historical invoice.' });
  const groupId = user.group_id as string;

  const rawText = String((req.body || {}).rawText ?? '');
  if (!rawText.trim()) return res.status(400).json({ code: 'no_text', message: 'No text could be read from that PDF. A scanned image with no text layer cannot be imported.' });

  const p = parseInvoiceText(rawText);
  if (!looksLikeSourceInvoice(p)) {
    return res.status(422).json({
      code: 'not_a_source_invoice',
      message: 'This doesn’t look like a source invoice — no original invoice number and no line table were found. If it is a GreaseDesk invoice, it is already in the ledger.',
    });
  }

  // Already recorded? Say so with the number, before the operator fills anything in.
  const dupe = await prisma.invoice.findFirst({ where: { group_id: groupId, external_ref: p.externalNumber! }, select: { invoice_number: true } });

  // VIN and mileage ride in as continuation text on the informational header line.
  const vin = (rawText.match(/^\s*Vin:\s*([A-HJ-NPR-Z0-9]{11,17})\s*$/mi) || [])[1] ?? null;
  const mileage = (rawText.match(/^\s*Mileage:\s*([\d,]+)\s*$/mi) || [])[1]?.replace(/,/g, '') ?? null;

  // What our own records already know about this registration — the ownership edge is authoritative
  // for the customer; the parsed name is a cross-check.
  let known: any = null;
  if (p.registration) {
    const v = await prisma.vehicle.findFirst({
      where: { group_id: groupId, registration: norm(p.registration) },
      select: { id: true, registration: true, make: true, model: true, vin: true,
                ownerships: { where: { is_current: true }, select: { customer: { select: { id: true, name: true, email: true, phone: true } } }, take: 1 } },
    });
    if (v) known = { vehicleId: v.id, make: v.make, model: v.model, vin: v.vin, customer: v.ownerships[0]?.customer ?? null };
  }

  // Supersede candidates: an existing entry for the same vehicle and printed date. Value is
  // compared in the browser against the printed total — we return enough to show the operator.
  let candidates: any[] = [];
  if (p.registration && p.issueDate) {
    const rows = await prisma.invoice.findMany({
      where: { group_id: groupId, vehicle_reg_snapshot: norm(p.registration), date_issued: p.issueDate, status: { not: 'void' as any } },
      select: { id: true, invoice_number: true, series: true, date_paid: true, lines: { select: { line_total: true, line_vat: true } } },
    });
    candidates = rows.map((r: any) => ({
      id: r.id, invoiceNumber: r.invoice_number, series: r.series,
      datePaid: r.date_paid ? r.date_paid.toISOString().slice(0, 10) : null,
      grossPennies: Math.round(r.lines.reduce((a: number, l: any) => a + Number(l.line_total) + Number(l.line_vat), 0) * 100),
    }));
  }

  const methods = await prisma.paymentMethod.findMany({ where: { group_id: groupId }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
  const sites = await prisma.site.findMany({ where: { group_id: groupId }, select: { id: true, site_name: true }, orderBy: { created_at: 'asc' } });

  return res.status(200).json({
    parsed: {
      externalNumber: p.externalNumber,
      dateIssued: p.issueDate ? p.issueDate.toISOString().slice(0, 10) : null,
      registration: p.registration ? norm(p.registration) : null,
      customerName: p.customerName,
      customerNamePartial: p.customerNamePartial,
      vin, mileage,
      subtotalPrinted: p.subtotalPrinted, vatPrinted: p.vatPrinted, totalPrinted: p.totalPrinted,
      lines: p.lines.filter((l) => !l.isInformational).map((l, i) => ({
        position: i, description: [l.description, ...l.continuation].join(' — '),
        qty: l.qty, unitPrice: l.unitPrice,
        vatRate: /No VAT/i.test(l.vatText) ? 0 : Number((l.vatText.match(/([\d.]+)%/) || [])[1] ?? 20),
        amount: l.amount,
      })),
    },
    alreadyRecordedAs: dupe?.invoice_number ?? null,
    known, candidates, methods, sites,
  });
}
