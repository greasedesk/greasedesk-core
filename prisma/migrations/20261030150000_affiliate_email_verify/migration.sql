-- @migration: constraining it REPLACES RepMagicLink_purpose_chk, and for the moment between the DROP and the ADD there is no CHECK on that column at all — the only write it can affect, and it accepts strictly more than before
-- @precedes-deploy: it REPLACES RepMagicLink_purpose_chk with one that accepts strictly more — `email_verify` as well as `sign_in` — so nothing deployed can be refused by it, and it ADDS Rep.email_verified_at, which nothing deployed writes. The affiliate email verification in this push DEPENDS on both: lib/affiliate-email-verify mints a link with purpose `email_verify` and stamps that column.
--
-- PROVING AN AFFILIATE'S EMAIL ADDRESS (owner's slice D: "email verification and a live SMS code").
--
-- Two small changes, in one file because they are one feature:
--
--   1. Rep.email_verified_at — when a verification link we emailed was followed. NULLABLE, no
--      backfill, and nothing deployed writes it: a rep an operator created by hand has never been
--      asked to prove an address, and NULL says exactly that.
--
--   2. RepMagicLink_purpose_chk widened from ('sign_in') to ('sign_in','email_verify'). The store
--      is shared; the BEHAVIOUR is not, and the purpose column is what keeps them apart. A sign-in
--      link is a credential: minting one revokes the others and spending it starts a session. A
--      verification link grants nothing — it stamps a date. lib/affiliate-email-verify scopes every
--      query to the purpose so neither can touch the other.
--
-- ── WHY THIS IS CLASSIFIED CONSTRAINING, AND WHY IT IS HARMLESS ────────────────────────────────
-- A CHECK cannot be widened in place; it is dropped and re-added, and a DROP CONSTRAINT is
-- constraining by the classifier's rule that ambiguity resolves to constraining. The honest reading
-- is that the new CHECK accepts a SUPERSET of the old one, so no write that was legal yesterday is
-- illegal today, and the only window is the fraction of a transaction where the column is
-- unconstrained. The classifier is not argued with: it is conservative on purpose and one extra
-- push is the agreed price.
--
-- The ALTER TABLE ADD COLUMN would be additive on its own. It is in the same file because shipping
-- half a feature's schema is how a column arrives with nothing to write it.

ALTER TABLE "Rep" ADD COLUMN "email_verified_at" TIMESTAMP(3);

ALTER TABLE "RepMagicLink" DROP CONSTRAINT "RepMagicLink_purpose_chk";
ALTER TABLE "RepMagicLink" ADD CONSTRAINT "RepMagicLink_purpose_chk" CHECK (purpose IN ('sign_in', 'email_verify'));
