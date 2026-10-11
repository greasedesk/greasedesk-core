-- @migration: additive
--
-- ONE NEW TABLE, nothing deployed can reach it. Eleven nightly backups failed in September with no
-- record anybody could see; this is where each attempt now lands.
--
-- THE UNIQUE IS FOLDED INTO THE CREATE TABLE, not left as the separate CREATE UNIQUE INDEX that
-- `prisma migrate diff` emits. That statement classifies CONSTRAINING even on a table created in
-- the same file — "production may already create duplicates" — and the right answer is to satisfy
-- the rule rather than declare past it. Postgres names an inline column UNIQUE
-- "<table>_<column>_key", which is the name Prisma expects, so `migrate diff` stays empty.
-- Same move as 20260913190000_stock_records, for the same reason.

-- CreateTable
CREATE TABLE "BackupRun" (
    "id" TEXT NOT NULL,
    "stamp" TEXT NOT NULL UNIQUE,
    "started_at" TIMESTAMP(3) NOT NULL,
    "finished_at" TIMESTAMP(3),
    "outcome" TEXT NOT NULL,
    "failed_step" TEXT,
    "object_key" TEXT,
    "bytes" BIGINT,
    "sha256" TEXT,
    "database_name" TEXT,
    "table_count" INTEGER,
    "total_rows" INTEGER,
    "migrations" INTEGER,
    "pg_version" TEXT,
    "golden_json" JSONB,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BackupRun_pkey" PRIMARY KEY ("id")
);


-- CreateIndex
CREATE INDEX "BackupRun_started_at_idx" ON "BackupRun"("started_at");

