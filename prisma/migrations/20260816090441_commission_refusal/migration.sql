-- The absence of money, recorded.
--
-- A commission accrual the engine REFUSED to make — no rate for the tier a tenant just moved into,
-- shares not summing to 10000, a tenant it could not load — used to leave nothing behind but a
-- console.error. A rep quietly earned nothing and the only witness was a log line in Vercel.
--
-- Deliberately NOT a CommissionEntry: an entry is a sum and every reader of the ledger adds them
-- up, so a zero-value "refused" entry would be an accrual of nothing rather than a refusal to
-- accrue. Deliberately NOT an AuditLog row either: that is the TENANT's trail and a garage can read
-- theirs — what we pay a rep for their signup is not the garage's business.
--
-- HAND-WRITTEN, NOT GENERATED. `prisma migrate diff` against the live database also proposed
-- dropping NotificationLog_direction_thread_id_idx and altering Group.ref's default — pre-existing
-- drift, unrelated to this change, and not something to sweep into a migration about commission.
-- Only the new table is here.
--
-- Additive: one new table, nothing existing touched, no rows created. An empty table is the correct
-- state — no refusal has happened yet.

-- CreateTable
CREATE TABLE "CommissionRefusal" (
    "id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "source_ref" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "detail" JSONB,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "CommissionRefusal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CommissionRefusal_resolved_at_idx" ON "CommissionRefusal"("resolved_at");

-- CreateIndex
CREATE INDEX "CommissionRefusal_group_id_idx" ON "CommissionRefusal"("group_id");

-- CreateIndex: a re-delivered webhook records once, not once per retry.
CREATE UNIQUE INDEX "CommissionRefusal_group_id_source_ref_code_key" ON "CommissionRefusal"("group_id", "source_ref", "code");

-- AddForeignKey
ALTER TABLE "CommissionRefusal" ADD CONSTRAINT "CommissionRefusal_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;
