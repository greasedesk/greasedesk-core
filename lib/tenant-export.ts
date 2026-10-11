/**
 * File: lib/tenant-export.ts
 *
 * THE PURE HALF OF A TENANT EXPORT: how a value becomes a CSV cell, what order the models are
 * visited in, what a photo is called in the zip, and what the README says. No database, no R2, no
 * Prisma — so every rule here is testable without arranging 14,000 rows.
 *
 * ── TWO VIEWS OF THE SAME DATA, ON PURPOSE ──────────────────────────────────────────────────────
 * `tables/` is one CSV per model: complete, keys intact, reloadable by another system. `readable/`
 * is denormalised for somebody opening it in Excel. Completeness and legibility are different
 * goals and one file cannot serve both — a faithful `InvoiceLine.csv` is a wall of UUIDs, and a
 * readable invoice list silently drops the columns a migration would need.
 */

/**
 * A leading tab or CR can smuggle a formula past a naive check, so they count as dangerous too —
 * and so does `-`, because `-1+SUM(A1)` is a formula. The minus is NOT excluded from this set to
 * protect negative numbers; LOOKS_NUMERIC does that, one line down. Excluding it here instead let
 * `-1+SUM(A1)` through while the comment claimed otherwise, which the gate caught.
 */
const FORMULA_START = /^[=+@\-\t\r]/;
/** Anything a spreadsheet would read as a number stays a number — a negative total is not a formula. */
const LOOKS_NUMERIC = /^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

/**
 * ── CSV INJECTION IS A REAL RISK IN AN EXPORT ───────────────────────────────────────────────────
 * Almost every string in here was typed by somebody: a customer name, a job note, a part
 * description. A cell beginning `=`, `+`, `@` or a control character is executed as a formula when
 * the file is opened in Excel, so an export of customer-entered text is an execution vector aimed
 * at the garage that asked for its own data.
 *
 * Neutralised by prefixing a single apostrophe, which Excel strips on display. NOT applied to
 * anything that reads as a number, because `-1250.00` is a credit note and must stay arithmetic —
 * a blanket rule on the leading `-` would quote every negative figure in the export.
 *
 * The one-character change is recorded in the README rather than left for somebody to discover.
 */
export function neutraliseFormula(s: string): string {
  if (!FORMULA_START.test(s)) return s;
  if (LOOKS_NUMERIC.test(s)) return s;
  return `'${s}`;
}

/**
 * ONE VALUE, ONE CELL. The choices, each of which a reader will otherwise have to guess:
 *  · null and undefined → an EMPTY cell, never the text "null". The README says an empty cell is a
 *    null, because "null" as a string is indistinguishable from a customer actually named that.
 *  · Date → ISO 8601 UTC. Unambiguous, sorts lexically, and parsed by every spreadsheet. A local
 *    format would be ambiguous between en-GB and en-US on the garage's own machine.
 *  · bigint → decimal digits, not a JSON-ish wrapper.
 *  · object/array → compact JSON in the cell. It is already a JSON column upstream; flattening it
 *    would invent a schema the database does not have.
 */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s: string;
  if (v instanceof Date) s = v.toISOString();
  else if (typeof v === 'bigint') s = v.toString();
  else if (typeof v === 'boolean') s = v ? 'true' : 'false';
  /**
   * DECIMAL BEFORE THE GENERIC OBJECT BRANCH. Prisma returns Decimal for every quantity, unit
   * price, VAT rate and line total, and JSON.stringify(Decimal) yields a QUOTED string -
   * "1250.75" - which this function would then quote again into """1250.75""". That is every
   * money column on every invoice line in the export, unreadable as a number by the spreadsheet
   * it is for. Detected by toFixed, which Decimal has and a plain object does not (Date is
   * handled above). Found by the gate, which asserted the value and not the branch.
   */
  else if (typeof v === 'object' && typeof (v as { toFixed?: unknown }).toFixed === 'function') s = String(v);
  else if (typeof v === 'object') s = JSON.stringify(v);
  else s = String(v);
  s = neutraliseFormula(s);
  // RFC 4180: double the quotes, and quote anything holding a comma, quote or newline.
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CRLF line endings: RFC 4180, and the only thing Excel on Windows reads without complaint. */
export function toCsv(headers: readonly string[], rows: readonly Record<string, unknown>[]): string {
  const lines = [headers.map(csvCell).join(',')];
  for (const r of rows) lines.push(headers.map((h) => csvCell(r[h])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

/** A BOM, so Excel opens UTF-8 as UTF-8. Without it, an é in a customer's name arrives as Ã©. */
export const CSV_BOM = '﻿';

export type Reach =
  | { by: 'self' } | { by: 'group' }
  | { by: 'parent'; through: string }
  | { by: 'subject'; keyedOn: string } | { by: 'global' };

/**
 * ── THE ORDER MODELS ARE VISITED IN, AS A CLOSURE ───────────────────────────────────────────────
 * A model reached only through a parent cannot be queried until that parent's ids are known, and
 * `StagedLine` sits behind `StagedInvoice` which sits behind the group. Rather than hand-coding
 * fifteen decisions, this walks outwards until nothing new is reachable.
 *
 * THE LAST LINE IS THE POINT. An exported model that is never reached is THROWN, not warned about:
 * a silent omission is the exact failure this whole slice exists to prevent, and a warning in a log
 * nobody reads is a silent omission with extra steps.
 */
export function exportOrder(
  entries: readonly { model: string; reach: Reach; take: 'export' | 'omit' }[],
): string[] {
  const wanted = entries.filter((e) => e.take === 'export');
  const byModel = new Map(wanted.map((e) => [e.model, e] as const));
  const done = new Set<string>();
  const order: string[] = [];

  for (const e of wanted) {
    if (e.reach.by === 'self' || e.reach.by === 'group') { order.push(e.model); done.add(e.model); }
  }
  let moved = true;
  while (moved) {
    moved = false;
    for (const e of wanted) {
      if (done.has(e.model) || e.reach.by !== 'parent') continue;
      if (!done.has(e.reach.through)) continue;
      order.push(e.model); done.add(e.model); moved = true;
    }
  }
  const unreached = wanted.filter((e) => !done.has(e.model));
  if (unreached.length) {
    throw new Error(
      `tenant-export cannot reach ${unreached.length} exported model(s), so an export would omit them silently: `
      + unreached.map((e) => `${e.model} (${e.reach.by === 'parent' ? `through ${e.reach.through}${byModel.has(e.reach.through) ? '' : ' — which is not exported'}` : e.reach.by})`).join(', '),
    );
  }
  return order;
}

/** The column on a child that joins it to its parent: Model → model_id. */
export const parentColumn = (parent: string): string =>
  `${parent.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()}_id`;

/** Chunked so a tenant with 50,000 invoices does not build one `IN` clause with 50,000 ids in it. */
export const ID_CHUNK = 1000;
export function chunk<T>(xs: readonly T[], n = ID_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

const SAFE = /[^A-Za-z0-9._-]+/g;
/** A path component that cannot escape its folder, collide by case, or confuse an unzip tool. */
export const safeSegment = (s: string, fallback = 'unknown'): string =>
  (s || '').replace(SAFE, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60) || fallback;

/**
 * WHAT A PHOTO IS CALLED. Named for what it is — registration, date, stage — because
 * `9f3c1e2a-...jpg` in a folder of 157 is not a photo of anything. The caller passes a `taken` set
 * so a second photo at the same stage on the same day gets a suffix rather than overwriting the
 * first: a zip with two identical paths is not an error any tool reports, it just loses one.
 */
export function photoPath(
  a: { registration?: string | null; takenAt?: Date | null; stage?: string | null; slot?: string | null; id: string; mediaType?: string | null },
  taken: Set<string>,
): string {
  const reg = safeSegment(a.registration ?? '', 'no-registration');
  const day = a.takenAt ? a.takenAt.toISOString().slice(0, 10) : 'undated';
  const ext = a.mediaType === 'video' ? 'mp4' : 'jpg';
  const base = [day, safeSegment(a.stage ?? '', 'stage'), safeSegment(a.slot ?? '', '')].filter(Boolean).join('-');
  let candidate = `photos/${reg}/${base}.${ext}`;
  if (taken.has(candidate)) {
    // The id's first eight characters, which is what distinguishes two photos of the same thing.
    candidate = `photos/${reg}/${base}-${a.id.slice(0, 8)}.${ext}`;
  }
  taken.add(candidate);
  return candidate;
}

export type OmissionNote = { model: string; because: string };

/**
 * THE README. It exists because a zip of 60 CSVs with no explanation is a different kind of
 * unreadable from a JSON dump, and because what is NOT in the file is the part a garage would
 * otherwise discover at the worst possible moment.
 */
export function readmeText(a: {
  garageName: string; generatedAt: Date; rowTotal: number; fileCount: number;
  blobCount: number; omissions: readonly OmissionNote[];
}): string {
  return [
    `YOUR GREASEDESK DATA — ${a.garageName}`,
    `Prepared ${a.generatedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    '',
    'WHAT THIS IS',
    'Everything GreaseDesk holds about your garage: your customers, their vehicles, every job card,',
    'quote, invoice, payment and stock record, and the photos and videos attached to your jobs.',
    `${a.rowTotal.toLocaleString('en-GB')} records across ${a.fileCount} files, plus ${a.blobCount.toLocaleString('en-GB')} photos and videos.`,
    '',
    'WHERE TO START',
    '  readable/   Open these first. Ordinary spreadsheets - one row per invoice, per job card, per',
    '              vehicle - with the customer and car names filled in. This is the folder to use if',
    '              you want to look something up or send figures to your accountant.',
    '  tables/     The complete copy, one file per kind of record, with all the reference numbers',
    '              intact. Harder to read, but nothing is left out and another system can load it.',
    '  photos/     Your job photos and videos, in a folder per registration, named by date and stage.',
    '              photos/index.csv says which job card each one belongs to.',
    '  branding/   Your logo, as it appears on your invoices.',
    '',
    'HOW TO READ THE SPREADSHEETS',
    '  - An empty cell means there was no value recorded. It does not mean zero.',
    '  - Dates and times are UTC, written as 2026-10-11T14:30:00.000Z.',
    '  - Money is in pence as whole numbers, so 4500 means 45.00 pounds.',
    "  - A few cells begin with an apostrophe ('). That is deliberate: text starting with = or +",
    '    would otherwise be run as a formula by Excel, so the apostrophe stops it. Remove it if you',
    '    need the original character.',
    '',
    'WHAT IS NOT IN HERE, AND WHY',
    ...a.omissions.map((o) => `  - ${o.model}: ${o.because}`),
    '',
    'Passwords, sign-in tokens and two-factor secrets are never included in an export. They cannot',
    'be copied between systems and would only be a risk sitting in a file.',
    '',
    'This file was produced automatically. If anything looks wrong or missing, tell us.',
    '',
  ].join('\n');
}
