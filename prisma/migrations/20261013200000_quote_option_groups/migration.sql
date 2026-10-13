-- @migration: constraining  two foreign keys land on the existing option tables
-- @precedes-deploy: nothing deployed is constrained by these keys — group_id and is_base are brand-new nullable columns and no live writer touches them — and nothing can deploy ahead of them either, because package.json's build runs `prisma migrate status` in an && chain and exits 1 while ANY migration is pending. There is therefore no order in which the code goes first.
--
-- WHAT THIS ADDS
--   QuoteOptionGroup + QuoteOptionGroupDraft — the group becomes a row, carrying the SHAPE
--     (base_plus_extras | pick_one). A flat list with a bare group_key could hold a set of
--     alternatives and could not hold "a base job plus extras that exist because the base does".
--   QuoteOption/QuoteOptionDraft.group_id (nullable) + is_base — nullable ONLY until the backfill
--     of existing sent versions is proved by rendering them before and after and diffing the
--     output. `kind` and `group_key` are the retiring flat shape and are still written until then.
--   JobCard.quote_preview_hash/_at/_by — the customer view becomes a STEP before send, not a
--     preview button. The hash is of the serialised draft actually rendered, so an edit afterwards
--     invalidates it by divergence and there is no invalidation logic to forget.
--
-- The two ADD CONSTRAINTs are what classify this constraining. They point at tables created in
-- this same migration, so they cannot be folded into those CREATE TABLEs — the dependency runs the
-- other way.

-- AlterTable
ALTER TABLE "JobCard" ADD COLUMN     "quote_preview_at" TIMESTAMP(3),
ADD COLUMN     "quote_preview_by" TEXT,
ADD COLUMN     "quote_preview_hash" TEXT;

-- AlterTable
ALTER TABLE "QuoteOption" ADD COLUMN     "group_id" TEXT,
ADD COLUMN     "is_base" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "QuoteOptionDraft" ADD COLUMN     "group_id" TEXT,
ADD COLUMN     "is_base" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "QuoteOptionGroup" (
    "id" TEXT NOT NULL,
    "quote_version_id" TEXT NOT NULL,
    "shape" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuoteOptionGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuoteOptionGroupDraft" (
    "id" TEXT NOT NULL,
    "job_card_id" TEXT NOT NULL,
    "shape" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuoteOptionGroupDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "QuoteOptionGroup_quote_version_id_position_idx" ON "QuoteOptionGroup"("quote_version_id", "position");

-- CreateIndex
CREATE INDEX "QuoteOptionGroupDraft_job_card_id_position_idx" ON "QuoteOptionGroupDraft"("job_card_id", "position");

-- AddForeignKey
ALTER TABLE "QuoteOptionGroup" ADD CONSTRAINT "QuoteOptionGroup_quote_version_id_fkey" FOREIGN KEY ("quote_version_id") REFERENCES "QuoteVersion"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "QuoteOptionGroupDraft" ADD CONSTRAINT "QuoteOptionGroupDraft_job_card_id_fkey" FOREIGN KEY ("job_card_id") REFERENCES "JobCard"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "QuoteOption" ADD CONSTRAINT "QuoteOption_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "QuoteOptionGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteOptionDraft" ADD CONSTRAINT "QuoteOptionDraft_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "QuoteOptionGroupDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

