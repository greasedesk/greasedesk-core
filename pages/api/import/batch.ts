/**
 * File: pages/api/import/batch.ts
 * ADMIN-only. Create an import batch and ingest extracted invoice text into STAGING.
 *
 *   POST { label, siteId, invoices: [{ filename?, text }] }  → create/reuse batch + ingest
 *   GET  ?batchId=…                                          → batch + reconciliation totals
 *
 * STAGING IS NEVER THE LEDGER. Nothing this endpoint writes is read by any financial report;
 * committing to the ledger is a separate, explicit action (see commit.ts).
 *
 * NOTE ON EXTRACTION: text arrives already extracted. `pdftotext` is not available on the Vercel
 * runtime, so PDF→text happens client-side (or locally for a seeded batch) and the server parses
 * the text. That keeps the proven parser server-side where the reconciliation gate lives.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requireImportApi, importableSiteIds } from '@/lib/admin-guard';
import { ingestOne, batchTotals } from '@/lib/import-batch';
import { writeImportAudit } from '@/lib/audit';

export const config = { api: { bodyParser: { sizeLimit: '12mb' } } };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const vis = await requireImportApi(req, res); // sends 401/403 itself
  if (!vis) return;
  if (!vis.groupId) return res.status(403).json({ message: 'You do not have permission to import invoices.' });

  if (req.method === 'GET') {
    const batchId = String(req.query.batchId || '');
    if (!batchId) {
      const batches = await prisma.importBatch.findMany({
        where: { group_id: vis.groupId },
        orderBy: { created_at: 'desc' },
        select: { id: true, label: true, status: true, created_at: true, _count: { select: { invoices: true } } },
      });
      return res.status(200).json({ batches });
    }
    const batch = await prisma.importBatch.findFirst({
      where: { id: batchId, group_id: vis.groupId },
      select: { id: true, label: true, status: true, site_id: true },
    });
    if (!batch) return res.status(404).json({ message: 'Batch not found.' });
    const invoices = await prisma.stagedInvoice.findMany({
      where: { batch_id: batchId },
      orderBy: { external_number: 'asc' },
      select: {
        id: true, external_number: true, issue_date: true, registration: true,
        subtotal_printed: true, subtotal_parsed: true, reconciled: true,
        vat_printed: true, vat_computed: true, status: true, wizard_step: true,
        planned_start_at: true, job_card_id: true, invoice_id: true,
        _count: { select: { lines: true } },
      },
    });
    return res.status(200).json({ batch, invoices, totals: await batchTotals(batchId) });
  }

  if (req.method === 'POST') {
    const { label, siteId, invoices } = (req.body || {}) as {
      label?: string; siteId?: string; invoices?: Array<{ filename?: string; text?: string }>;
    };
    if (!label?.trim()) return res.status(400).json({ message: 'A batch label is required.' });
    // OPERATIONAL target: a batch imports into a LIVE site.
    if (!siteId || !importableSiteIds(vis).includes(siteId)) {
      return res.status(400).json({ message: 'Choose a location you can raise invoices for.' });
    }
    if (!Array.isArray(invoices) || !invoices.length) {
      return res.status(400).json({ message: 'No invoice text supplied.' });
    }

    // Reuse the named batch when one is supplied (so a part-uploaded month can be topped up),
    // else start a new one. Tenant-scoped lookup — a batchId from another group is not found.
    const wanted = typeof req.body?.batchId === 'string' ? req.body.batchId : null;
    const existing = wanted
      ? await prisma.importBatch.findFirst({ where: { id: wanted, group_id: vis.groupId }, select: { id: true } })
      : null;
    if (wanted && !existing) return res.status(404).json({ message: 'Batch not found.' });
    const batch = existing ?? (await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const b = await tx.importBatch.create({
        data: { group_id: vis.groupId as string, site_id: siteId, label: label.trim(), created_by: vis.userId },
        select: { id: true },
      });
      await writeImportAudit(tx, { groupId: vis.groupId as string, actorUserId: vis.userId, batchId: b.id,
        action: 'import.batch_created', diff: { label: label.trim(), siteId } });
      return b;
    }));

    const results: Array<{ file?: string; ok: boolean; reason?: string; reconciled?: boolean }> = [];
    for (const inv of invoices) {
      if (!inv?.text) { results.push({ file: inv?.filename, ok: false, reason: 'empty text' }); continue; }
      const r = await ingestOne({ batchId: batch.id, groupId: vis.groupId, text: inv.text, filenameHint: inv.filename });
      results.push(r.ok ? { file: inv.filename, ok: true, reconciled: r.reconciled } : { file: inv.filename, ok: false, reason: r.reason });
    }

    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await writeImportAudit(tx, {
        groupId: vis.groupId as string, actorUserId: vis.userId, batchId: batch.id,
        action: 'import.ingested',
        diff: {
          count: results.length,
          ok: results.filter((r) => r.ok).length,
          reconciled: results.filter((r) => r.reconciled).length,
          failed: results.filter((r) => !r.ok).map((r) => ({ file: r.file, reason: r.reason })),
        },
      });
    });
    return res.status(200).json({ batchId: batch.id, results, totals: await batchTotals(batch.id) });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ message: 'Method Not Allowed' });
}
