/**
 * File: lib/db.ts
 * Last edited: 2025-11-13 at 10:50 (FIXED)
 *
 * This file initializes the real Prisma Client for the entire application.
 * It uses a "singleton" pattern to prevent multiple instances
 * of Prisma Client from being created in the development environment
 * due to Next.js's hot-reloading.
 *
 * ── OPT-IN RETRY FOR LONG LOCAL RUNS (DB_RETRY_TRANSIENT=1) ─────────────────────────────────────
 * OFF unless the env var is set, so nothing about a Vercel request changes. It exists for the bulk
 * scripts — the demo generator writes for five minutes straight, and four consecutive runs died
 * partway through on transient drops while a 60-shot soak of the same endpoint came back clean on
 * both the pooled and direct URLs. Losing 550 cards of work to one stalled round-trip is not a
 * failure worth respecting.
 *
 * WHICH ERRORS, AND WHY THE SPLIT MATTERS. A retry is only safe when the statement did not run.
 *   P1001/P1002/P2024 — raised while OBTAINING a connection, so nothing was sent. Any operation,
 *                       including a create, can be retried: there is nothing to duplicate.
 *   P1017/P2028       — the server closed a connection, or a transaction vanished, MID-FLIGHT. A
 *                       write may well have committed before the answer was lost, so only naturally
 *                       idempotent operations are retried here. A create is allowed to fail.
 * Anything else — a constraint violation, a gate refusal — is never retried. Those are the caller
 * being wrong, and repeating them only hides it.
 */
import { PrismaClient } from '@prisma/client';

/** Never sent: the connection itself could not be obtained. Safe to repeat anything. */
const NEVER_SENT = new Set(['P1001', 'P1002', 'P2024']);
/** Possibly sent: only repeat operations that are the same run twice as once. */
const MAYBE_SENT = new Set(['P1017', 'P2028']);
/** Same result whether applied once or five times. `create` is conspicuously absent. */
const IDEMPOTENT = new Set([
  'findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany',
  'count', 'aggregate', 'groupBy',
  'update', 'updateMany', 'upsert', 'delete', 'deleteMany',
]);

const RETRIES = 6;

// We declare a global variable to hold the Prisma instance.
// We have to cast 'globalThis' to 'any' to attach our custom property.
// Typed, not `any`. This one word was the reason a forgotten `select` compiled: `globalThis as any`
// made the `??` below `any`, and every query in the codebase inherited it.
const globalForPrisma = globalThis as unknown as { prisma?: ReturnType<typeof baseClient> };

function baseClient() {
  return new PrismaClient({
    // Optional: uncomment the line below to see your database queries in the terminal
    // log: ['query'],
  });
}

function withTransientRetry(client: PrismaClient) {
  return client.$extends({
    query: {
      async $allOperations({ operation, args, query }: any) {
        for (let attempt = 1; ; attempt++) {
          try {
            return await query(args);
          } catch (e: any) {
            const code = e?.code;
            const canRetry = NEVER_SENT.has(code) || (MAYBE_SENT.has(code) && IDEMPOTENT.has(operation));
            if (!canRetry || attempt >= RETRIES) throw e;
            const backoff = Math.min(8_000, 400 * 2 ** (attempt - 1));
            console.warn(`[db] ${code} on ${operation}, attempt ${attempt}/${RETRIES} — retrying in ${backoff}ms`);
            await new Promise((res) => setTimeout(res, backoff));
          }
        }
      },
    },
  });
}

// Check if prisma is already attached to the global object.
// If not, create a new instance and attach it.
// This is crucial for Next.js hot-reloading.
/**
 * ONE CONCRETE TYPE, not a union of two.
 *
 * DB_RETRY_TRANSIENT picks base-or-extended at RUNTIME, and typing that honestly as a union costs
 * 200 errors across 87 files — `$extends` gives `$transaction` a different callback parameter type,
 * so every `async (tx: Prisma.TransactionClient) => …` in the codebase stops matching. Collapsing
 * to the base client's type costs 14 errors in 9 files and changes no runtime behaviour: the
 * extension only wraps operations in a retry, it adds no methods and removes none.
 *
 * The cast is doing real work and is worth the comment. Deleting it does not make the code safer,
 * it makes 200 errors appear and someone revert the whole thing.
 */
export const prisma: ReturnType<typeof baseClient> = (globalForPrisma.prisma
  ?? (process.env.DB_RETRY_TRANSIENT === '1' ? withTransientRetry(baseClient()) : baseClient())) as ReturnType<typeof baseClient>;

// REMOVED: export default prisma; <--- THIS WAS THE CONFLICTING LINE

// In development, attach prisma to the global object...
if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
