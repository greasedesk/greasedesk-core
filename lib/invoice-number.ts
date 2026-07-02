/**
 * File: lib/invoice-number.ts
 * THE two chokepoints for invoice numbering — nowhere else mints or renders a number.
 *
 *  assignInvoiceNumber(tx, groupId)  → mints the next monotonic sequence value. Concurrency-safe:
 *    a single upsert-increment that Postgres row-locks on conflict, so two simultaneous issues
 *    serialise (no collision, no gap). MUST run inside the caller's transaction — if the issue
 *    rolls back, the increment rolls back with it, so the counter never gaps or burns a number.
 *    Never resets, never reused (the legal no-gaps guarantee).
 *
 *  formatInvoiceNumber(fmt, value)   → renders the value with the tenant's prefix + zero-padding.
 *    An FY prefix is a format string here, never a reset of the counter.
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

export type InvoiceNumberFormat = { prefix: string; padWidth: number };

export function formatInvoiceNumber(fmt: InvoiceNumberFormat, sequenceValue: number): string {
  const digits = String(Math.max(0, Math.trunc(sequenceValue)));
  const padded = fmt.padWidth > 0 ? digits.padStart(fmt.padWidth, '0') : digits;
  return `${fmt.prefix || ''}${padded}`;
}
