/**
 * File: lib/tenant-export-build.ts
 *
 * BUILDS THE ZIP. Every outside edge is injected — the Prisma client, the blob fetch, the stream
 * the zip is written to — for one reason: R2 credentials are not available outside production, so
 * a builder that reached for R2 itself could never be exercised anywhere it could be checked. With
 * the seam here, a gate proves the traversal, the CSVs, the photo naming, the index and the zip's
 * own integrity on a real tenant, and the only unproven line left is the bucket call itself.
 *
 * ── WHAT DECIDES THE SHAPE ──────────────────────────────────────────────────────────────────────
 * lib/tenant-manifest. Nothing in here contains a list of models, a list of parents or a list of
 * omissions; all three are read from the manifest, whose own invariants refuse to load if a model
 * is unclassified. That is what makes the next model somebody adds impossible to leave out.
 */
import { Prisma } from '@prisma/client';
import type { Writable, Readable } from 'stream';
import { TENANT_MANIFEST, OMITTED_MODELS, EXPORTED_MODELS } from '@/lib/tenant-manifest';
import {
  toCsv, csvCell, CSV_BOM, exportOrder, parentColumn, chunk, photoPath, readmeText, safeSegment,
} from '@/lib/tenant-export';

/** Returns null when the object is gone — counted, never silently skipped. */
export type BlobFetch = (key: string) => Promise<Readable | null>;

export type BuildDeps = {
  prisma: any;
  out: Writable;
  fetchBlob: BlobFetch;
  now?: () => Date;
  onProgress?: (p: { rows: number; blobs: number; model?: string }) => void;
};

export type BuildResult = {
  rowTotal: number; fileCount: number; blobCount: number; blobMissing: number;
  perFile: Record<string, number>; missingKeys: string[];
};

const camel = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** Scalar and enum fields only — a relation is not a column and would serialise as [object Object]. */
const SCALARS: ReadonlyMap<string, string[]> = new Map(
  Prisma.dmmf.datamodel.models.map((m) => [
    m.name, m.fields.filter((f) => f.kind === 'scalar' || f.kind === 'enum').map((f) => f.name),
  ] as const),
);

/** The models the readable/ views need kept in memory. Deliberately NOT every model: AuditLog is
 *  7,511 rows on the live tenant and no readable view uses it. */
const KEEP_FOR_READABLE = new Set(['Customer', 'Vehicle', 'JobCard', 'Invoice', 'InvoiceLine', 'Site']);

export async function buildExport(groupId: string, deps: BuildDeps): Promise<BuildResult> {
  const yazl = await import('yazl');
  const zip = new yazl.ZipFile();
  const now = deps.now ?? (() => new Date());
  const finished = new Promise<void>((resolve, reject) => {
    zip.outputStream.on('error', reject);
    deps.out.on('error', reject);
    deps.out.on('finish', () => resolve());
    deps.out.on('close', () => resolve());
    zip.outputStream.pipe(deps.out);
  });

  const perFile: Record<string, number> = {};
  const idsByModel = new Map<string, string[]>();
  const kept = new Map<string, any[]>();
  let rowTotal = 0;

  const addCsv = (path: string, headers: readonly string[], rows: readonly Record<string, unknown>[]) => {
    zip.addBuffer(Buffer.from(CSV_BOM + toCsv(headers, rows), 'utf8'), path);
    perFile[path] = rows.length;
  };

  // ── 1 · THE TABLES, in the manifest's own closure order ───────────────────────────────────────
  const order = exportOrder(
    Object.entries(TENANT_MANIFEST).map(([model, e]) => ({ model, reach: e.reach, take: e.take })),
  );

  for (const model of order) {
    const entry = TENANT_MANIFEST[model];
    const redact = new Set(entry.redact ?? []);
    const headers = (SCALARS.get(model) ?? []).filter((f) => !redact.has(f));
    let rows: any[] = [];

    if (entry.reach.by === 'self') {
      const g = await deps.prisma.group.findUnique({ where: { id: groupId } });
      rows = g ? [g] : [];
    } else if (entry.reach.by === 'group') {
      rows = await deps.prisma[camel(model)].findMany({ where: { group_id: groupId } });
    } else if (entry.reach.by === 'parent') {
      const col = parentColumn(entry.reach.through);
      const parentIds = idsByModel.get(entry.reach.through) ?? [];
      // No parents is no rows — and NOT one query with an empty IN, which some drivers read as "all".
      for (const part of chunk(parentIds)) {
        rows.push(...await deps.prisma[camel(model)].findMany({ where: { [col]: { in: part } } }));
      }
    }

    if (rows.length && typeof rows[0].id === 'string') idsByModel.set(model, rows.map((r) => r.id as string));
    if (KEEP_FOR_READABLE.has(model)) kept.set(model, rows);
    /**
     * THE HEADER LIST IS THE ONLY GUARD, DELIBERATELY. This used to also `delete` each redacted
     * field from every row — which broke no clause when removed, because `toCsv` emits the header
     * columns and nothing else, so a redacted field could not reach the file either way. Two
     * spellings of one rule is where the two drift: the filter above decides what a column IS, and
     * a reader who assumes these row objects are scrubbed is reading a guarantee nothing makes.
     * Removing the header filter DOES go red, which is how we know which of the two was load-bearing.
     */
    addCsv(`tables/${model}.csv`, headers, rows);
    rowTotal += rows.length;
    deps.onProgress?.({ rows: rowTotal, blobs: 0, model });
  }

  // ── 2 · THE READABLE VIEWS. Denormalised, because tables/Invoice.csv is a wall of UUIDs ───────
  const by = (m: string) => new Map((kept.get(m) ?? []).map((r: any) => [r.id, r]));
  const customers = by('Customer'); const vehicles = by('Vehicle'); const cards = by('JobCard');
  const invoices = kept.get('Invoice') ?? [];
  const money = (p: unknown) => (typeof p === 'number' ? (p / 100).toFixed(2) : '');

  addCsv('readable/invoices.csv',
    ['Invoice number', 'Series', 'Status', 'Date issued', 'Customer', 'Registration', 'Net', 'VAT', 'Gross', 'Paid', 'Void reason'],
    invoices.map((i: any) => {
      const card = i.job_card_id ? cards.get(i.job_card_id) : null;
      const cust = card?.customer_id ? customers.get(card.customer_id) : null;
      const veh = card?.vehicle_id ? vehicles.get(card.vehicle_id) : null;
      const lines = (kept.get('InvoiceLine') ?? []).filter((l: any) => l.invoice_id === i.id);
      // line_total is ALREADY EX-VAT (schema: "EX-VAT (qty x unit_price); gross = line_total +
      // line_vat"). Subtracting line_vat from it took the VAT off twice and understated every net
      // figure in the readable view — which is the column an accountant would read first.
      const net = lines.reduce((a: number, l: any) => a + Number(l.line_total ?? 0), 0);
      const vat = lines.reduce((a: number, l: any) => a + Number(l.line_vat ?? 0), 0);
      return {
        'Invoice number': i.invoice_number, Series: i.series, Status: i.status,
        'Date issued': i.date_issued, Customer: cust?.name ?? i.customer_name_snapshot ?? '',
        Registration: veh?.registration ?? i.vehicle_reg_snapshot ?? '',
        Net: net.toFixed(2), VAT: vat.toFixed(2), Gross: (net + vat).toFixed(2),
        Paid: money(i.amount_paid_pennies), 'Void reason': i.void_reason ?? '',
      };
    }));

  addCsv('readable/job-cards.csv',
    ['Created', 'Status', 'Customer', 'Registration', 'Make', 'Model', 'Mileage', 'Comeback'],
    (kept.get('JobCard') ?? []).map((c: any) => {
      const v = c.vehicle_id ? vehicles.get(c.vehicle_id) : null;
      return {
        Created: c.created_at, Status: c.status,
        Customer: customers.get(c.customer_id)?.name ?? '',
        Registration: v?.registration ?? '', Make: v?.make ?? '', Model: v?.model ?? '',
        Mileage: c.mileage ?? '', Comeback: c.is_comeback ? 'yes' : 'no',
      };
    }));

  addCsv('readable/vehicles.csv',
    ['Registration', 'Make', 'Model', 'Year', 'VIN', 'MOT expiry', 'Last mileage'],
    (kept.get('Vehicle') ?? []).map((v: any) => ({
      Registration: v.registration, Make: v.make, Model: v.model, Year: v.year,
      VIN: v.vin, 'MOT expiry': v.mot_expiry, 'Last mileage': v.last_mileage ?? '',
    })));

  // ── 3 · THE BYTES. Rows without them are an index to files nobody can open ─────────────────────
  const photos: any[] = await deps.prisma.jobCardPhoto.findMany({ where: { group_id: groupId } });
  const taken = new Set<string>();
  const index: Record<string, unknown>[] = [];
  const missingKeys: string[] = [];
  let blobCount = 0;

  for (const p of photos) {
    const card = p.job_card_id ? cards.get(p.job_card_id) : null;
    const veh = card?.vehicle_id ? vehicles.get(card.vehicle_id) : null;
    const path = photoPath({
      registration: veh?.registration ?? null, takenAt: p.created_at ?? null,
      stage: p.stage, slot: p.slot, id: p.id, mediaType: p.media_type,
    }, taken);
    const stream = await deps.fetchBlob(p.r2_key);
    if (stream) { zip.addReadStream(stream, path); blobCount += 1; }
    else missingKeys.push(p.r2_key);
    index.push({
      File: stream ? path : '', Registration: veh?.registration ?? '', Stage: p.stage, Slot: p.slot,
      Label: p.label ?? '', Type: p.media_type === 'video' ? 'video' : 'photo',
      Taken: p.created_at, 'Job card': p.job_card_id, 'Original key': p.r2_key,
      Present: stream ? 'yes' : 'no — the file could not be read from storage',
    });
    deps.onProgress?.({ rows: rowTotal, blobs: blobCount });
  }
  addCsv('photos/index.csv',
    ['File', 'Registration', 'Stage', 'Slot', 'Label', 'Type', 'Taken', 'Job card', 'Original key', 'Present'], index);

  const group = await deps.prisma.group.findUnique({
    where: { id: groupId }, select: { group_name: true, trading_name: true, logo_r2_key: true },
  });
  if (group?.logo_r2_key) {
    const logo = await deps.fetchBlob(group.logo_r2_key);
    if (logo) { zip.addReadStream(logo, 'branding/logo.png'); blobCount += 1; }
    else missingKeys.push(group.logo_r2_key);
  }

  // ── 4 · WHAT IT IS, AND WHAT IT IS NOT ────────────────────────────────────────────────────────
  const garageName = group?.trading_name || group?.group_name || 'your garage';
  const generatedAt = now();
  const manifest = {
    greasedeskExport: 1, generatedAt: generatedAt.toISOString(), garage: garageName,
    rowTotal, files: perFile, blobCount, blobMissing: missingKeys.length,
    modelsExported: EXPORTED_MODELS.length,
    omitted: OMITTED_MODELS,
    note: 'An empty CSV cell is a null, never a zero. Money columns ending _pence or _pennies are whole pence.',
  };
  zip.addBuffer(Buffer.from(`${JSON.stringify(manifest, null, 1)}\n`, 'utf8'), 'manifest.json');
  zip.addBuffer(Buffer.from(readmeText({
    garageName, generatedAt, rowTotal, fileCount: Object.keys(perFile).length,
    blobCount, omissions: OMITTED_MODELS,
  }), 'utf8'), 'READ-ME-FIRST.txt');

  zip.end();
  await finished;

  return {
    rowTotal, fileCount: Object.keys(perFile).length, blobCount,
    blobMissing: missingKeys.length, perFile, missingKeys,
  };
}

/** The object key an export lands on, inside the tenant's own partition. */
export const exportKey = (groupId: string, jobId: string, when: Date): string =>
  `${groupId}/exports/greasedesk-export-${safeSegment(when.toISOString().slice(0, 10))}-${jobId.slice(0, 8)}.zip`;
