/**
 * File: pages/api/rep/invoice-pdf.ts
 * THE STORED BYTES, AND ONLY THE STORED BYTES.
 *
 * There is no render path here. A submitted rep invoice is never rebuilt from data — that is the
 * whole reason RepInvoice holds a bytea rather than rebuilding the way a garage invoice does, and
 * lib/rep-invoice::refuseIfSubmitted is the predicate that says why.
 *
 * SCOPED TO THE SESSION'S OWN REP. The id is a uuid, but an invoice is somebody's income and the
 * guard is a where-clause, not the unguessability of the key.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { prisma } from '@/lib/db';
import { requireRepApi } from '@/lib/rep-auth';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const rep = await requireRepApi(req, res);
  if (!rep) return;

  const inv = await prisma.repInvoice.findFirst({
    where: { id: String(req.query.id ?? ''), rep_id: rep.repId },
    select: { pdf: true, pdf_bytes: true, rep_invoice_number: true },
  });
  if (!inv) return res.status(404).json({ message: 'Not found.' });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Length', String(inv.pdf_bytes));
  res.setHeader('Content-Disposition', `inline; filename="invoice-${inv.rep_invoice_number}.pdf"`);
  return res.status(200).send(Buffer.from(inv.pdf));
}
