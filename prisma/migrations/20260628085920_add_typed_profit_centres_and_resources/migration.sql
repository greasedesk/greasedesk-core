-- CreateEnum
CREATE TYPE "ProfitCentreCategory" AS ENUM ('repairs', 'mot', 'spraybooth', 'car_sales');

-- CreateEnum
CREATE TYPE "ResourceType" AS ENUM ('lift', 'mot_bay', 'spray_booth');

-- AlterTable
ALTER TABLE "ProfitCentre" ADD COLUMN     "category" "ProfitCentreCategory";

-- CreateTable
CREATE TABLE "Resource" (
    "id" TEXT NOT NULL,
    "profit_centre_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "ResourceType" NOT NULL,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Resource_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Resource_profit_centre_id_idx" ON "Resource"("profit_centre_id");

-- AddForeignKey
ALTER TABLE "Resource" ADD CONSTRAINT "Resource_profit_centre_id_fkey" FOREIGN KEY ("profit_centre_id") REFERENCES "ProfitCentre"("id") ON DELETE CASCADE ON UPDATE CASCADE;
