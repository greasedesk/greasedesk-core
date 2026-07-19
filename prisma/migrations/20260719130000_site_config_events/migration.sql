-- Effective-dated Site configuration, mirroring EmploymentEvent.
--
-- open_days was a single current value, so EVERY historical window was computed against today's
-- trading pattern. Great Bridge traded Mon-Sat until 2026-04-01 and Mon-Fri after; any pre-April
-- period therefore understated capacity for anyone inheriting the site pattern.
--
-- Additive only: the flat Site columns stay as current-state truth and the resolver's final
-- fallback. No existing row is read or changed by this migration.

CREATE TYPE "SiteConfigEventKind" AS ENUM ('open_days', 'hours', 'breaks');

CREATE TABLE "SiteConfigEvent" (
  "id"              TEXT NOT NULL,
  "group_id"        TEXT NOT NULL,
  "site_id"         TEXT NOT NULL,
  "kind"            "SiteConfigEventKind" NOT NULL,
  "effective_date"  TIMESTAMP(3) NOT NULL,
  "value_json"      JSONB NOT NULL,
  "previous_json"   JSONB,
  "changed_by"      TEXT,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "correction_json" JSONB,
  "voided_at"       TIMESTAMP(3),
  "voided_by"       TEXT,
  CONSTRAINT "SiteConfigEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SiteConfigEvent_site_id_kind_effective_date_idx"
  ON "SiteConfigEvent"("site_id", "kind", "effective_date");
CREATE INDEX "SiteConfigEvent_group_id_created_at_idx"
  ON "SiteConfigEvent"("group_id", "created_at");

ALTER TABLE "SiteConfigEvent" ADD CONSTRAINT "SiteConfigEvent_group_id_fkey"
  FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SiteConfigEvent" ADD CONSTRAINT "SiteConfigEvent_site_id_fkey"
  FOREIGN KEY ("site_id") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
