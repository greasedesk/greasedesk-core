-- A CUSTOMER'S CONTACT PREFERENCES: A SEPARATE MARKETING CHOICE, AND THE HISTORY OF EVERY CHANGE.
--
-- Hand-written, applied with `migrate deploy`. Step 1 of the tenant unsubscribe (owner decision B,
-- 2026-09-10): the schema and the one writer. Nothing reads the new columns yet and nothing sends a
-- link yet — those are steps 3 and 4.
--
-- ── WHY A SEPARATE MARKETING OPT-OUT ───────────────────────────────────────────────────────────
-- lib/marketing-lists rules that an opt-out is an opt-out of EVERYTHING — which governs what the
-- SENDER may classify, and still does. It never governed how finely the RECIPIENT may choose. A
-- customer who unsubscribes from an MOT reminder must still get their quote and their invoice, so
-- "no reminders or offers" is its own answer beside "nothing at all", per channel.
-- Added now because it will never be cheaper: on 2026-09-10 real tenants held 0 opt-outs, 0
-- opt-ins and had sent 0 marketing messages in 90 days. Nothing to migrate, nothing to preserve.
--
-- ── THREE STATES, AS THE EXISTING COLUMNS ──────────────────────────────────────────────────────
-- NULL = no record (nobody asked), true = opted OUT, false = explicitly opted IN.
--
-- ── WHY A HISTORY TABLE, NOT THE AUDIT LOG ─────────────────────────────────────────────────────
-- It is what a garage may have to produce if challenged: "what is this customer's email preference,
-- and who set it". AuditLog is keyed to job cards and holds a diff; it cannot answer that without
-- searching inside JSON. One writer (lib/contact-preferences) writes the Customer column AND this
-- row in one transaction — the flat column is the current state every reader uses, this is the
-- record of how it got there. The EmploymentEvent arrangement. Every change goes through it from
-- the day it ships, the staff form's existing toggles included, so the history is complete rather
-- than partial. (Before it: 6 opt-out changes ever, all on the gate tenant, all net back to NULL —
-- nothing real to import.)
ALTER TABLE "Customer" ADD COLUMN "email_marketing_opt_out" BOOLEAN;
ALTER TABLE "Customer" ADD COLUMN "sms_marketing_opt_out" BOOLEAN;

CREATE TABLE "ContactPreferenceEvent" (
    "id"                  TEXT NOT NULL,
    "group_id"            TEXT NOT NULL,
    "customer_id"         TEXT NOT NULL,
    "channel"             TEXT NOT NULL,
    "scope"               TEXT NOT NULL,
    "previous"            BOOLEAN,
    "opted_out"           BOOLEAN,
    "via"                 TEXT NOT NULL,
    "reason"              TEXT,
    "actor_user_id"       TEXT,
    "notification_log_id" TEXT,
    "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactPreferenceEvent_pkey" PRIMARY KEY ("id")
);

-- The purge takes both with the tenant (Group cascades to Customer and to this). The message a
-- link or a carrier STOP came from is held with NO ACTION: nothing may delete the one message a
-- piece of consent evidence points at — while a purge, which deletes both in one statement, passes.
ALTER TABLE "ContactPreferenceEvent" ADD CONSTRAINT "ContactPreferenceEvent_group_id_fkey"
  FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContactPreferenceEvent" ADD CONSTRAINT "ContactPreferenceEvent_customer_id_fkey"
  FOREIGN KEY ("customer_id") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContactPreferenceEvent" ADD CONSTRAINT "ContactPreferenceEvent_notification_log_id_fkey"
  FOREIGN KEY ("notification_log_id") REFERENCES "NotificationLog"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

CREATE INDEX "ContactPreferenceEvent_customer_id_channel_scope_created_at_idx"
  ON "ContactPreferenceEvent"("customer_id", "channel", "scope", "created_at");
CREATE INDEX "ContactPreferenceEvent_group_id_created_at_idx" ON "ContactPreferenceEvent"("group_id", "created_at");

-- ── THE SHAPE IS THE DATABASE'S ────────────────────────────────────────────────────────────────
-- Vocabulary — text + CHECK, the house choice for small closed sets (lead reason kinds).
ALTER TABLE "ContactPreferenceEvent" ADD CONSTRAINT "ContactPreferenceEvent_channel_chk" CHECK (channel IN ('email', 'sms'));
ALTER TABLE "ContactPreferenceEvent" ADD CONSTRAINT "ContactPreferenceEvent_scope_chk" CHECK (scope IN ('all', 'marketing'));
ALTER TABLE "ContactPreferenceEvent" ADD CONSTRAINT "ContactPreferenceEvent_via_chk" CHECK (via IN ('staff', 'customer_link', 'carrier_stop'));

-- WHO: a staff change names the staff member and no message; a link or a carrier STOP names the
-- message it came from and no staff member. Each change has exactly one kind of author.
ALTER TABLE "ContactPreferenceEvent" ADD CONSTRAINT "ContactPreferenceEvent_actor_chk"
  CHECK ((via = 'staff') = (actor_user_id IS NOT NULL));
ALTER TABLE "ContactPreferenceEvent" ADD CONSTRAINT "ContactPreferenceEvent_message_chk"
  CHECK ((via = 'staff') = (notification_log_id IS NULL));

-- WHAT EACH SOURCE CAN SAY. A customer's link can only opt them OUT of marketing — it must never
-- be the thing that switches offers back on. A carrier STOP is the handset refusing every text, so
-- it is an opt-out of ALL sms and nothing else.
ALTER TABLE "ContactPreferenceEvent" ADD CONSTRAINT "ContactPreferenceEvent_source_chk"
  CHECK (
    (via <> 'customer_link' OR (scope = 'marketing' AND opted_out = true))
    AND (via <> 'carrier_stop' OR (scope = 'all' AND channel = 'sms' AND opted_out = true))
  );

-- MARKETING ALWAYS HAS A DEFINITE ANSWER once one is recorded. "No record" reads as allowed, so a
-- staff member returning a marketing opt-out to NULL would re-open offers without being an opt-in —
-- and without the reason below. (The `all` scope keeps its existing untick-to-NULL behaviour.)
ALTER TABLE "ContactPreferenceEvent" ADD CONSTRAINT "ContactPreferenceEvent_marketing_definite_chk"
  CHECK (scope <> 'marketing' OR opted_out IS NOT NULL);

-- EVERY STAFF OPT-IN TO MARKETING CARRIES A REASON (owner, 2026-09-10). Not only one that reverses
-- a customer's own opt-out: "this reverses the customer" cannot be checked by a database, "any
-- opt-in has a reason" can — and a garage claiming a customer consented is the record that
-- protects it later, whether or not there was an opt-out before.
ALTER TABLE "ContactPreferenceEvent" ADD CONSTRAINT "ContactPreferenceEvent_optin_reason_chk"
  CHECK (via <> 'staff' OR scope <> 'marketing' OR opted_out IS DISTINCT FROM false
         OR (reason IS NOT NULL AND length(btrim(reason)) > 0));

-- A REASON IS A SENTENCE OR NOTHING — never a blank string standing in for NULL — and bounded.
ALTER TABLE "ContactPreferenceEvent" ADD CONSTRAINT "ContactPreferenceEvent_reason_chk"
  CHECK (reason IS NULL OR (length(btrim(reason)) > 0 AND length(reason) <= 500));

-- AN EVENT IS A CHANGE. A row whose new value equals its previous one records nothing happening.
ALTER TABLE "ContactPreferenceEvent" ADD CONSTRAINT "ContactPreferenceEvent_change_chk"
  CHECK (opted_out IS DISTINCT FROM previous);
