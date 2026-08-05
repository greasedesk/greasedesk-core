/**
 * File: lib/catalogue-retire.ts
 * THE rule for whether a price-list entry may be DELETED or only RETIRED. Pure — no prisma — so the
 * endpoint and the screen read one decision and the button can never offer what the API refuses.
 *
 * ── WHY A USED SERVICE STOPS BEING REMOVABLE ────────────────────────────────────────────────────
 * `JobCardItem.catalogue_item_id` is `onDelete: SetNull`. Deleting one service therefore rewrites
 * every historic line it ever priced — silently, with no error and, until this file existed, no
 * audit row. A `fixed` line can only be created by picking from the catalogue (the estimate builder
 * has add buttons for labour and part only), so `item_type: 'fixed'` with a null link is a line
 * whose origin was destroyed. That is the provenance the quoting figures are read from.
 *
 * Same shape as refuseIfVoid: a record that has been USED stops being removable. It does not stop
 * being retirable — `CatalogueItem.active` already exists for exactly this, and the estimate picker
 * already filters on it (lib/jobcard-page-data). Retiring keeps every historic line intact and
 * removes the service from the picker, which is what "we don't sell that any more" actually means.
 *
 * ── AND WHY A PROMOTION COUNTS AS USE (ruling 2026-08-05) ───────────────────────────────────────
 * PromoTarget cascades on delete. A service sitting in a live discount code is in use in a way that
 * reaches customers: deleting it silently narrows what the promo covers, while the promo goes on
 * looking correctly configured. That is a quieter failure than the job-line one, so it blocks too —
 * even on an item that has never priced a single line.
 *
 * ── WHAT IS NOT PROTECTED HERE ──────────────────────────────────────────────────────────────────
 * InvoiceLine.catalogue_item_id has NO foreign key ("forward hook; NO FK yet"), so the frozen
 * ledger survives a delete regardless — it is not part of this test. Separately, invoices frozen
 * from an accepted QuoteVersion already lose the link at issue because QuoteVersionLine never
 * carried one (lib/invoice-issue). That is a real provenance gap and a SEPARATE slice; nothing here
 * fixes it, and nothing here makes it worse.
 */

export type CatalogueUsage = {
  /** Job-card lines that were priced from this service. */
  jobLines: number;
  /** Promotions whose coverage names this service. */
  promoTargets: number;
};

export type CatalogueRefusal = {
  code: 'in_use';
  /** Plain sentence for the operator, naming the counts and what to do instead. */
  message: string;
  usage: CatalogueUsage;
};

export const isCatalogueUsed = (u: CatalogueUsage): boolean => u.jobLines > 0 || u.promoTargets > 0;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * NULL = safe to delete outright. A price list accumulates typos and abandoned entries, and one
 * that can only ever grow becomes unusable — so an entry nothing has touched is genuinely removable.
 */
export function catalogueDeleteRefusal(usage: CatalogueUsage): CatalogueRefusal | null {
  if (!isCatalogueUsed(usage)) return null;

  const parts: string[] = [];
  if (usage.jobLines > 0) parts.push(`has priced ${plural(usage.jobLines, 'job line', 'job lines')}`);
  if (usage.promoTargets > 0) parts.push(`is covered by ${plural(usage.promoTargets, 'promotion', 'promotions')}`);

  return {
    code: 'in_use',
    message:
      `This service ${parts.join(' and ')}, so it can't be deleted — that would rewrite what those records say it was. ` +
      `Retire it instead: the history stays exactly as it is and the service disappears from the estimate picker.`,
    usage,
  };
}
