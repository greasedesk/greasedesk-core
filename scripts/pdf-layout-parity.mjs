/**
 * File: scripts/pdf-layout-parity.mjs
 * THE acceptance test for lib/pdf-layout.ts.
 *
 * ACCEPTANCE IS STRUCTURAL PARITY, NOT RECONCILIATION. "42/42 reconciled" only proves the line
 * amounts happen to sum to the printed subtotal; a parse can reconcile while getting a description,
 * a VAT text or a continuation wrong. This compares EVERY field of the parse — issue date,
 * registration, name-partial flag, printed subtotal, printed VAT, and for every line the
 * description, qty, unit price, VAT text, amount, adjustment flag, informational flag and
 * continuation count — between:
 *
 *   pdftotext -layout  →  parseInvoiceText   (the proven baseline)
 *   pdf.js + rebuildLayout → parseInvoiceText (the browser path)
 *
 * The two must be IDENTICAL. On TMBS May 2026 they are, 42/42.
 *
 * It exercises the REAL rebuildLayout from lib/pdf-layout.ts and the REAL parser — no Node-only
 * copy of either, because a copy would let the shipped code drift away from the tested code.
 *
 *   npm run test:pdf-parity -- ~/Developer/import/2026-05
 *
 * Requires `pdftotext` (poppler) and a directory of real invoice PDFs, so it is a LOCAL gate, not a
 * CI one: it exits 0 with a notice when either is missing rather than failing a build that cannot
 * possibly satisfy it.
 */
import { execFileSync } from 'child_process';
import { readdirSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = process.argv[2] || process.env.PDF_FIXTURES;

if (!DIR || !existsSync(DIR)) {
  console.log('[pdf-parity] no fixture directory given — skipping.');
  console.log('             usage: npm run test:pdf-parity -- /path/to/invoice/pdfs');
  process.exit(0);
}
try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }); } catch {
  console.log('[pdf-parity] pdftotext (poppler) not installed — skipping.');
  process.exit(0);
}

// Compile the two TS modules we are testing, so the test runs the SHIPPED code.
const tmp = mkdtempSync(join(tmpdir(), 'gd-parity-'));
const tsc = join(ROOT, 'node_modules/.bin/tsc');
execFileSync(tsc, [
  join(ROOT, 'lib/pdf-layout.ts'), join(ROOT, 'lib/invoice-parser.ts'),
  '--target', 'es2020', '--module', 'esnext', '--moduleResolution', 'bundler',
  '--skipLibCheck', '--outDir', tmp,
], { stdio: 'inherit' });
writeFileSync(join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));

const { rebuildLayout } = await import(join(tmp, 'pdf-layout.js'));
const { parseInvoiceText } = await import(join(tmp, 'invoice-parser.js'));
const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
const { readFileSync } = await import('fs');

/** Positioned fragments via pdf.js, then the SHIPPED reconstruction. */
async function browserText(path, opts) {
  const doc = await getDocument({ data: new Uint8Array(readFileSync(path)), useSystemFonts: true, verbosity: 0 }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const content = await (await doc.getPage(p)).getTextContent();
    pages.push(content.items.filter((i) => typeof i.str === 'string')
      .map((i) => ({ str: i.str, x: i.transform[4], y: i.transform[5], w: i.width ?? 0 })));
  }
  return rebuildLayout(pages, opts);
}

/** Every field that matters, in a comparable form. */
const shape = (p) => JSON.stringify({
  issueDate: p.issueDate ? p.issueDate.toISOString().slice(0, 10) : null,
  registration: p.registration,
  customerName: p.customerName,
  customerNamePartial: p.customerNamePartial,
  subtotalPrinted: p.subtotalPrinted,
  vatPrinted: p.vatPrinted,
  lines: p.lines.map((l) => [
    l.description, l.qty, l.unitPrice, l.vatText, l.amount,
    l.isAdjustment, l.isInformational, l.continuation.length,
  ]),
});

const files = readdirSync(DIR).filter((f) => f.toLowerCase().endsWith('.pdf')).sort();
if (!files.length) { console.log('[pdf-parity] no PDFs in ' + DIR + ' — skipping.'); rmSync(tmp, { recursive: true, force: true }); process.exit(0); }

// The DEFAULTS are what ships; the range is asserted too, so a future tuner learns it is safe.
const RANGE = (process.env.PDF_SWEEP === '1'
  ? [2, 2.5, 3, 3.5, 4, 4.5, 5, 6].flatMap((rowTol) => [2.4, 2.6, 3.0, 3.2, 3.6].map((charW) => ({ rowTol, charW })))
  : [
      // The SHIPPED defaults first, then the documented window's corners. rowTol 5 is deliberately
      // absent: it is the first FAILING value, asserted by the sweep (PDF_SWEEP=1), not here.
      { rowTol: 3.5, charW: 3.0 },
      { rowTol: 2, charW: 2.4 }, { rowTol: 4.5, charW: 3.6 },
      { rowTol: 2, charW: 3.6 }, { rowTol: 4.5, charW: 2.4 },
    ]);

let failed = 0;
for (const opts of RANGE) {
  let same = 0;
  const diffs = [];
  for (const f of files) {
    const path = join(DIR, f);
    const a = parseInvoiceText(execFileSync('pdftotext', ['-layout', path, '-'], { maxBuffer: 1 << 26 }).toString());
    const b = parseInvoiceText(await browserText(path, opts));
    if (shape(a) === shape(b)) same++; else diffs.push(f);
  }
  const ok = same === files.length;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  rowTol=${opts.rowTol} charW=${opts.charW}: structural parity ${same}/${files.length}${diffs.length ? '  differs: ' + diffs.slice(0, 5).join(', ') : ''}`);
}

rmSync(tmp, { recursive: true, force: true });
if (failed) { console.error(`\n[pdf-parity] ${failed} configuration(s) failed — the browser extractor no longer matches pdftotext.`); process.exit(1); }
console.log(`\n[pdf-parity] ${files.length}/${files.length} structural parity across the documented safe range.`);
