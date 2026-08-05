/**
 * File: lib/quote-diff.ts
 * WHAT CHANGED between the price the customer agreed to and the price about to be sent.
 * Pure — no prisma — so the endpoint, the panel and the gate read one rule.
 *
 * ── NOT materialKey, DELIBERATELY ───────────────────────────────────────────────────────────────
 * lib/quote-version's materialKey is `description + qty + unit_price + vat_rate`. It answers "is
 * this materially different?", and for that it is right. It cannot answer "what changed?", because
 * a price move on an existing line produces a different key and therefore reads as one REMOVAL plus
 * one ADDITION — which is exactly the sentence a customer must not be sent. Two questions, two
 * rules, and neither stretched over the other's job.
 *
 * ── IT IS NOT A VERSION-TO-VERSION DIFF ─────────────────────────────────────────────────────────
 * At the moment the panel opens, the version about to be sent DOES NOT EXIST — freezeQuoteVersion
 * runs inside quote-send, after the operator commits. So the comparison is the accepted version's
 * FROZEN lines against the card's CURRENT JobCardItem rows, which is precisely what the next freeze
 * will snapshot.
 *
 * ── IT REFUSES RATHER THAN GUESSES ──────────────────────────────────────────────────────────────
 * Matching is by description. Nothing enforces description uniqueness, so when one repeats within
 * either side the pairing is ambiguous and the diff returns INCOMPLETE with a reason. The caller
 * must then fall back to price-only wording AND say why — an operator who gets the short version
 * needs to know the lines could not be matched, not conclude there was nothing to say.
 */

export type DiffLine = { description: string; qty: number; unitPricePennies: number; linePennies: number };
export type DiffChanged = { description: string; fromPennies: number; toPennies: number };

export type QuoteDiff =
  | { complete: true; added: DiffLine[]; removed: DiffLine[]; changed: DiffChanged[] }
  | { complete: false; reason: 'duplicate_descriptions' | 'no_frozen_lines' };

export type DiffInput = { description: string; qty: number; unitPrice: number };

const pennies = (n: number) => Math.round(n * 100);
const norm = (d: string) => String(d ?? '').trim();

export function diffQuoteLines(agreed: DiffInput[], current: DiffInput[]): QuoteDiff {
  // A version frozen with no lines cannot be compared to anything. Real versions always carry them;
  // this guards the case where they were written some other way.
  if (!agreed.length) return { complete: false, reason: 'no_frozen_lines' };

  const keys = (rows: DiffInput[]) => rows.map((r) => norm(r.description));
  const hasDupes = (ks: string[]) => new Set(ks).size !== ks.length;
  if (hasDupes(keys(agreed)) || hasDupes(keys(current))) {
    return { complete: false, reason: 'duplicate_descriptions' };
  }

  const byDesc = (rows: DiffInput[]) => new Map(rows.map((r) => [norm(r.description), r]));
  const A = byDesc(agreed), C = byDesc(current);

  const toLine = (r: DiffInput): DiffLine => ({
    description: norm(r.description), qty: r.qty,
    unitPricePennies: pennies(r.unitPrice), linePennies: pennies(r.qty * r.unitPrice),
  });

  const added: DiffLine[] = [];
  const removed: DiffLine[] = [];
  const changed: DiffChanged[] = [];

  for (const [k, cur] of C) {
    const was = A.get(k);
    if (!was) { added.push(toLine(cur)); continue; }
    const from = pennies(was.qty * was.unitPrice);
    const to = pennies(cur.qty * cur.unitPrice);
    if (from !== to) changed.push({ description: k, fromPennies: from, toPennies: to });
  }
  for (const [k, was] of A) if (!C.has(k)) removed.push(toLine(was));

  return { complete: true, added, removed, changed };
}

/**
 * The prefilled note. It must NEVER assert something the diff cannot verify: "everything else is
 * unchanged" is a claim about lines, so it appears only on a complete comparison. On an incomplete
 * one the operator is told WHY they are getting the short version.
 */
export function prefillNote(args: {
  diff: QuoteDiff;
  agreedPennies: number;
  sendingPennies: number;
  money: (pennies: number) => string;
}): string {
  const { diff, money } = args;
  const priceLine = `Since you approved this, the price has changed from ${money(args.agreedPennies)} to ${money(args.sendingPennies)}.`;

  if (!diff.complete) {
    // Said plainly, and the reason is for the OPERATOR — they are about to send it, and they need
    // to know the itemised version was not withheld by choice.
    const why = diff.reason === 'duplicate_descriptions'
      ? 'Two lines share a description, so the individual changes could not be matched up — please say what changed.'
      : 'The approved version has no saved lines, so the individual changes could not be worked out — please say what changed.';
    return `${priceLine} ${why}`;
  }

  const bits: string[] = [];
  if (diff.added.length) bits.push(`we've added ${list(diff.added.map((l) => `${l.description} (${money(l.linePennies)})`))}`);
  if (diff.removed.length) bits.push(`we've taken off ${list(diff.removed.map((l) => l.description))}`);
  for (const c of diff.changed) bits.push(`${c.description} has changed from ${money(c.fromPennies)} to ${money(c.toPennies)}`);

  if (!bits.length) {
    // Complete comparison, nothing differs — the total moved for some other reason (VAT, rounding).
    // Say only what is true.
    return priceLine;
  }
  const nothingElse = diff.added.length + diff.removed.length + diff.changed.length > 0 ? ' Everything else is unchanged.' : '';
  return `Since you approved this, ${joinBits(bits)}.${nothingElse} The total is now ${money(args.sendingPennies)}.`;
}

const list = (xs: string[]) => xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
const joinBits = (b: string[]) => b.length <= 1 ? b[0] : `${b.slice(0, -1).join(', ')} and ${b[b.length - 1]}`;
