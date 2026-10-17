-- @migration: constraining it adds unique indexes, foreign keys, a CHECK and two triggers — every one of them on a table this same file creates, and a backfill of a column no deployed client knows
-- @precedes-deploy: every constraint here lands on a table this file CREATES, so nothing deployed can breach one; the Products code that reads catalogue sets and tier availability cannot run until they exist
--
-- Named sets of catalogue items, and a fourth state for a tier price.
--
-- ── WHY constraining AND @precedes-deploy, WHICH LOOK LIKE OPPOSITES ───────────────────────────
-- I first headed this `additive` and the chokepoint refused, correctly: it reads SQL SHAPES, and
-- this file is full of unique indexes, foreign keys, a CHECK and two triggers. Every one of them
-- is on a table created three lines above it. The classifier cannot see that and should not try —
-- "constrains only rows this same file created" is a judgement about intent, and the whole reason
-- the two sources are compared is that neither is trusted alone.
--
-- So it is declared as what it IS by shape, and the real question — can a deployed writer breach
-- any of this — is answered in the @precedes-deploy line, where a reader can check it. Nothing
-- deployed can write a table that does not exist; the `availability` column arrives with a default
-- so an insert that never names it still works; and the backfill rewrites a column the deployed
-- Prisma client does not know about.
--
-- The one part that would genuinely break production is deliberately held back. The CHECK tying
-- `availability` to `price_ex_vat` belongs with these tables, and it would refuse a write from the
-- DEPLOYED Products screen, which knows nothing of the column: a per-job tier price (NULL) would
-- default to `priced` and the CHECK would reject the insert outright. That is the 11 September
-- shape exactly. So the column lands here with a default and no constraint, and the CHECK follows
-- in its own migration AFTER the code is live — where its backfill also repairs any row the old
-- writer created in the window, by the same rule used below. Nothing is rejected; a row written in
-- the gap is corrected rather than refused.
--
-- The two new tables constrain nothing: nothing deployed can write a table that does not exist.

-- CreateEnum
CREATE TYPE "TierAvailability" AS ENUM ('priced', 'per_job', 'not_applicable');

-- AlterTable
ALTER TABLE "CatalogueItemTierPrice" ADD COLUMN     "availability" "TierAvailability" NOT NULL DEFAULT 'priced';

-- BACKFILL, from what each existing row ALREADY MEANT. The two pre-existing states keep their
-- meaning and gain a name: a figure is a published price, a NULL is "offered, priced on the card"
-- (the model comment has said so since the column existed). Nothing moves; nothing is interpreted.
UPDATE "CatalogueItemTierPrice" SET "availability" = 'per_job' WHERE "price_ex_vat" IS NULL;

-- CreateTable
CREATE TABLE "CatalogueSet" (
    "id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "shape" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogueSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogueSetMember" (
    "id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "set_id" TEXT NOT NULL,
    "catalogue_item_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CatalogueSetMember_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CatalogueSet_group_id_idx" ON "CatalogueSet"("group_id");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogueSet_group_id_name_key" ON "CatalogueSet"("group_id", "name");

-- CreateIndex
CREATE INDEX "CatalogueSetMember_group_id_set_id_idx" ON "CatalogueSetMember"("group_id", "set_id");

-- CreateIndex
CREATE INDEX "CatalogueSetMember_catalogue_item_id_idx" ON "CatalogueSetMember"("catalogue_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogueSetMember_set_id_catalogue_item_id_key" ON "CatalogueSetMember"("set_id", "catalogue_item_id");

-- AddForeignKey
ALTER TABLE "CatalogueSet" ADD CONSTRAINT "CatalogueSet_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogueSetMember" ADD CONSTRAINT "CatalogueSetMember_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogueSetMember" ADD CONSTRAINT "CatalogueSetMember_set_id_fkey" FOREIGN KEY ("set_id") REFERENCES "CatalogueSet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogueSetMember" ADD CONSTRAINT "CatalogueSetMember_catalogue_item_id_fkey" FOREIGN KEY ("catalogue_item_id") REFERENCES "CatalogueItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- THE SHAPE IS ONE OF TWO WORDS, and the database says so rather than the writer remembering.
-- It is a String to share lib/quote-options' GROUP_SHAPES vocabulary with QuoteOptionGroupDraft --
-- one vocabulary, no translation -- but a typo'd shape would silently read as "not a ladder" to
-- the trigger below, which is the kind of quiet wrong this codebase keeps paying for.
ALTER TABLE "CatalogueSet" ADD CONSTRAINT "CatalogueSet_shape_known"
  CHECK ("shape" IN ('pick_one', 'base_plus_extras'));

-- ── AT MOST ONE LADDER PER ITEM ────────────────────────────────────────────────────────────────
-- The design said "a partial unique index". POSTGRES CANNOT EXPRESS IT: the predicate needs the
-- set's shape, which lives in another table, and a partial index predicate may not contain a
-- subquery. The intent was a database-level guarantee rather than a rule somebody remembers, so
-- this is a trigger, which is the same guarantee by the only means available.
--
-- TWO TRIGGERS, ONE FUNCTION, because there are two ways to break it: adding a member to a second
-- ladder, and RE-SHAPING a menu the item is already in into a ladder. The second needs no write to
-- CatalogueSetMember at all, so a member-only trigger would be a guard with a hole in it.
CREATE OR REPLACE FUNCTION "catalogue_set_one_ladder_per_item"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE clash TEXT;
BEGIN
  SELECT m.catalogue_item_id INTO clash
    FROM "CatalogueSetMember" m
    JOIN "CatalogueSet" s ON s.id = m.set_id
   WHERE s.shape = 'pick_one'
   GROUP BY m.catalogue_item_id
  HAVING COUNT(DISTINCT m.set_id) > 1
   LIMIT 1;
  IF clash IS NOT NULL THEN
    RAISE EXCEPTION
      'catalogue item % is in more than one pick_one set; the builder could not say which ladder to offer', clash
      USING ERRCODE = '23505';
  END IF;
  RETURN NULL;
END;
$$;

-- AFTER + STATEMENT-level, so a multi-row insert that is legal only once ALL its rows are present
-- is judged on the finished state rather than row by row. The check reads the whole table, which
-- is affordable: a tenant's ladders are tens of rows, not thousands.
CREATE CONSTRAINT TRIGGER "CatalogueSetMember_one_ladder"
  AFTER INSERT OR UPDATE ON "CatalogueSetMember"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "catalogue_set_one_ladder_per_item"();

CREATE CONSTRAINT TRIGGER "CatalogueSet_reshape_one_ladder"
  AFTER UPDATE OF "shape" ON "CatalogueSet"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "catalogue_set_one_ladder_per_item"();
