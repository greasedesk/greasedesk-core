-- @migration: additive
--
-- THE MARKETING ENGINE — four sequences on one state machine.
--
-- Four brand-new tables. Nothing deployed reads or writes any of them, so this is safe to apply at
-- any time, in either order relative to the code. The matching DESTRUCTIVE half — dropping
-- ProspectSequence, ProspectSending and ProspectSendingLease — is a separate migration that must
-- wait until the deployment that stops writing them is live.
--
-- ── MEASURED BEFORE IT WAS WRITTEN ─────────────────────────────────────────────────────────────
-- Production, 2026-11-02: Prospect 0 rows, ProspectSequence 0 rows, ProspectSending NO ROW — the
-- existing engine had never once been switched on. That is the only reason generalising it is a
-- schema change over empty tables instead of a data migration, and it is why there is no backfill
-- anywhere in this file.
--
-- ── EVERY CONSTRAINT IS INSIDE ITS CREATE TABLE, DELIBERATELY ─────────────────────────────────
-- A separate ADD CONSTRAINT classifies CONSTRAINING (lib/migration-deploy-rules) and would cost the
-- two-push dance for constraints that cannot reach a writer, because the table did not exist a
-- moment ago. Index and constraint names match what Prisma names the same attributes, so the schema
-- and the database are identical by construction and `migrate diff` stays empty.
--
-- ── WHAT IS CHECKED HERE AND WHAT IS LEFT TO THE GATE ─────────────────────────────────────────
-- In the database: the state machine, the sequence/subject PAIR, and the consent source. Those are
-- rules whose value sets are fixed by what the thing IS — there are two states, four audiences, and
-- four ways we got permission — and the consent source is the evidence that the send was lawful, so
-- a value outside the set must not be storable at all.
--
-- NOT in the database: the ten stop reasons, and the number of steps. Both can legitimately grow —
-- a fifth audience brings a fifth goal-stop, and a sequence may one day want a sixth email — and a
-- CHECK on a number that is allowed to move buys one refusal today and costs a constraining
-- migration later (property-gate-discipline: pin the rule, not the number). The step CHECK pins the
-- rule that survives: a step is at least 1. marketing-engine-gate pins the current ten and the
-- current five, where changing them is free.

CREATE TABLE "MarketingEnrolment" (
  "id"           TEXT NOT NULL,

  "sequence_key" TEXT NOT NULL,
  -- Strictly derivable from sequence_key and kept anyway: a bare uuid in a polymorphic column is
  -- unreadable to anyone querying by hand, and the pair CHECK below means this copy cannot disagree
  -- with lib/marketing-engine::SUBJECT_OF.
  "subject_type" TEXT NOT NULL,
  "subject_id"   TEXT NOT NULL,

  "state"          TEXT         NOT NULL,
  "next_step"      INTEGER      NOT NULL,
  "next_due_at"    TIMESTAMP(3),
  "started_at"     TIMESTAMP(3) NOT NULL,
  "last_sent_at"   TIMESTAMP(3),
  "stopped_at"     TIMESTAMP(3),
  "stopped_reason" TEXT,

  -- The frozen justification. NOT NULL both: an enrolment that cannot say why it exists is one
  -- nobody can defend, and there is no point at which we would have one without knowing.
  "consent_source" TEXT         NOT NULL,
  "consent_at"     TIMESTAMP(3) NOT NULL,

  -- THE WAY OUT, HERE RATHER THAN ON FOUR SUBJECT TABLES. Prospect.unsubscribe_token could only
  -- serve prospects; a Group, an AffiliateWaitlist row and a Rep have no such column. Not hashed,
  -- for the reason that column gave: it is not a credential, the only power it grants is STOPPING
  -- email, and the sender puts it in every message anyway. NULL = nothing has been addressed to this
  -- enrolment yet, so no link was ever sent.
  --
  -- NO SHAPE CHECK, unlike Prospect_token_shape_chk. That constraint pinned base64url-22, which is
  -- the output of one particular generator; the rule that survives a change of generator is
  -- uniqueness, and the index below is that. marketing-engine-gate pins the current shape, where
  -- changing it is free.
  "unsubscribe_token" TEXT,

  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "MarketingEnrolment_pkey" PRIMARY KEY ("id"),

  -- THE ONE THAT EARNS ITS KEEP. Without it a trial_garage enrolment could carry a Prospect id, and
  -- the single worst thing this table can do is send one audience's email to somebody from another.
  -- It subsumes a sequence_key set CHECK and a subject_type set CHECK, so neither is written
  -- separately: two constraints where one is strictly stronger is a second place to edit.
  CONSTRAINT "MarketingEnrolment_pair_chk" CHECK (
    ("sequence_key" = 'garage_prospect'    AND "subject_type" = 'prospect')          OR
    ("sequence_key" = 'trial_garage'       AND "subject_type" = 'group')             OR
    ("sequence_key" = 'affiliate_interest' AND "subject_type" = 'affiliate_waitlist') OR
    ("sequence_key" = 'affiliate_new'      AND "subject_type" = 'rep')
  ),

  -- Carried over verbatim in spirit from ProspectSequence_stop_chk, because it was right: a stopped
  -- enrolment always says WHEN and WHY, and is never left due. It constrains `state` to the two
  -- values as a side effect, which is why there is no separate state set CHECK.
  CONSTRAINT "MarketingEnrolment_state_chk" CHECK (
    ("state" = 'active'  AND "next_due_at" IS NOT NULL AND "stopped_at" IS NULL     AND "stopped_reason" IS NULL) OR
    ("state" = 'stopped' AND "next_due_at" IS NULL     AND "stopped_at" IS NOT NULL AND "stopped_reason" IS NOT NULL)
  ),

  CONSTRAINT "MarketingEnrolment_step_chk" CHECK ("next_step" >= 1),

  CONSTRAINT "MarketingEnrolment_consent_chk" CHECK (
    "consent_source" IN ('rep_visit', 'signup', 'waitlist_form', 'affiliate_terms')
  ),

  -- ── THE UNIQUES ARE TABLE CONSTRAINTS, NOT SEPARATE CREATE UNIQUE INDEX STATEMENTS ──────────
  -- A standalone CREATE UNIQUE INDEX classifies CONSTRAINING (lib/migration-deploy-rules: "UNIQUE
  -- INDEX — production may already create duplicates") and would cost the two-push dance for a
  -- uniqueness rule on a table that did not exist a moment ago. Inside the CREATE TABLE it is
  -- SELF_CONTAINED_ADDITIVE, because it constrains inserts into a table nothing is writing yet.
  -- Named exactly what Prisma names the same attributes, so `migrate diff` stays empty:
  -- AffiliateWaitlist_email_key and StockDisposal_stock_item_id_key are the same shape.

  -- One enrolment per subject per sequence. A second is the same person sent the same five emails
  -- twice, which is the failure a marketing engine is most likely to produce.
  CONSTRAINT "MarketingEnrolment_subject_uq" UNIQUE ("sequence_key", "subject_type", "subject_id"),
  -- The unsubscribe link's whole job: one lookup, from a token in a URL to the enrolment that sent it.
  CONSTRAINT "MarketingEnrolment_unsubscribe_token_key" UNIQUE ("unsubscribe_token")
);

CREATE INDEX "MarketingEnrolment_due_idx" ON "MarketingEnrolment" ("state", "next_due_at");
-- For the reverse question — "is this garage on anything?" — which every audience's own screen asks.
CREATE INDEX "MarketingEnrolment_subject_idx" ON "MarketingEnrolment" ("subject_type", "subject_id");

-- ────────────────────────────────────────────────────────────────────────────────────────────────
-- NO ROW = OFF. The default, and the state every sequence ships in: the copy is the owner's and
-- nothing may reach a real person before they have read it. Four independent rows, so one sequence
-- being on says nothing about any other.
CREATE TABLE "MarketingSending" (
  "sequence_key" TEXT         NOT NULL,
  "enabled"      BOOLEAN      NOT NULL,
  "changed_at"   TIMESTAMP(3) NOT NULL,
  "changed_by"   TEXT         NOT NULL,

  CONSTRAINT "MarketingSending_pkey" PRIMARY KEY ("sequence_key"),
  CONSTRAINT "MarketingSending_sequence_chk" CHECK (
    "sequence_key" IN ('garage_prospect', 'trial_garage', 'affiliate_interest', 'affiliate_new')
  )
);

-- ────────────────────────────────────────────────────────────────────────────────────────────────
-- A GATE'S OVERRIDE, NEVER THE OWNER'S SWITCH. The ProspectSendingLease pattern unchanged, now
-- keyed on the enrolment so it can have a real foreign key and cascade.
--
-- The five-minute cap is the whole safety property: the gate used to flip the OWNER'S switch and
-- restore it in a `finally`, and killed mid-run it left sending ON for every real consented address
-- (proven by SIGKILL, 10 Sep 2026). A lease touches no switch, reaches no enrolment but its own, and
-- stops counting when it expires — so one left behind by a killed process needs no cleaning up.
CREATE TABLE "MarketingSendingLease" (
  "enrolment_id" TEXT         NOT NULL,
  "enabled"      BOOLEAN      NOT NULL,
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at"   TIMESTAMP(3) NOT NULL,
  "created_by"   TEXT         NOT NULL,

  CONSTRAINT "MarketingSendingLease_pkey" PRIMARY KEY ("enrolment_id"),
  CONSTRAINT "MarketingSendingLease_short_chk" CHECK ("expires_at" <= "created_at" + INTERVAL '5 minutes'),
  CONSTRAINT "MarketingSendingLease_enrolment_id_fkey"
    FOREIGN KEY ("enrolment_id") REFERENCES "MarketingEnrolment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- ────────────────────────────────────────────────────────────────────────────────────────────────
-- THE WORDS, EDITABLE WITHOUT A DEPLOY.
--
-- No row, a blank subject or a blank body means the step does NOT go: the runner reports `no_copy`
-- and leaves the enrolment where it is. Nobody receives an empty email and no step is advanced as
-- though it had been sent. Enforced in the runner rather than here, because "blank" is a property of
-- the trimmed string and a CHECK on <> '' would still pass a body of three spaces.
--
-- body is PLAIN TEXT: escaped at render, wrapped paragraph by paragraph. Not markdown, not HTML.
-- The only person who types here is the owner, a parser is a second thing to get wrong, and an
-- escaped body cannot carry a tag into a real person's inbox.
CREATE TABLE "MarketingCopy" (
  "id"           TEXT         NOT NULL,
  "sequence_key" TEXT         NOT NULL,
  "step"         INTEGER      NOT NULL,
  "subject"      TEXT         NOT NULL,
  "body"         TEXT         NOT NULL,

  -- Both or neither, so no renderer has to decide what a label with no link means.
  "cta_label"    TEXT,
  "cta_url"      TEXT,

  "updated_at"   TIMESTAMP(3) NOT NULL,
  -- No FK: the copy outlives the operator account that wrote it.
  "updated_by"   TEXT         NOT NULL,

  CONSTRAINT "MarketingCopy_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MarketingCopy_sequence_chk" CHECK (
    "sequence_key" IN ('garage_prospect', 'trial_garage', 'affiliate_interest', 'affiliate_new')
  ),
  CONSTRAINT "MarketingCopy_step_chk" CHECK ("step" >= 1),
  CONSTRAINT "MarketingCopy_cta_chk" CHECK (
    ("cta_label" IS NULL AND "cta_url" IS NULL) OR ("cta_label" IS NOT NULL AND "cta_url" IS NOT NULL)
  ),
  -- Inline, for the reason given on MarketingEnrolment's uniques above.
  CONSTRAINT "MarketingCopy_step_uq" UNIQUE ("sequence_key", "step")
);
