-- REP PORTAL — the schema. No behaviour: nothing reads or writes any of this yet.
--
-- Hand-written, applied with `migrate deploy`. `migrate dev` proposes a RESET here.
--
-- Rep, CommissionEntry and RepPayRun were all at ZERO ROWS when this was written, which is what
-- makes the drops below safe and the CHECKs below free. SuperAdminAudit had 740 rows, none with
-- two targets and SIXTEEN with none — so the target check is `<= 1` and not `= 1`.
--
-- LANGUAGE: Sales Commission. A rep is self-employed and invoices US. The rep's invoice is the
-- REP'S document; we are its customer. Never wage, never salary, never "pay" as a noun for the rep.

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- 1. THE CREDENTIAL. Password auth for reps is RETRACTED.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- The email address IS the credential, so a rep can never change their own; and there is no
-- password, so there is nothing for an invite to set. All four columns had zero rows and no writer:
-- passwordHash was read by the 'rep' credentials provider (deleted in the next step), and the three
-- invite columns were the set-a-password flow that will now never be built. A sentinel value in
-- passwordHash would have been a check that lives forever for a flow that ended today.
ALTER TABLE "Rep" DROP COLUMN "passwordHash";
ALTER TABLE "Rep" DROP COLUMN "invite_token_hash";
ALTER TABLE "Rep" DROP COLUMN "invite_token_expires";
ALTER TABLE "Rep" DROP COLUMN "invite_token_used_at";

-- ── THE LINK IS THE CREDENTIAL ─────────────────────────────────────────────────────────────────
-- Its own table, not a widening of CustomerMagicLink: that model's header commits IN WRITING to
-- being multi-use ("a customer re-opening the same email must still work"), and its group_id and
-- job_card_id are NOT NULL. A rep belongs to no garage and no job card, and this link must burn.
CREATE TABLE "RepMagicLink" (
    "id"             TEXT NOT NULL,
    "rep_id"         TEXT NOT NULL,
    -- ONE PURPOSE, NAMED. The narrow-grant discipline from lib/magic-link: a link minted to sign in
    -- can never be spent on anything else, because every lookup is scoped to the purpose.
    "purpose"        TEXT NOT NULL,
    -- sha256(raw). The RAW token exists only in the emailed URL; a database reader gets nothing.
    "token_hash"     TEXT NOT NULL,
    -- WHERE IT WENT, verbatim, at the moment of sending. Not derived from Rep.email on read: an
    -- operator can change that address, and the audit answer "who could have signed in as this
    -- rep?" must not silently rewrite itself when they do.
    "sent_to"        TEXT NOT NULL,
    "expires_at"     TIMESTAMP(3) NOT NULL,
    -- NULL = UNSPENT, and this column is the whole single-use mechanism. See the comment below.
    "consumed_at"    TIMESTAMP(3),
    -- NULL = live. The explicit kill switch, for a link sent to an address that turned out wrong.
    "revoked_at"     TIMESTAMP(3),
    -- WHY it was killed, as a code. NULL = not revoked; paired with revoked_at by the CHECK below,
    -- so a reason can never outlive the revocation it explains.
    "revoked_reason" TEXT,
    "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RepMagicLink_pkey" PRIMARY KEY ("id")
);

-- ── SINGLE USE, ENFORCED BY THE DATABASE ───────────────────────────────────────────────────────
-- THE MECHANISM IS THE CONDITIONAL UPDATE, not a unique index. Stated explicitly because the
-- code_step precedent was the other candidate and this is NOT that shape:
--
--     UPDATE "RepMagicLink" SET consumed_at = now()
--      WHERE token_hash = $1 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > now()
--
-- and the sign-in proceeds only on affected-row count 1. Two concurrent replays of the same URL
-- both reach the UPDATE; Postgres takes the row lock, the second blocks, and when it re-evaluates
-- its WHERE after the first commits, consumed_at is set and it matches NOTHING. The loser gets 0
-- and is refused. There is no window between a read and a write for it to slip through, because
-- there is no read.
--
-- WHY NOT code_step's unique index. That index exists because a STEP NUMBER repeats across rows —
-- uniqueness of (group, step) is a real constraint on a value that is not otherwise unique. Here
-- the row IS the credential and there is exactly one of it, already unique by primary key; an index
-- would be enforcing uniqueness of something unique by construction, and would need a second table
-- of consumption records to have anything to index. Same guarantee, one row, no second table.
-- It is also the shape lib/rep-pay-run::releaseEntry already uses for money, which is the higher
-- bar of the two.
CREATE UNIQUE INDEX "RepMagicLink_token_hash_key" ON "RepMagicLink"("token_hash");
CREATE INDEX "RepMagicLink_rep_id_idx" ON "RepMagicLink"("rep_id");
CREATE INDEX "RepMagicLink_expires_at_idx" ON "RepMagicLink"("expires_at");

ALTER TABLE "RepMagicLink" ADD CONSTRAINT "RepMagicLink_rep_id_fkey"
    FOREIGN KEY ("rep_id") REFERENCES "Rep"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RepMagicLink" ADD CONSTRAINT "RepMagicLink_purpose_chk" CHECK (purpose IN ('sign_in'));

-- A REASON WITHOUT A REVOCATION IS INCOHERENT, and the set is closed for the same reason the
-- commission codes are: prose that could name a person does not belong in a code column.
ALTER TABLE "RepMagicLink" ADD CONSTRAINT "RepMagicLink_revoked_chk" CHECK (
  (revoked_at IS NOT NULL) = (revoked_reason IS NOT NULL)
);
ALTER TABLE "RepMagicLink" ADD CONSTRAINT "RepMagicLink_revoked_reason_chk" CHECK (
  revoked_reason IS NULL OR revoked_reason = ANY (ARRAY[
    'wrong_address'::text,
    'email_changed'::text,
    'rep_suspended'::text,
    'superseded'::text
  ])
);
-- The token is sha256 hex, 64 characters, always. A row holding a RAW token would be a credential
-- in the database, and this refuses the shape rather than trusting the writer.
ALTER TABLE "RepMagicLink" ADD CONSTRAINT "RepMagicLink_token_shape_chk" CHECK (
  token_hash ~ '^[0-9a-f]{64}$'
);

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- 2. THE REP'S PROFILE. Captured once, gates the first invoice — except the UTR, which never does.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- Every column here is NULLABLE and NULL MEANS "NOT YET GIVEN". That is the honest state for a rep
-- an operator created five minutes ago, and it is what makes "profile incomplete" derivable rather
-- than tracked by a second boolean somebody forgets to clear.
ALTER TABLE "Rep" ADD COLUMN "trading_name"     TEXT;
ALTER TABLE "Rep" ADD COLUMN "address_line1"    TEXT;
ALTER TABLE "Rep" ADD COLUMN "address_line2"    TEXT;
ALTER TABLE "Rep" ADD COLUMN "address_locality" TEXT;
ALTER TABLE "Rep" ADD COLUMN "address_region"   TEXT;
ALTER TABLE "Rep" ADD COLUMN "address_postcode" TEXT;
-- The address the rep publishes ON THEIR INVOICE, and deliberately NOT Rep.email.
-- Rep.email is the LOGIN — with passwords gone it is now the entire credential — and printing it on
-- a document is publishing the credential. support-route-gate already catches exactly this mistake
-- one surface over, where a mailto: to Rep.email shipped on the garage's support card.
-- NULL = none given; the invoice omits the line rather than printing a placeholder.
ALTER TABLE "Rep" ADD COLUMN "contact_email"    TEXT;

-- ── VAT: THREE STATES, BECAUSE "NOT ASKED" IS NOT "NO" ─────────────────────────────────────────
-- NULL = the rep has not answered, and the first invoice is REFUSED until they do.
-- false = answered, not registered — a settled fact, and the generator must refuse to add VAT.
-- true  = registered, and then the number and the effective date are both mandatory.
-- A two-state boolean would make an unanswered profile indistinguishable from a genuine "no", which
-- is the difference between refusing to invoice and issuing a wrong one.
ALTER TABLE "Rep" ADD COLUMN "vat_registered" BOOLEAN;
-- NULL = not registered, or not yet answered. Never blank.
ALTER TABLE "Rep" ADD COLUMN "vat_number" TEXT;
-- WHEN REGISTRATION TOOK EFFECT. NULL = not registered, or not yet answered.
-- This is what makes a rep who crossed the threshold mid-year render differently either side of the
-- date: an invoice dated BEFORE it carries no VAT even though the rep is registered today. Without
-- it, registering would retrospectively add VAT to periods that were never VATable.
ALTER TABLE "Rep" ADD COLUMN "vat_effective_from" TIMESTAMP(3);

-- OPTIONAL, AND IT NEVER GATES ANYTHING. NULL = not given, which is a permanently acceptable state:
-- a UTR is not an invoice requirement, and blocking a submission on one would be inventing a rule
-- HMRC does not have. Collected because it is useful to have, and for no other reason.
ALTER TABLE "Rep" ADD COLUMN "utr" TEXT;

-- ── BANK DETAILS: NAMED COLUMNS, OPERATOR-ONLY ─────────────────────────────────────────────────
-- Replaces payout_details Json, which had no writer and one reader (a comment). A field with a
-- refusal rule and an audit trail cannot live in an untyped blob: "who changed the sort code" is
-- unanswerable against a Json column, and every read would need a shape check the type does not
-- give. Dropped rather than migrated — zero rows.
-- NULL on all three = we have no bank details for this rep. That renders as MISSING on every
-- surface: never as a blank field that reads as filled in, and never as a zeroed account.
ALTER TABLE "Rep" DROP COLUMN "payout_details";
ALTER TABLE "Rep" ADD COLUMN "bank_account_name"   TEXT;
ALTER TABLE "Rep" ADD COLUMN "bank_sort_code"      TEXT;
ALTER TABLE "Rep" ADD COLUMN "bank_account_number" TEXT;

-- ALL THREE OR NONE. A partial set is unpayable — a sort code with no account number cannot be
-- sent money — so it is not a lesser state of "has bank details", it is a row that looks complete
-- to a screen and fails at the bank. The operator form submits three fields at once or none.
ALTER TABLE "Rep" ADD CONSTRAINT "Rep_bank_chk" CHECK (
     (bank_account_name IS NULL AND bank_sort_code IS NULL AND bank_account_number IS NULL)
  OR (bank_account_name IS NOT NULL AND btrim(bank_account_name) <> ''
      AND bank_sort_code IS NOT NULL AND btrim(bank_sort_code) <> ''
      AND bank_account_number IS NOT NULL AND btrim(bank_account_number) <> '')
);

-- THE THREE VAT COLUMNS MOVE AS ONE. A registered rep with no number, or a number with no effective
-- date, is a document that cannot be rendered correctly — and an unregistered rep carrying a VAT
-- number is the state that would let VAT be charged by nobody's decision.
ALTER TABLE "Rep" ADD CONSTRAINT "Rep_vat_chk" CHECK (
     (vat_registered IS NULL   AND vat_number IS NULL AND vat_effective_from IS NULL)
  OR (vat_registered = false   AND vat_number IS NULL AND vat_effective_from IS NULL)
  OR (vat_registered = true    AND vat_number IS NOT NULL AND btrim(vat_number) <> ''
                               AND vat_effective_from IS NOT NULL)
);

-- Blank is not a value anywhere in the profile: a form that posts an empty string must clear the
-- column, not store one. Otherwise "complete" is true of a rep who typed a space.
ALTER TABLE "Rep" ADD CONSTRAINT "Rep_profile_blank_chk" CHECK (
      (trading_name     IS NULL OR btrim(trading_name)     <> '')
  AND (address_line1    IS NULL OR btrim(address_line1)    <> '')
  AND (address_line2    IS NULL OR btrim(address_line2)    <> '')
  AND (address_locality IS NULL OR btrim(address_locality) <> '')
  AND (address_region   IS NULL OR btrim(address_region)   <> '')
  AND (address_postcode IS NULL OR btrim(address_postcode) <> '')
  AND (contact_email    IS NULL OR btrim(contact_email)    <> '')
  AND (utr              IS NULL OR btrim(utr)              <> '')
);

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- 3. THE REP'S INVOICE. Their document, their number, frozen on submission.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- THIS DOES NOT INHERIT THE GARAGE-INVOICE BEHAVIOUR, and the difference is the reason the bytes are
-- stored. A garage invoice is GreaseDesk's own document: it re-renders from frozen InvoiceLine rows
-- every time it is opened, which is safe because we own it and the freeze is in the data. This one
-- is somebody else's accounting record. Rebuilding it from data would be forging another business's
-- books — so the PDF ITSELF is the artefact, stored and hashed, and the renderer is never called
-- for it again.
CREATE TABLE "RepInvoice" (
    "id"                  TEXT NOT NULL,
    "rep_id"              TEXT NOT NULL,
    "pay_run_id"          TEXT NOT NULL,
    -- THE REP'S OWN NUMBER, FROM THE REP'S OWN SERIES. Not ours, and not globally unique — see the
    -- partial index below. They type it; we prefill their last plus one and they may overwrite it.
    "rep_invoice_number"  TEXT NOT NULL,
    "status"              TEXT NOT NULL,

    -- ── THE DATES ──────────────────────────────────────────────────────────────────────────────
    -- Defaults to the moment of submission and is FLOORED at the run's close date: a rep cannot
    -- date an invoice before the money it bills for was signed off.
    "invoice_date"        TIMESTAMP(3) NOT NULL,
    -- THE VAT TAX POINT. NULL = no VAT on this document, so there is no tax point to state — an
    -- unregistered rep's invoice has none, and neither does a registered rep's invoice for a period
    -- before their registration took effect. Paired with vat_applied by the CHECK below.
    "tax_point"           TIMESTAMP(3),

    -- ── THE MONEY ──────────────────────────────────────────────────────────────────────────────
    "currency"            TEXT NOT NULL,
    "subtotal_pennies"    INTEGER NOT NULL,
    -- WHETHER VAT IS ON THIS DOCUMENT — deliberately NOT named `vat_registered_at_issue` like the
    -- garage invoice's column, because it does not mean the same thing. A registered rep invoicing
    -- for a pre-registration period is registered AND carries no VAT, so a column named for their
    -- registration status would read false while the rep is plainly registered. This names what the
    -- document does.
    "vat_applied"         BOOLEAN NOT NULL,
    -- NULL = no VAT applied. Basis points, so 20% is 2000 and a future 17.5% needs no migration.
    "vat_rate_bp"         INTEGER,
    -- NULL = no VAT applied. Never 0: zero VAT and no VAT are different documents.
    "vat_pennies"         INTEGER,
    "total_pennies"       INTEGER NOT NULL,

    -- ── THE ISSUER, FROZEN. The rep's details AS THEY WERE when they submitted. ─────────────────
    -- Read from these, never from Rep: an operator correcting an address next month must not change
    -- what a document already submitted says it said.
    "rep_trading_name_snapshot" TEXT NOT NULL,
    "rep_address_snapshot"      TEXT NOT NULL,
    -- NULL = the rep published no contact address at submission, and the document omits the line.
    "rep_contact_snapshot"      TEXT,
    -- NULL = no VAT applied, so no number is stated. Paired with vat_applied by the CHECK below,
    -- which is what makes "refuses VAT" structural rather than a rule in a renderer.
    "rep_vat_number_snapshot"   TEXT,

    -- ── THE CUSTOMER, FROZEN. That is us. ──────────────────────────────────────────────────────
    -- Snapshot rather than read from lib/company-info at render time, for the same reason: our
    -- registered office moving must not rewrite a document somebody has already filed.
    "company_name_snapshot"    TEXT NOT NULL,
    "company_address_snapshot" TEXT NOT NULL,
    "company_number_snapshot"  TEXT NOT NULL,

    -- ── THE DOCUMENT ITSELF ────────────────────────────────────────────────────────────────────
    -- BYTEA, in this database, committed in the SAME TRANSACTION as the lines and the status. R2 is
    -- best-effort by design (no credentials → null, feature dormant) and its keys are
    -- tenant-partitioned; a rep has no tenant, and a submission that half-succeeded because a
    -- bucket was unreachable is not a state this document may have.
    "pdf"        BYTEA NOT NULL,
    "pdf_sha256" TEXT  NOT NULL,
    "pdf_bytes"  INTEGER NOT NULL,

    -- ── THE LIFECYCLE ──────────────────────────────────────────────────────────────────────────
    -- Submission IS creation: there is no draft, so there is no submitted-by column separate from
    -- rep_id. Two columns that must always be equal are a lie waiting to be written to.
    "submitted_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- NULL = not reviewed yet (pending_review). Set together, held by the lifecycle CHECK.
    "reviewed_at"      TIMESTAMP(3),
    -- The operator who reviewed it. NULL = not reviewed yet.
    "reviewed_by"      TEXT,
    -- NULL unless rejected. A rejection with no words is a rep who cannot act on it.
    "rejected_reason"  TEXT,
    -- NULL = not paid. This is when WE paid the rep's invoice, not when anything cleared.
    "paid_at"          TIMESTAMP(3),
    -- What we paid it by — our own payment reference. NULL = not paid, or paid without one.
    "paid_reference"   TEXT,
    -- NULL = not cancelled.
    "cancelled_at"     TIMESTAMP(3),
    -- NULL unless cancelled. Same rule as rejection: a withdrawal with no reason is unreadable.
    "cancelled_reason" TEXT,
    "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RepInvoice_pkey" PRIMARY KEY ("id")
);

-- ── THE NUMBER IS UNIQUE TO THE REP, NOT TO US ─────────────────────────────────────────────────
-- Two reps may both issue their invoice 001, because they are two businesses with two sales ledgers
-- and neither has heard of the other. The same rep may not, because that is one business issuing
-- one number twice. A global unique here would be us imposing our numbering on somebody else's
-- books, and would break on the second rep to sign up.
CREATE UNIQUE INDEX "RepInvoice_rep_number_key" ON "RepInvoice"("rep_id", "rep_invoice_number");

-- ONE LIVE INVOICE PER REP PER RUN, and rejected/cancelled ones do not count — a rejected invoice is
-- resubmitted under a NEW number, so a plain unique would refuse the resubmission. Partial unique,
-- the RepPayRun_one_open_key shape: the database refuses the second live one, not a code path.
CREATE UNIQUE INDEX "RepInvoice_one_live_per_run_key" ON "RepInvoice"("rep_id", "pay_run_id")
    WHERE "status" IN ('pending_review', 'approved', 'paid');

CREATE INDEX "RepInvoice_rep_id_status_idx" ON "RepInvoice"("rep_id", "status");
CREATE INDEX "RepInvoice_pay_run_id_idx" ON "RepInvoice"("pay_run_id");

-- RESTRICT BOTH WAYS. Deleting a rep or a run that has invoices would delete somebody's filed
-- accounting record and the money it evidences.
ALTER TABLE "RepInvoice" ADD CONSTRAINT "RepInvoice_rep_id_fkey"
    FOREIGN KEY ("rep_id") REFERENCES "Rep"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RepInvoice" ADD CONSTRAINT "RepInvoice_pay_run_id_fkey"
    FOREIGN KEY ("pay_run_id") REFERENCES "RepPayRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RepInvoice" ADD CONSTRAINT "RepInvoice_status_chk" CHECK (
  status IN ('pending_review', 'approved', 'paid', 'rejected', 'cancelled')
);
ALTER TABLE "RepInvoice" ADD CONSTRAINT "RepInvoice_number_chk" CHECK (btrim(rep_invoice_number) <> '');

-- ── VAT IS A REFUSAL, MADE STRUCTURAL ──────────────────────────────────────────────────────────
-- An unregistered rep's invoice CANNOT hold a VAT amount, a rate, a number or a tax point — the
-- database refuses the row. That is the difference between refusing to add VAT and merely leaving
-- it off: a renderer that "leaves it off" is one edit away from putting it back, and a generator
-- with a bug would write a VAT figure that nobody could subsequently explain.
-- The totals are checked here too, because a document whose total does not equal its parts is
-- wrong on paper regardless of how it got that way.
ALTER TABLE "RepInvoice" ADD CONSTRAINT "RepInvoice_vat_chk" CHECK (
     (vat_applied = false AND vat_rate_bp IS NULL AND vat_pennies IS NULL
        AND rep_vat_number_snapshot IS NULL AND tax_point IS NULL
        AND total_pennies = subtotal_pennies)
  OR (vat_applied = true  AND vat_rate_bp IS NOT NULL AND vat_rate_bp > 0
        AND vat_pennies IS NOT NULL AND tax_point IS NOT NULL
        AND rep_vat_number_snapshot IS NOT NULL AND btrim(rep_vat_number_snapshot) <> ''
        AND total_pennies = subtotal_pennies + vat_pennies)
);

-- ── THE DOCUMENT IS REALLY THERE, AND THE HASH IS REALLY ITS HASH ──────────────────────────────
-- pdf_bytes is not a second source of truth for the length; it is the assertion that the two agree,
-- checked by the database on every write. A fixture that "stores a PDF" by writing an empty buffer
-- and a plausible hash is refused — which is the point, because that fixture would otherwise prove
-- the freeze works.
ALTER TABLE "RepInvoice" ADD CONSTRAINT "RepInvoice_pdf_chk" CHECK (
  octet_length(pdf) > 0 AND pdf_bytes = octet_length(pdf) AND pdf_sha256 ~ '^[0-9a-f]{64}$'
);

-- ── THE LIFECYCLE, EXHAUSTIVELY ────────────────────────────────────────────────────────────────
-- Every status names every column it may and may not carry. A rejected invoice with no reason, an
-- approved one with no reviewer, a paid one that was never reviewed — all refused by the database.
-- Cancellation deliberately does NOT constrain the review columns: an invoice can be withdrawn
-- before review or after it, and both are true things that happened.
ALTER TABLE "RepInvoice" ADD CONSTRAINT "RepInvoice_lifecycle_chk" CHECK (
     (status = 'pending_review' AND reviewed_at IS NULL AND reviewed_by IS NULL
        AND rejected_reason IS NULL AND paid_at IS NULL AND paid_reference IS NULL
        AND cancelled_at IS NULL AND cancelled_reason IS NULL)
  OR (status = 'approved' AND reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL
        AND rejected_reason IS NULL AND paid_at IS NULL AND paid_reference IS NULL
        AND cancelled_at IS NULL AND cancelled_reason IS NULL)
  OR (status = 'paid' AND reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL
        AND rejected_reason IS NULL AND paid_at IS NOT NULL
        AND cancelled_at IS NULL AND cancelled_reason IS NULL)
  OR (status = 'rejected' AND reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL
        AND rejected_reason IS NOT NULL AND btrim(rejected_reason) <> ''
        AND paid_at IS NULL AND paid_reference IS NULL
        AND cancelled_at IS NULL AND cancelled_reason IS NULL)
  OR (status = 'cancelled' AND paid_at IS NULL AND paid_reference IS NULL
        AND rejected_reason IS NULL
        AND cancelled_at IS NOT NULL AND cancelled_reason IS NOT NULL AND btrim(cancelled_reason) <> '')
);

-- ── THE LINES, SNAPSHOT ONTO THE DOCUMENT ──────────────────────────────────────────────────────
-- The InvoiceLine shape, for the same reason: the ledger reads THESE, never the live entry. A
-- clawback upstream next month does not alter a document already submitted.
CREATE TABLE "RepInvoiceLine" (
    "id"             TEXT NOT NULL,
    "rep_invoice_id" TEXT NOT NULL,
    -- WHERE THIS LINE CAME FROM. Kept so the two can be reconciled, never read to render.
    "entry_id"       TEXT NOT NULL,
    -- The entry's OWN period, which is what makes arrears legible: a line from an earlier month
    -- appearing in this run's invoice is marked with the period it is actually for.
    "period"         TEXT NOT NULL,
    "is_arrears"     BOOLEAN NOT NULL,
    -- The garage, as it was named at submission. Snapshot: a tenant can rename, and a purged tenant
    -- leaves no row to read — and this document must still say what it said.
    "group_name_snapshot" TEXT NOT NULL,
    "description"    TEXT NOT NULL,
    "amount_pennies" INTEGER NOT NULL,
    "position"       INTEGER NOT NULL DEFAULT 0,
    "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RepInvoiceLine_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "RepInvoiceLine_rep_invoice_id_idx" ON "RepInvoiceLine"("rep_invoice_id");
CREATE INDEX "RepInvoiceLine_entry_id_idx" ON "RepInvoiceLine"("entry_id");

ALTER TABLE "RepInvoiceLine" ADD CONSTRAINT "RepInvoiceLine_rep_invoice_id_fkey"
    FOREIGN KEY ("rep_invoice_id") REFERENCES "RepInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- RESTRICT: the entry a submitted line names must not be deletable out from under it.
ALTER TABLE "RepInvoiceLine" ADD CONSTRAINT "RepInvoiceLine_entry_id_fkey"
    FOREIGN KEY ("entry_id") REFERENCES "CommissionEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ONE LINE PER ENTRY PER DOCUMENT. The cross-document rule is CommissionEntry.rep_invoice_id below;
-- this is the within-document one, and both are needed: an entry listed twice on one invoice is
-- double-billed just as surely as one listed on two.
CREATE UNIQUE INDEX "RepInvoiceLine_invoice_entry_key" ON "RepInvoiceLine"("rep_invoice_id", "entry_id");
ALTER TABLE "RepInvoiceLine" ADD CONSTRAINT "RepInvoiceLine_description_chk" CHECK (btrim(description) <> '');

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- 4. THE LINE KNOWS WHICH INVOICE TOOK IT. This is the column the concurrency clause turns on.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- NULL = released but not yet billed — the ordinary state of every line waiting for a rep to invoice
-- for it. Non-null = spoken for, and the write that sets it is a CONDITIONAL UPDATE on the pre-state:
--
--     UPDATE "CommissionEntry" SET status = 'billed', rep_invoice_id = $1
--      WHERE id = ANY($2) AND status = 'released' AND rep_invoice_id IS NULL
--
-- accepted only when the affected-row count equals the number of lines claimed. NOT a unique index
-- with a caught P2002: lib/commission.ts:32 records that a caught P2002 still poisons its
-- transaction, so the catch that looked like handling the race was itself the failure.
ALTER TABLE "CommissionEntry" ADD COLUMN "rep_invoice_id" TEXT;
CREATE INDEX "CommissionEntry_rep_invoice_id_idx" ON "CommissionEntry"("rep_invoice_id");
ALTER TABLE "CommissionEntry" ADD CONSTRAINT "CommissionEntry_rep_invoice_id_fkey"
    FOREIGN KEY ("rep_invoice_id") REFERENCES "RepInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- BILLED AND PAID CARRY AN INVOICE; NOTHING ELSE DOES. `void` is exempt, exactly as it is in
-- CommissionEntry_release_chk and for the same reason: void is terminal from ANY state, so a line
-- voided after being billed keeps the invoice it was billed on — removing it would be altering a
-- submitted document.
ALTER TABLE "CommissionEntry" ADD CONSTRAINT "CommissionEntry_invoiced_chk" CHECK (
  status = 'void' OR (status IN ('billed', 'paid')) = (rep_invoice_id IS NOT NULL)
);

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- 5. THE AUDIT CAN NAME A REP AS A SUBJECT.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- actor_rep_id already exists — a rep who ACTS. This is a rep who was ACTED UPON: an operator
-- changing the email that is now the whole credential, or the bank details we pay into. Those two
-- are the reason the column exists, and neither may be recorded as target_operator_id, which means
-- an operator was the subject.
--
-- Plain btree, matching its two siblings exactly. A partial index `WHERE target_rep_id IS NOT NULL`
-- would be smaller — most rows will never name a rep — but target_group_id and target_operator_id
-- are both plain, and one partial index among three identical columns is a difference that has to
-- be explained every time somebody reads the table. Worth revisiting for all three together.
ALTER TABLE "SuperAdminAudit" ADD COLUMN "target_rep_id" TEXT;
CREATE INDEX "SuperAdminAudit_target_rep_id_idx" ON "SuperAdminAudit"("target_rep_id");

-- AT MOST ONE SUBJECT. `<= 1`, not `= 1`, and that is a measurement rather than a preference:
-- SIXTEEN of the 740 existing rows carry no target at all, and none carries two. A `= 1` check
-- would have failed on those sixteen at migration time.
-- The one_actor form is a pairwise NOT-both, which does not extend to three columns without three
-- clauses; the sum reads as the sentence it is.
ALTER TABLE "SuperAdminAudit" ADD CONSTRAINT "SuperAdminAudit_one_target_chk" CHECK (
  (CASE WHEN target_group_id    IS NOT NULL THEN 1 ELSE 0 END)
+ (CASE WHEN target_operator_id IS NOT NULL THEN 1 ELSE 0 END)
+ (CASE WHEN target_rep_id      IS NOT NULL THEN 1 ELSE 0 END) <= 1
);
