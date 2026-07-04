-- Promotions: reusable VAT-aware discount codes (tenant-level). Additive only.
CREATE TYPE "PromoType" AS ENUM ('fixed', 'percentage');

CREATE TABLE "Promo" (
    "id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "promo_type" "PromoType" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Promo_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Promo_group_id_code_key" ON "Promo"("group_id", "code");
CREATE INDEX "Promo_group_id_idx" ON "Promo"("group_id");

ALTER TABLE "Promo" ADD CONSTRAINT "Promo_group_id_fkey"
    FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;
