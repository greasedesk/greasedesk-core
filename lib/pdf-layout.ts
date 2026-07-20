/**
 * File: lib/pdf-layout.ts
 * THE browser-side replacement for `pdftotext -layout`, so a tenant can import invoices from a
 * laptop instead of needing a shell and a local machine. `pdftotext` is not available on the Vercel
 * runtime; pdf.js is, in the browser.
 *
 * WHAT THIS IS NOT: it is not a parser. lib/invoice-parser.ts is unchanged and stays the ONE
 * implementation — a second parser would give the reconciliation gate two behaviours to be right
 * about. The entire compatibility burden sits here, in producing text of the shape the parser
 * already expects.
 *
 * WHY COORDINATES. pdf.js `getTextContent()` returns positioned FRAGMENTS, not lines. Joining them
 * (`items.map(i => i.str).join(' ')`) collapses every column into prose: measured against the real
 * May 2026 set that reconciles 0 of 42 invoices and finds zero billable lines, because all four
 * numeric columns — Quantity | Unit Price | VAT | Amount — cease to be positionally distinguishable.
 * `pdftotext -layout` is itself a reconstruction from the same glyph coordinates; rebuildLayout is
 * that reconstruction, kept deliberately close to its contract.
 *
 * ACCEPTANCE CRITERION — 42/42 STRUCTURAL PARITY, not "it reconciles". Every field of the parse must
 * be identical to the `pdftotext -layout` parse of the same PDF: issue date, registration,
 * name-partial flag, printed subtotal, printed VAT, and for every line the description, qty, unit
 * price, VAT text, amount, adjustment flag, informational flag and continuation count.
 * scripts/pdf-layout-parity.mjs is that test; run it against a directory of real invoices.
 *
 * THE SAFE RANGE, measured by sweeping the acceptance test (PDF_SWEEP=1) rather than assumed:
 *   rowTol 2 – 4.5  → 42/42 parity.   rowTol >= 5 → 0/42.
 *   charW  2.4 – 3.6 → 42/42 parity at every rowTol in range.
 * The defaults sit in the MIDDLE of that window, not at its edge.
 *
 * A CORRECTION WORTH KEEPING: an earlier sweep judged by RECONCILIATION alone reported rowTol 3–6
 * as safe. It is not. rowTol 6 reconciles on all 42 and yet matches the baseline parse on NONE of
 * them — merged rows change descriptions and continuation counts while the amounts still sum. That
 * is precisely why acceptance is structural parity: a number that adds up is not a parse that is
 * right.
 *
 * Two failure modes found while arriving at the defaults, both worth naming because both look like
 * parser bugs when you meet them:
 *   rowTol too small → page columns become separate ROWS, so `valueUnderLabel` reads the address
 *                      block instead of the date and every issue date comes back null (0/42). This
 *                      bit a fixed-grid version (round(y/2)*2); nearest-row-within-tolerance, as
 *                      below, is why rowTol 2 is now inside the safe window rather than outside it.
 *   charW too coarse → a long description overruns its column and leaves ONE space before the qty,
 *                      but the parser's line regex requires `\s{2,}`; three invoices then silently
 *                      lost a line and failed reconciliation by exactly that line's amount.
 * minGap exists for the second: a real gap on the PAGE must always survive as a parseable
 * separator, whatever the character grid computes.
 */

/** One positioned text fragment: what pdf.js gives us, reduced to what layout needs. */
export type LayoutItem = { str: string; x: number; y: number; w: number };

export type LayoutOptions = {
  /** Vertical tolerance (pt) for treating fragments as the same printed row. Safe range 2–4.5. */
  rowTol?: number;
  /** Average glyph advance (pt) converting x-position to a column index. Safe range 2.4–3.6. */
  charW?: number;
  /** Minimum spaces emitted where the page had a real gap. Must stay ≥2: the parser splits on \s{2,}. */
  minGap?: number;
};

export const LAYOUT_DEFAULTS: Required<LayoutOptions> = { rowTol: 3.5, charW: 3.0, minGap: 2 };

/**
 * PURE: positioned fragments → `pdftotext -layout`-shaped text. Exported separately from the
 * loading so the acceptance test exercises THIS function, not a Node-only copy of it.
 */
export function rebuildLayout(pages: LayoutItem[][], opts: LayoutOptions = {}): string {
  const { rowTol, charW, minGap } = { ...LAYOUT_DEFAULTS, ...opts };
  let out = '';
  for (const items of pages) {
    const kept = items.filter((i) => i.str.trim() !== '').sort((a, b) => b.y - a.y);
    // Group by baseline, top of page first — the same merge `pdftotext` performs, and the reason a
    // label and its value end up on one line where the document prints them side by side.
    const rows: Array<{ y: number; items: LayoutItem[] }> = [];
    for (const it of kept) {
      const row = rows.find((r) => Math.abs(r.y - it.y) <= rowTol);
      if (row) { row.items.push(it); row.y = (row.y + it.y) / 2; } else rows.push({ y: it.y, items: [it] });
    }
    for (const row of rows) {
      const ordered = row.items.sort((a, b) => a.x - b.x);
      let line = '';
      let prevEndX: number | null = null;
      for (const it of ordered) {
        const col = Math.round(it.x / charW);
        let pad = col - line.length;
        if (prevEndX != null && it.x - prevEndX > 1.5 && pad < minGap) pad = minGap;
        if (pad > 0) line += ' '.repeat(pad);
        line += it.str;
        prevEndX = it.x + (it.w ?? 0);
      }
      out += line.replace(/\s+$/, '') + '\n';
    }
  }
  return out;
}

/**
 * Browser entry point. pdf.js is imported DYNAMICALLY so neither it nor its ~1.3 MB worker enters
 * the main bundle — the importer is a rare screen and must not tax every page load. The worker is
 * served from /pdfjs (copied out of node_modules by the prebuild script), not bundled.
 *
 * Throws on anything that is not a readable PDF. That is deliberate and the caller depends on it:
 * unreadable is a SKIP (the file never reaches staging), whereas an invoice that reads but does not
 * balance is STAGED and refused at commit. Those are different states and must not be merged.
 */
export async function extractLayoutText(
  file: Blob | ArrayBuffer,
  opts: LayoutOptions = {},
): Promise<string> {
  const pdfjs: any = await import('pdfjs-dist');
  if (typeof window !== 'undefined' && !pdfjs.GlobalWorkerOptions.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.mjs';
  }
  const data = file instanceof ArrayBuffer ? new Uint8Array(file) : new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true, verbosity: 0 }).promise;
  const pages: LayoutItem[][] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const content = await (await doc.getPage(p)).getTextContent();
    pages.push(content.items
      .filter((i: any) => typeof i.str === 'string')
      .map((i: any) => ({ str: i.str, x: i.transform[4], y: i.transform[5], w: i.width ?? 0 })));
  }
  await doc.destroy?.();
  return rebuildLayout(pages, opts);
}
