-- AlterTable
ALTER TABLE "JobCard" ADD COLUMN     "flag_customer_car" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "flag_diag" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "flag_mot" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "flag_sales_car" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "flag_urgent" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "stage_complete_done" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "stage_details_done" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "stage_injob_done" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "stage_intake_done" BOOLEAN NOT NULL DEFAULT false;
