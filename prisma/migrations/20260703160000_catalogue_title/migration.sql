-- Catalogue title field: a human label for "choose a service" pickers, distinct from code (reference)
-- and the printed spec. Additive nullable column; existing rows backfilled title = code so nothing
-- reads blank (Hugh renames after). Consumers show `title || code`.
ALTER TABLE "CatalogueItem" ADD COLUMN "title" TEXT;
UPDATE "CatalogueItem" SET "title" = "code" WHERE "title" IS NULL;
