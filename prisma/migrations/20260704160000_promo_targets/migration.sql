-- Percentage-promo product targets. Additive only.
CREATE TABLE "PromoTarget" (
    "id" TEXT NOT NULL,
    "promo_id" TEXT NOT NULL,
    "catalogue_item_id" TEXT NOT NULL,
    CONSTRAINT "PromoTarget_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PromoTarget_promo_id_catalogue_item_id_key" ON "PromoTarget"("promo_id", "catalogue_item_id");
CREATE INDEX "PromoTarget_promo_id_idx" ON "PromoTarget"("promo_id");
CREATE INDEX "PromoTarget_catalogue_item_id_idx" ON "PromoTarget"("catalogue_item_id");

ALTER TABLE "PromoTarget" ADD CONSTRAINT "PromoTarget_promo_id_fkey"
    FOREIGN KEY ("promo_id") REFERENCES "Promo"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PromoTarget" ADD CONSTRAINT "PromoTarget_catalogue_item_id_fkey"
    FOREIGN KEY ("catalogue_item_id") REFERENCES "CatalogueItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
