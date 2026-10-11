-- @migration: additive
--
-- ONE NEW TABLE for per-tenant export jobs. Nothing deployed reads or writes it.
--
-- THE FOREIGN KEY IS FOLDED INTO THE CREATE TABLE, not left as the `ALTER TABLE ... ADD CONSTRAINT`
-- that `prisma migrate diff` emits. That statement classifies CONSTRAINING — "an existing writer
-- may already breach it" — which is correct in general and cannot be true of a table created three
-- lines earlier with no rows and no deployed writer. Satisfying the rule beats declaring past it.
-- The constraint keeps Prisma's own name, so `migrate diff` stays empty.
-- Same move as 20261011190000_backup_run made for its UNIQUE.

-- CreateTable
CREATE TABLE "ExportJob" (
    "id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "requested_by_user_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "object_key" TEXT,
    "bytes" BIGINT,
    "row_total" INTEGER,
    "file_count" INTEGER,
    "blob_count" INTEGER,
    "blob_missing" INTEGER,
    "manifest_json" JSONB,
    "failed_reason" TEXT,
    "downloaded_at" TIMESTAMP(3),
    "download_count" INTEGER NOT NULL DEFAULT 0,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExportJob_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ExportJob_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

-- CreateIndex
CREATE INDEX "ExportJob_group_id_requested_at_idx" ON "ExportJob"("group_id", "requested_at");


