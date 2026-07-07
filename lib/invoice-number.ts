/**
 * File: lib/invoice-number.ts
 * THE chokepoints for invoice numbering — nowhere else mints or renders a number.
 *
 *  assignInvoiceNumber(tx, groupId)   → mints the next CHARGEABLE sequence value.
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
