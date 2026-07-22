-- Content system: one table, two behaviours (legal freeze vs page latest-wins), country axis, string
-- version stamp. Unique (slug, country, version) enforces one 'draft' per slug+country and immutable
-- published version stamps.
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "country_code" TEXT NOT NULL DEFAULT 'GB',
    "body" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "effective_from" TIMESTAMP(3),
    "published_at" TIMESTAMP(3),
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Document_slug_country_code_version_key" ON "Document"("slug", "country_code", "version");
CREATE INDEX "Document_slug_country_code_status_idx" ON "Document"("slug", "country_code", "status");
