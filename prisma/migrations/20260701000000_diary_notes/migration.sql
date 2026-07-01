-- Additive: new DiaryNote table (lightweight labelled diary entries; not job cards).
CREATE TABLE "DiaryNote" (
  "id"          TEXT NOT NULL,
  "group_id"    TEXT NOT NULL,
  "site_id"     TEXT NOT NULL,
  "resource_id" TEXT,
  "title"       TEXT NOT NULL,
  "start_at"    TIMESTAMP(3) NOT NULL,
  "end_at"      TIMESTAMP(3) NOT NULL,
  "colour"      TEXT,
  "created_by"  TEXT,
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DiaryNote_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "DiaryNote_site_id_start_at_idx" ON "DiaryNote"("site_id", "start_at");
ALTER TABLE "DiaryNote" ADD CONSTRAINT "DiaryNote_group_id_fkey"    FOREIGN KEY ("group_id")    REFERENCES "Group"("id")    ON DELETE CASCADE  ON UPDATE CASCADE;
ALTER TABLE "DiaryNote" ADD CONSTRAINT "DiaryNote_site_id_fkey"     FOREIGN KEY ("site_id")     REFERENCES "Site"("id")     ON DELETE CASCADE  ON UPDATE CASCADE;
ALTER TABLE "DiaryNote" ADD CONSTRAINT "DiaryNote_resource_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "Resource"("id") ON DELETE SET NULL ON UPDATE CASCADE;
