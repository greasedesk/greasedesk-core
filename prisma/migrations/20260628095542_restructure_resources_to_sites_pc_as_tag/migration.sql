/*
  Warnings:

  - You are about to drop the column `profit_centre_id` on the `Resource` table. All the data in the column will be lost.
  - Added the required column `site_id` to the `Resource` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "Resource" DROP CONSTRAINT "Resource_profit_centre_id_fkey";

-- DropIndex
DROP INDEX "Resource_profit_centre_id_idx";

-- AlterTable
ALTER TABLE "Booking" ALTER COLUMN "profit_centre_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "JobCard" ALTER COLUMN "profit_centre_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Resource" DROP COLUMN "profit_centre_id",
ADD COLUMN     "site_id" TEXT NOT NULL;

-- CreateIndex
CREATE INDEX "Resource_site_id_idx" ON "Resource"("site_id");

-- AddForeignKey
ALTER TABLE "Resource" ADD CONSTRAINT "Resource_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
