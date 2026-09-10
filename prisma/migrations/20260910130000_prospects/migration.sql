-- PROSPECTS — the ground a rep covered, kept as GreaseDesk's asset after the rep has gone.
--
-- Hand-written, applied with `migrate deploy`. `migrate dev` proposes a RESET here.
--
-- ── NOT THE REP VISIT MODELS ───────────────────────────────────────────────────────────────────
-- RepVisit / RepLead / RepVisitNote record visits to garages ALREADY on GreaseDesk: group_id and
-- site_id are NOT NULL, a visit is proved by a QR scan on the tenant's own screen, and RepLead is a
-- card-payments upsell. A prospect is a garage that is NOT a customer and has no Group. Different
-- subject, so different tables; those three stay as they are (dormant, zero rows, still valid).
--
-- ── TWO KINDS OF DATA, KEPT ON DIFFERENT CLOCKS ────────────────────────────────────────────────
-- The GARAGE — name, address, visit dates, notes about the business — is the asset and stays.
-- The PERSON — who the rep spoke to, and their email — is personal data about someone who has not
-- become a customer. It is stripped 24 months after the last visit, immediately on unsubscribe, and
-- on signup. What survives an unsubscribe is a HASH of the address, the minimum needed to keep
-- honouring it after the address itself is gone.

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- THE GARAGE
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE "Prospect" (
    "id"                  TEXT NOT NULL,
    "garage_name"         TEXT NOT NULL,
    -- NORMALISED NAME, for presenting a likely duplicate to the rep. Never used to merge anything:
    -- two half-histories of one garage is the failure this record exists to prevent, and so is a
    -- silent merge of two garages that happen to share a name.
    "name_key"            TEXT NOT NULL,
    "address_line1"       TEXT,
    "address_locality"    TEXT,
    "postcode"            TEXT,
    "postcode_key"        TEXT,
    "status"              TEXT NOT NULL,

    -- ── PERSONAL DATA — stripped on retention, unsubscribe and signup ─────────────────────────
    -- NORMALISED lower-case at write, and the CHECK below refuses anything else: the suppression
    -- hash and the existing-customer match both compare this string, so it must be identical by
    -- construction rather than normalised at each comparison.
    "email"               TEXT,
    -- THE RECORDED FACT that the rep ASKED and the owner AGREED — never implied by an address.
    "consent"             TEXT NOT NULL DEFAULT 'not_asked',
    "consent_at"          TIMESTAMP(3),
    "consent_by_rep_id"   TEXT,
    "personal_stripped_at"     TIMESTAMP(3),
    "personal_stripped_reason" TEXT,

    -- ── THE UNSUBSCRIBE LINK ────────────────────────────────────────────────────────────────────
    -- Stored as-is, NOT hashed, and deliberately so. It is not a credential: the most it can do is
    -- stop email to this one prospect. The sequence sender has to put it into every future email,
    -- which a hash cannot give back; and a token derived from a server secret would silently break
    -- every old link the day that secret rotated. A dead unsubscribe link is a compliance failure.
    "unsubscribe_token"   TEXT,

    "signed_up_at"        TIMESTAMP(3),
    -- AN ID, NOT A RELATION. The tenant this became can later be purged and this stays as history,
    -- exactly as SuperAdminAudit.target_group_id and CommissionEntry.group_id do. Personal data is
    -- stripped at signup, so nothing here outlives an erasure that it should not.
    "signed_up_group_id"  TEXT,

    -- Who first recorded it. A plain id, not a relation: the record survives the rep leaving.
    "created_by_rep_id"   TEXT NOT NULL,
    "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Prospect_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Prospect_match_idx" ON "Prospect"("name_key", "postcode_key");
CREATE INDEX "Prospect_email_idx" ON "Prospect"("email");
CREATE UNIQUE INDEX "Prospect_unsubscribe_token_key" ON "Prospect"("unsubscribe_token");

ALTER TABLE "Prospect" ADD CONSTRAINT "Prospect_status_chk" CHECK (
  status IN ('spoke_to', 'interested', 'not_interested', 'signed_up')
);
ALTER TABLE "Prospect" ADD CONSTRAINT "Prospect_name_chk" CHECK (btrim(garage_name) <> '' AND btrim(name_key) <> '');
ALTER TABLE "Prospect" ADD CONSTRAINT "Prospect_postcode_chk" CHECK ((postcode IS NULL) = (postcode_key IS NULL));

ALTER TABLE "Prospect" ADD CONSTRAINT "Prospect_consent_chk" CHECK (consent IN ('not_asked', 'agreed', 'declined'));
-- AN ANSWER HAS A TIME AND AN AUTHOR; NOT ASKED HAS NEITHER. The due-items shape: the sentinel is a
-- value on a NOT NULL column, and the nullable columns carry the absence.
ALTER TABLE "Prospect" ADD CONSTRAINT "Prospect_consent_pair_chk" CHECK (
  (consent = 'not_asked') = (consent_at IS NULL) AND (consent_at IS NULL) = (consent_by_rep_id IS NULL)
);
-- A PROSPECT WITH NO EMAIL RECORDS NO CONSENT. In the database, not in a form: an address that was
-- never given cannot have been consented to. A STRIPPED address keeps its consent history, because
-- that record is the evidence of why we were allowed to write to them at all.
ALTER TABLE "Prospect" ADD CONSTRAINT "Prospect_no_email_no_consent_chk" CHECK (
  NOT (email IS NULL AND personal_stripped_at IS NULL AND consent <> 'not_asked')
);
ALTER TABLE "Prospect" ADD CONSTRAINT "Prospect_email_normalised_chk" CHECK (
  email IS NULL OR (email = lower(btrim(email)) AND email LIKE '%_@_%')
);
ALTER TABLE "Prospect" ADD CONSTRAINT "Prospect_strip_chk" CHECK (
  (personal_stripped_at IS NULL) = (personal_stripped_reason IS NULL)
  AND (personal_stripped_at IS NULL OR email IS NULL)
);
ALTER TABLE "Prospect" ADD CONSTRAINT "Prospect_strip_reason_chk" CHECK (
  personal_stripped_reason IS NULL OR personal_stripped_reason IN ('retention', 'unsubscribed', 'signed_up')
);
ALTER TABLE "Prospect" ADD CONSTRAINT "Prospect_signed_up_chk" CHECK ((status = 'signed_up') = (signed_up_at IS NOT NULL));
ALTER TABLE "Prospect" ADD CONSTRAINT "Prospect_token_shape_chk" CHECK (
  unsubscribe_token IS NULL OR unsubscribe_token ~ '^[A-Za-z0-9_-]{22,}$'
);

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- EACH VISIT — the trail a later reader follows
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE "ProspectVisit" (
    "id"              TEXT NOT NULL,
    "prospect_id"     TEXT NOT NULL,
    "rep_id"          TEXT NOT NULL,
    "visited_on"      TIMESTAMP(3) NOT NULL,
    -- WHO THEY SPOKE TO, at THIS visit — personal data, stripped with the email.
    "spoke_to"        TEXT,
    -- ABOUT THE BUSINESS, and it stays: this is the asset. The form says so.
    "note"            TEXT,
    -- The status AS OF this visit. The current status is on Prospect; the history is here, so
    -- "interested in March, not interested in May" survives rather than being overwritten.
    "status_at_visit" TEXT NOT NULL,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProspectVisit_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ProspectVisit_prospect_visited_idx" ON "ProspectVisit"("prospect_id", "visited_on");
CREATE INDEX "ProspectVisit_rep_idx" ON "ProspectVisit"("rep_id");
ALTER TABLE "ProspectVisit" ADD CONSTRAINT "ProspectVisit_prospect_id_fkey"
    FOREIGN KEY ("prospect_id") REFERENCES "Prospect"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProspectVisit" ADD CONSTRAINT "ProspectVisit_status_chk" CHECK (
  status_at_visit IN ('spoke_to', 'interested', 'not_interested', 'signed_up')
);
ALTER TABLE "ProspectVisit" ADD CONSTRAINT "ProspectVisit_text_chk" CHECK (
  (spoke_to IS NULL OR btrim(spoke_to) <> '') AND (note IS NULL OR btrim(note) <> '')
);

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- THE FOLLOW-UP SEQUENCE — one per prospect, and a stopped one stays, saying WHY
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE "ProspectSequence" (
    "id"             TEXT NOT NULL,
    "prospect_id"    TEXT NOT NULL,
    "state"          TEXT NOT NULL,
    "next_step"      INTEGER NOT NULL,
    "next_due_at"    TIMESTAMP(3),
    "started_at"     TIMESTAMP(3) NOT NULL,
    "last_sent_at"   TIMESTAMP(3),
    "stopped_at"     TIMESTAMP(3),
    "stopped_reason" TEXT,
    "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProspectSequence_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ProspectSequence_prospect_id_key" ON "ProspectSequence"("prospect_id");
CREATE INDEX "ProspectSequence_due_idx" ON "ProspectSequence"("state", "next_due_at");
ALTER TABLE "ProspectSequence" ADD CONSTRAINT "ProspectSequence_prospect_id_fkey"
    FOREIGN KEY ("prospect_id") REFERENCES "Prospect"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProspectSequence" ADD CONSTRAINT "ProspectSequence_state_chk" CHECK (state IN ('active', 'stopped'));
-- A STOPPED SEQUENCE SAYS WHEN AND WHY, AND AN ACTIVE ONE SAYS NEITHER. The destination rule, held by
-- the database: "stopped" with no reason is a row that tells the next reader nothing.
ALTER TABLE "ProspectSequence" ADD CONSTRAINT "ProspectSequence_stop_chk" CHECK (
  (state = 'active') = (stopped_at IS NULL) AND (stopped_at IS NULL) = (stopped_reason IS NULL)
  AND (state = 'active') = (next_due_at IS NOT NULL)
);
ALTER TABLE "ProspectSequence" ADD CONSTRAINT "ProspectSequence_reason_chk" CHECK (
  stopped_reason IS NULL OR stopped_reason IN
    ('unsubscribed', 'signed_up', 'already_customer', 'completed', 'suppressed', 'retention')
);
ALTER TABLE "ProspectSequence" ADD CONSTRAINT "ProspectSequence_step_chk" CHECK (next_step >= 1);

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- THE MINIMUM KEPT TO HONOUR AN UNSUBSCRIBE
-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- The address is stripped on unsubscribe, so something must remember not to write to it again if a
-- rep later types it back in. A sha256 of the normalised address: enough to refuse, not enough to
-- mail. No foreign key — it outlives the prospect, deliberately.
CREATE TABLE "ProspectSuppression" (
    "id"         TEXT NOT NULL,
    "email_hash" TEXT NOT NULL,
    "reason"     TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProspectSuppression_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ProspectSuppression_email_hash_key" ON "ProspectSuppression"("email_hash");
ALTER TABLE "ProspectSuppression" ADD CONSTRAINT "ProspectSuppression_hash_chk" CHECK (email_hash ~ '^[0-9a-f]{64}$');
ALTER TABLE "ProspectSuppression" ADD CONSTRAINT "ProspectSuppression_reason_chk" CHECK (reason IN ('unsubscribed'));
