-- Navigation management: footer + main-nav links, ordered, region-shaped, config-driven.
CREATE TABLE "NavLink" (
    "id" TEXT NOT NULL,
    "placement" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "country_code" TEXT NOT NULL DEFAULT 'GB',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "NavLink_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "NavLink_placement_country_code_sort_order_idx" ON "NavLink"("placement", "country_code", "sort_order");
