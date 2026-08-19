-- The due-items block AS PRINTED, frozen at mint. Merges captured findings with the DVSA MOT
-- expiry as it stood that day: both move afterwards, and a reprint must show neither change.

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "due_items_snapshot" TEXT;

