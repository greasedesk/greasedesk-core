-- @migration: constraining it converts three text columns to an enum, relaxes a NOT NULL, and adds two CHECKs and three foreign keys; every affected row count is zero and no deployed writer can breach any of them
-- @precedes-deploy: the affiliate ledger cannot be written until rate_id is nullable and party_type is the enum; the three converted columns hold 0 rows, the CHECK replacing the NOT NULL is satisfied by every deployed writer (which always sets a rate), and nothing deployed writes the new tables
--
-- The affiliate programme: one partner record with a type, the plan every garage bought frozen at
-- signup, the reward terms frozen only where a garage was referred, and the admin knobs the prices
-- are derived from.
--
-- ── THE ENUM HAS THREE VALUES, AND THE THIRD IS THE POINT ─────────────────────────────────────
-- TenantAttribution.party_type and RepVisit.party_type were commented 'rep' | 'operator' and held
-- NO ROWS. A two-value enum would have compiled, migrated, and silently deleted a designed
-- capability: docs/rep-system.md §2 has a garage attributing to a rep AND a regional manager at
-- once, share_bp splitting one payment between them, and a regional manager is an operator.
-- Nothing writes it today, which is exactly why nothing would have complained.
--
-- ── THE CASTS ARE IN PLACE, NOT DROP-AND-ADD ─────────────────────────────────────────────────
-- AND THE INDEX REBUILDS CAME OUT WITH THEM. The generated DROP/ADD also re-created the two
-- (party_type, party_id) indexes, because dropping a column drops its indexes. Swapping in a cast
-- leaves those indexes in place, so the CREATE INDEX statements then collided — this migration
-- failed once, on exactly that, before they were removed. Postgres rolled the whole file back:
-- nothing was applied, and the only residue was the failed marker row.
-- Prisma proposes DROP COLUMN + ADD COLUMN for a text→enum change, which is lossless here only
-- because these tables are empty on THIS database. A USING cast is correct either way, and this
-- file should not be a statement about which database it happens to run against first.
--
-- ── WHY rate_id STOPS BEING NOT NULL ─────────────────────────────────────────────────────────
-- A rep entry freezes the CommissionRate it was paid at; an affiliate has no rate, because the
-- reward is frozen in TenantAffiliateTerms — a rate resolves at COLLECTION and the owner's rule is
-- that a garage keeps the terms it SIGNED UP under. Dropping the NOT NULL alone would quietly let
-- a rep entry exist with no frozen rate, so the invariant moves into a CHECK. Written
-- `= 'affiliate'` rather than `<> 'rep'` so an OPERATOR entry still has to carry a rate.
--
-- NO BACKFILL HERE. Every garage needs a TenantPlanTerms row, but what to write is a CLAIM about
-- history, not something derivable — see the next migration.

-- CreateEnum
CREATE TYPE "PartyType" AS ENUM ('rep', 'affiliate', 'operator');

-- AlterTable
ALTER TABLE "CommissionEntry" ALTER COLUMN "party_type" TYPE "PartyType" USING "party_type"::"PartyType",
ALTER COLUMN "rate_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Rep" ADD COLUMN     "age_verified_at" TIMESTAMP(3),
ADD COLUMN     "find_method" TEXT,
ADD COLUMN     "party_type" "PartyType" NOT NULL DEFAULT 'rep',
ADD COLUMN     "social_handle" TEXT,
ADD COLUMN     "suspended_at" TIMESTAMP(3),
ADD COLUMN     "terms_accepted_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "RepVisit" ALTER COLUMN "party_type" TYPE "PartyType" USING "party_type"::"PartyType";

-- AlterTable
ALTER TABLE "TenantAttribution" ALTER COLUMN "party_type" TYPE "PartyType" USING "party_type"::"PartyType";

-- CreateTable
CREATE TABLE "TenantPlanTerms" (
    "id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "plan" TEXT NOT NULL,
    "months_paid" INTEGER,
    "months_given" INTEGER,
    "paid_now_pennies" INTEGER,
    "trial_days" INTEGER,
    "signed_up_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantPlanTerms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TenantAffiliateTerms" (
    "id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "affiliate_id" TEXT NOT NULL,
    "total_reward_pennies" INTEGER NOT NULL,
    "instalment_pennies" INTEGER NOT NULL,
    "signed_up_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantAffiliateTerms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProgrammeSettings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "trial_days" INTEGER NOT NULL DEFAULT 30,
    "new_annual_months_paid" INTEGER NOT NULL DEFAULT 9,
    "renewal_annual_months_paid" INTEGER NOT NULL DEFAULT 10,
    "offer_months_paid" INTEGER NOT NULL DEFAULT 6,
    "months_given" INTEGER NOT NULL DEFAULT 12,
    "total_reward_pennies" INTEGER NOT NULL DEFAULT 12000,
    "instalment_pennies" INTEGER NOT NULL DEFAULT 3000,
    "minimum_payout_pennies" INTEGER NOT NULL DEFAULT 10000,
    "affiliate_signups_open" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProgrammeSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TenantPlanTerms_group_id_key" ON "TenantPlanTerms"("group_id");

-- CreateIndex
CREATE UNIQUE INDEX "TenantAffiliateTerms_group_id_key" ON "TenantAffiliateTerms"("group_id");

-- CreateIndex
CREATE INDEX "TenantAffiliateTerms_affiliate_id_idx" ON "TenantAffiliateTerms"("affiliate_id");



-- AddForeignKey
ALTER TABLE "TenantPlanTerms" ADD CONSTRAINT "TenantPlanTerms_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantAffiliateTerms" ADD CONSTRAINT "TenantAffiliateTerms_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantAffiliateTerms" ADD CONSTRAINT "TenantAffiliateTerms_affiliate_id_fkey" FOREIGN KEY ("affiliate_id") REFERENCES "Rep"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── TRIAL OR PAY NOW, NEVER BOTH ─────────────────────────────────────────────────────────────
-- The owner's rule, made physical. Monthly carries a trial and takes nothing at signup; every
-- annual shape takes payment and has no trial, because the trial IS the discount taken at the
-- front. A plan claiming both, or neither, is a contradiction no screen could render honestly.
ALTER TABLE "TenantPlanTerms" ADD CONSTRAINT "TenantPlanTerms_trial_xor_paynow"
  CHECK ((trial_days IS NOT NULL AND paid_now_pennies IS NULL)
      OR (trial_days IS NULL AND paid_now_pennies IS NOT NULL));

ALTER TABLE "CommissionEntry" ADD CONSTRAINT "CommissionEntry_rate_unless_affiliate"
  CHECK (party_type = 'affiliate' OR rate_id IS NOT NULL);
