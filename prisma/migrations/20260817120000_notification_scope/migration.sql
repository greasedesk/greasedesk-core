-- NotificationLog gets a STATED scope, because an absent tenant was doing four jobs at once.
--
-- `group_id IS NULL` meant: a deliberate platform send, an unresolved inbound, a fixture, or a
-- caller forgot. Not a labelling problem — three tenant-scoped guards inside sendNotification read
-- the tenant's truthiness and fail OPEN without one: the demo block (a demo's phone_verify once
-- reached Twilio, error 21211), the opt-out check (someone who asked not to be contacted IS
-- contacted — a consent failure), and the SMS allowance. Each is correct for a REAL platform send
-- and wrong for a forgotten one. The guards were never the problem; the inference was.
--
-- Three values, not two: "unresolved" is an inbound message meant for some tenant we could not
-- identify. That is the one place honest-null still applies, and it is why this is not a boolean.

CREATE TYPE "NotificationScope" AS ENUM ('tenant', 'platform', 'unresolved');

-- Add nullable, backfill, constrain. NO DEFAULT is left behind — the same rule as
-- Refund.collected_at and Payment.site_id: a default lets the next forgetful caller be believed.
ALTER TABLE "NotificationLog" ADD COLUMN "scope" "NotificationScope";

-- All 189 existing rows carry a group_id (0 nulls, checked before writing this), so every one of
-- them is a tenant message. The population is being labelled, not reinterpreted.
UPDATE "NotificationLog" SET "scope" = 'tenant' WHERE "group_id" IS NOT NULL AND "scope" IS NULL;
UPDATE "NotificationLog" SET "scope" = 'unresolved' WHERE "group_id" IS NULL AND "direction" = 'in' AND "scope" IS NULL;
UPDATE "NotificationLog" SET "scope" = 'platform' WHERE "scope" IS NULL;

ALTER TABLE "NotificationLog" ALTER COLUMN "scope" SET NOT NULL;

-- THE PAIRING. This is what stops a forgotten tenant masquerading as a platform send: you cannot
-- write scope='platform' while naming a tenant, and you cannot write scope='tenant' without one.
-- Not expressible in schema.prisma, so it lives here and is asserted by notify-scope-gate.
ALTER TABLE "NotificationLog" ADD CONSTRAINT "NotificationLog_scope_group_pairing"
  CHECK (
    ("scope" = 'tenant' AND "group_id" IS NOT NULL)
    OR ("scope" <> 'tenant' AND "group_id" IS NULL)
  );
