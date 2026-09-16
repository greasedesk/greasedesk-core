/**
 * File: lib/invoice-number.ts
 * THE chokepoints for invoice numbering — nowhere else mints or renders a number.
 *
 *  assignInvoiceNumber(tx, groupId)   → mints the next CHARGEABLE sequence value.
 *  assignVehicleSaleNumber(tx, groupId) → mints the next VEHICLE SALE value (a car sold out of
 *    stock — a second origin, hanging off a StockDisposal rather than a job card).
 *  assignWarrantyNumber(tx, groupId)  → mints the next WARRANTY sequence value (comeback £0
 *    invoices). Fully independent counter — a comeback never burns a chargeable number, and
 *    both series stay independently gapless.
 *  Both are concurrency-safe: a single upsert-increment that Postgres row-locks on conflict, so
 *  two simultaneous issues serialise (no collision, no gap). MUST run inside the caller's
 *  transaction — if the issue rolls back, the increment rolls back with it, so the counter never
 *  gaps or burns a number. Never resets, never reused (the legal no-gaps guarantee).
 *
 *  formatInvoiceNumber(fmt, value)    → renders the value with the tenant's prefix, optional
 *    fiscal-year segment, and zero-padding. FY is a DISPLAY segment derived from the issue date
 *    (e.g. INV-26-0042) — the counter underneath is continuous; FY never resets it.
 */
import type { Prisma } from '@prisma/client';

export async function assignInvoiceNumber(tx: Prisma.TransactionClient, groupId: string): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ last_value: number | bigint }>>`
    INSERT INTO "InvoiceSequence" ("group_id", "last_value")
    VALUES (${groupId}, 1)
    ON CONFLICT ("group_id") DO UPDATE
      SET "last_value" = "InvoiceSequence"."last_value" + 1, "updated_at" = now()
    RETURNING "last_value";
  `;
  return Number(rows[0].last_value);
}

/**
 * The THIRD counter: records of invoices issued elsewhere. Same guarantees as the other two and
 * fully independent of both — recording history must never advance the chargeable counter, which
 * is what spent 177 VAT numbers on documents nobody holds.
 */
export async function assignHistoricalNumber(tx: Prisma.TransactionClient, groupId: string): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ historical_last_value: number | bigint }>>`
    INSERT INTO "InvoiceSequence" ("group_id", "historical_last_value")
    VALUES (${groupId}, 1)
    ON CONFLICT ("group_id") DO UPDATE
      SET "historical_last_value" = "InvoiceSequence"."historical_last_value" + 1, "updated_at" = now()
    RETURNING "historical_last_value";
  `;
  return Number(rows[0].historical_last_value);
}

/**
 * The FIFTH counter: the sale of a car out of stock. Independent of every other for the reason the
 * historical one is — selling a car must never advance the garage's chargeable counter — and because
 * these documents have a SECOND ORIGIN: the card they are carried by is selling a car rather than
 * recording work, so the garage's own numbering has nothing to do with them.
 *
 * NOT a signal about VAT. A margin-scheme car and a qualifying one both mint here and are taxed
 * differently; Invoice.vat_position carries that, and nothing may infer it from the series.
 *
 * CORRECTION to the first version of this note, which said the document "hangs off a StockDisposal,
 * not a job card". It is still carried by a JobCard — Invoice.job_card_id is the spine every
 * downstream reader follows. What differs is the card's ORIGIN: a sale card is marked by
 * sale_of_stock_item_id and bills a vehicle, where every other card bills work.
 */
export async function assignVehicleSaleNumber(tx: Prisma.TransactionClient, groupId: string): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ vehicle_sale_last_value: number | bigint }>>`
    INSERT INTO "InvoiceSequence" ("group_id", "vehicle_sale_last_value")
    VALUES (${groupId}, 1)
    ON CONFLICT ("group_id") DO UPDATE
      SET "vehicle_sale_last_value" = "InvoiceSequence"."vehicle_sale_last_value" + 1, "updated_at" = now()
    RETURNING "vehicle_sale_last_value";
  `;
  return Number(rows[0].vehicle_sale_last_value);
}

export async function assignWarrantyNumber(tx: Prisma.TransactionClient, groupId: string): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ warranty_last_value: number | bigint }>>`
    INSERT INTO "InvoiceSequence" ("group_id", "warranty_last_value")
    VALUES (${groupId}, 1)
    ON CONFLICT ("group_id") DO UPDATE
      SET "warranty_last_value" = "InvoiceSequence"."warranty_last_value" + 1, "updated_at" = now()
    RETURNING "warranty_last_value";
  `;
  return Number(rows[0].warranty_last_value);
}

/**
 * The FOURTH counter: credit notes. Independent of all three others for the reason the historical
 * counter is independent — issuing a VAT correction must never advance the chargeable counter, and
 * VATREC13040 requires a credit note to carry its own identifying number. Sharing the invoice
 * sequence would make a correction indistinguishable from a sale in the series.
 */
export async function assignCreditNoteNumber(tx: Prisma.TransactionClient, groupId: string): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ credit_note_last_value: number | bigint }>>`
    INSERT INTO "InvoiceSequence" ("group_id", "credit_note_last_value")
    VALUES (${groupId}, 1)
    ON CONFLICT ("group_id") DO UPDATE
      SET "credit_note_last_value" = "InvoiceSequence"."credit_note_last_value" + 1, "updated_at" = now()
    RETURNING "credit_note_last_value";
  `;
  return Number(rows[0].credit_note_last_value);
}

export type InvoiceNumberFormat = {
  prefix: string;
  padWidth: number;
  /** 0 = no FY segment; 2 or 4 = digits of the year the fiscal year STARTED in. */
  fyDigits?: number;
  /** 1-12; the month the fiscal year starts (UK default April = 4). */
  fyStartMonth?: number;
  /** The issue date the FY segment is derived from. */
  issuedAt?: Date;
};

/** Year the fiscal year containing `at` started in (e.g. Feb 2026 with April start → 2025). */
export function fiscalYearStart(at: Date, fyStartMonth: number): number {
  const m = Math.min(12, Math.max(1, Math.trunc(fyStartMonth) || 1));
  return at.getUTCMonth() + 1 >= m ? at.getUTCFullYear() : at.getUTCFullYear() - 1;
}

export function formatInvoiceNumber(fmt: InvoiceNumberFormat, sequenceValue: number): string {
  const digits = String(Math.max(0, Math.trunc(sequenceValue)));
  const padded = fmt.padWidth > 0 ? digits.padStart(fmt.padWidth, '0') : digits;
  const fyDigits = fmt.fyDigits ?? 0;
  let fy = '';
  if ((fyDigits === 2 || fyDigits === 4) && fmt.issuedAt) {
    const y = String(fiscalYearStart(fmt.issuedAt, fmt.fyStartMonth ?? 4));
    fy = `${fyDigits === 2 ? y.slice(-2) : y}-`;
  }
  return `${fmt.prefix || ''}${fy}${padded}`;
}

// ── WHICH COUNTER AND WHICH PREFIX, FOR EVERY SERIES ────────────────────────────────────────────
/**
 * THE SERIES, AS VALUES. Matches the InvoiceSeries pg_enum; `seriesNumbering` below is a Record over
 * this union, so adding a series without giving it a counter and a prefix is a COMPILE error rather
 * than a silent fallthrough.
 *
 * That fallthrough was real: the prefix used to be a ternary chain ending in `invoice_prefix`, so any
 * series it did not name would have rendered under the CHARGEABLE prefix while burning its own
 * counter — a document that looks like a garage invoice and is numbered from somewhere else. Nobody
 * would have found that from the number.
 */
export const INVOICE_SERIES = ['chargeable', 'warranty', 'historical', 'vehicle_sale'] as const;
export type InvoiceSeriesName = (typeof INVOICE_SERIES)[number];

/** The tenant's numbering settings — the only Group columns any of this reads. */
export type NumberingProfile = {
  invoice_prefix: string;
  invoice_warranty_prefix: string;
  invoice_historical_prefix: string;
  invoice_vehicle_sale_prefix: string;
  invoice_pad_width: number;
  invoice_fy_digits: number;
  fy_start_month: number;
};

const seriesNumbering: Record<InvoiceSeriesName, {
  assign: (tx: Prisma.TransactionClient, groupId: string) => Promise<number>;
  prefix: (g: NumberingProfile) => string;
}> = {
  chargeable: { assign: assignInvoiceNumber, prefix: (g) => g.invoice_prefix },
  warranty: { assign: assignWarrantyNumber, prefix: (g) => g.invoice_warranty_prefix },
  historical: { assign: assignHistoricalNumber, prefix: (g) => g.invoice_historical_prefix },
  vehicle_sale: { assign: assignVehicleSaleNumber, prefix: (g) => g.invoice_vehicle_sale_prefix },
};

/** Which prefix a series renders under. Pure, so a gate can pin all four without a database. */
export function prefixForSeries(series: InvoiceSeriesName, g: NumberingProfile): string {
  return seriesNumbering[series].prefix(g);
}

/**
 * MINT A NUMBER FOR ANY SERIES — one path, whatever the document's origin.
 *
 * A vehicle sale is carried by a card that sells a car and a garage invoice by one that records
 * work, and the numbering must not care: two origins reaching for their own copy of this is how a
 * counter and a prefix drift out of step. MUST run inside the caller's transaction, like the assigners it calls.
 */
export async function mintSeriesNumber(
  tx: Prisma.TransactionClient,
  groupId: string,
  series: InvoiceSeriesName,
  g: NumberingProfile,
  issuedAt: Date,
): Promise<{ sequenceValue: number; number: string }> {
  const sequenceValue = await seriesNumbering[series].assign(tx, groupId);
  return {
    sequenceValue,
    number: formatInvoiceNumber({
      prefix: prefixForSeries(series, g),
      padWidth: g.invoice_pad_width,
      fyDigits: g.invoice_fy_digits,
      fyStartMonth: g.fy_start_month,
      issuedAt,
    }, sequenceValue),
  };
}
