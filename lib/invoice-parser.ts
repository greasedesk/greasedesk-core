/**
 * File: lib/invoice-parser.ts
 * THE parser for imported invoice text layers (Xero PDF via pdftotext -layout).
 *
 * Ported verbatim in behaviour from the version proven against TMBS May 2026: 42/42 invoices
 * reconciled, parsed line amounts equal to each invoice's own printed Subtotal.
 *
 * FOUR FORMAT CASES, each of which broke an earlier attempt and each of which is load-bearing:
 *   1. FOUR numeric columns — Quantity | Unit Price | VAT | Amount GBP. A three-column assumption
 *      silently matched the LAST two numbers, zeroing every quantity AND dropping real service
 *      lines whose continuations then attached to the wrong parent.
 *   2. Unit prices to FOUR decimals (133.3333), not two.
 *   3. Accounting negatives in PARENTHESES: (1,537.3667) is a credit, not a positive.
 *   4. The VAT column may read 'No VAT' as TEXT, or 'n%', or be blank.
 *
 * RECONCILIATION IS THE PROOF, not the regex. reconcile() compares the sum of parsed line amounts
 * against the printed Subtotal; the commit path refuses anything that does not balance. A parser
 * that agrees with itself is worth nothing — this one is checked against the document.
 */

export type ParsedLine = {
  position: number;
  description: string;
  continuation: string[]; // verbatim; these describe the operations actually performed
  qty: number;
  unitPrice: number;
  vatText: string;
  amount: number;
  isAdjustment: boolean; // negative → a credit; costs 0.00 and never prompts
  isInformational: boolean; // zero-priced header (Registration/Vin/Mileage, MOT expiry note)
};

export type ParsedInvoice = {
  externalNumber: string | null;
  issueDate: Date | null;
  registration: string | null;
  lines: ParsedLine[];
  subtotalPrinted: number | null;
  vatPrinted: number | null;
  totalPrinted: number | null;
};

// A number is either plain (optionally signed) or parenthesised-negative. 2–6 dp.
const NUM = String.raw`(?:-?[\d,]+\.\d{2,6}|\([\d,]+\.\d{2,6}\))`;
const PRICED = new RegExp(
  String.raw`^(?<desc>.*?\S)\s{2,}` +
  String.raw`(?<qty>${NUM})\s+` +
  String.raw`(?<price>${NUM})\s+` +
  String.raw`(?:(?<vat>\d+(?:\.\d+)?%|No VAT)\s+)?` +
  String.raw`(?<amount>${NUM})\s*$`,
);
const NUMISH = /[\d,]+\.\d{2,6}/;
const INFO = /^(registration|reg|vin|mileage|odometer|advisory|advisories|mot expiry|mot advisory|quote|quotation|estimate|note|notes|next service)\b/i;

const MONTHS = 'january february march april may june july august september october november december'.split(' ');

/** Parenthesised negatives → a negative number. '(1,537.3667)' → -1537.3667 */
export function parseAmount(raw: string): number {
  const s = raw.trim();
  const neg = s.startsWith('(') && s.endsWith(')');
  const v = Number((neg ? s.slice(1, -1) : s).replace(/,/g, ''));
  return neg ? -v : v;
}

function parseDate(s: string): Date | null {
  const m = s.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (!m) return null;
  const mon = MONTHS.findIndex((x) => x.startsWith(m[2].toLowerCase().slice(0, 3)));
  if (mon < 0) return null;
  return new Date(Date.UTC(Number(m[3]), mon, Number(m[1])));
}

/** Read a labelled value that Xero prints on the line BELOW its label. */
function valueUnderLabel(lines: string[], label: RegExp, within = 4): string | null {
  for (let i = 0; i < lines.length; i++) {
    if (label.test(lines[i])) {
      for (let j = i + 1; j < Math.min(i + within, lines.length); j++) {
        const t = lines[j].trim();
        if (t) return t;
      }
    }
  }
  return null;
}

export function parseInvoiceText(text: string): ParsedInvoice {
  const lines = text.split(/\r?\n/);

  // The date is printed UNDER its label. NOTE: do NOT derive it from Due Date minus the payment
  // terms — that inference was wrong on this very set (it put invoices in April that are in May).
  const dateStr = valueUnderLabel(lines, /\bInvoice Date\b/);
  const issueDate = dateStr ? parseDate(dateStr) : null;

  const numStr = valueUnderLabel(lines, /\bInvoice Number\b/);
  const externalNumber = numStr ? (numStr.match(/\d{6,}/)?.[0] ?? null) : null;

  const regLine = lines.find((l) => /^\s*Registration:/i.test(l));
  const registration = regLine ? (regLine.split(':')[1]?.trim().split(/\s{2,}/)[0] ?? null) : null;

  // The line table runs from the column header to the Subtotal row.
  let start = -1, end = -1;
  for (let i = 0; i < lines.length; i++) {
    if (start < 0 && /\bDescription\b/.test(lines[i]) && /\bQuantity\b/.test(lines[i])) start = i + 1;
    else if (start >= 0 && /\bSubtotal\b/.test(lines[i])) { end = i; break; }
  }
  if (start < 0) start = 0;
  if (end < 0) end = lines.length;

  const out: ParsedLine[] = [];
  let current: ParsedLine | null = null;
  for (const raw of lines.slice(start, end)) {
    const l = raw.replace(/\s+$/, '');
    if (!l.trim()) continue;
    const m = PRICED.exec(l);
    if (m && m.groups) {
      const price = parseAmount(m.groups.price);
      const amount = parseAmount(m.groups.amount);
      const desc = m.groups.desc.trim();
      current = {
        position: out.length,
        description: desc,
        continuation: [],
        qty: parseAmount(m.groups.qty),
        unitPrice: price,
        vatText: (m.groups.vat ?? '').trim(),
        amount,
        isAdjustment: amount < 0 || price < 0,
        isInformational: Math.abs(amount) < 0.005 && Math.abs(price) < 0.005 && (INFO.test(desc) || true),
      };
      out.push(current);
    } else if (current && !NUMISH.test(l)) {
      const t = l.trim();
      if (t) current.continuation.push(t);
    }
  }

  const money = (label: RegExp) => {
    for (const l of lines) {
      if (label.test(l)) {
        const m = l.match(/(\(?[\d,]+\.\d{2}\)?)\s*$/);
        if (m) return parseAmount(m[1]);
      }
    }
    return null;
  };

  return {
    externalNumber,
    issueDate,
    registration,
    lines: out,
    subtotalPrinted: money(/\bSubtotal\b/),
    vatPrinted: money(/TOTAL VAT/i),
    totalPrinted: money(/TOTAL GBP/i),
  };
}

/**
 * THE HARD COMMIT GATE. Parsed line amounts must equal the printed Subtotal.
 * Tolerance is half a penny — this is an equality check, not an approximation.
 */
export function reconcile(p: ParsedInvoice): { ok: boolean; parsed: number; printed: number | null; diff: number | null } {
  const parsed = Math.round(p.lines.reduce((a, l) => a + l.amount, 0) * 100) / 100;
  if (p.subtotalPrinted == null) return { ok: false, parsed, printed: null, diff: null };
  const diff = Math.round((parsed - p.subtotalPrinted) * 100) / 100;
  return { ok: Math.abs(diff) < 0.005, parsed, printed: p.subtotalPrinted, diff };
}

/** Billable lines: everything that is neither a zero-priced header nor blank. */
export const billableLines = (p: ParsedInvoice): ParsedLine[] => p.lines.filter((l) => !l.isInformational);
