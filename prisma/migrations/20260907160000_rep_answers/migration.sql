-- THE FOUR ANSWERS, THE LEAD ONE OF THEM BECOMES, AND A TENANT LOGIN STAMP.
--
-- Hand-written, applied with `migrate deploy`. `migrate dev` proposes a RESET here.
--
-- DORMANT: nothing reads an answer or a lead. The only wired change is that a tenant login now
-- stamps User.last_login_at — which nothing reads either. rep-answers-gate pins both.

-- ── A TENANT LOGIN IS RECORDED, THE WAY AN OPERATOR LOGIN ALREADY IS ────────────────────────────
-- NULL = never signed in since this column existed, which is every user today. Deliberately NOT
-- backfilled from created_at: an account's creation is not a login, and a made-up timestamp would
-- be indistinguishable from a real one for exactly the question this column answers.
ALTER TABLE "User" ADD COLUMN "last_login_at" TIMESTAMP(3);

-- ── THE PLATFORM LEDGER CAN NAME A REP ─────────────────────────────────────────────────────────
-- A rep is not an operator. operator_user_id NULL already means "the platform itself acted", so the
-- second actor gets its own column rather than overloading that sentinel.
ALTER TABLE "SuperAdminAudit" ADD COLUMN "actor_rep_id" TEXT;

-- At most one author. Both null is still the platform acting; both set would be a row claiming two.
ALTER TABLE "SuperAdminAudit" ADD CONSTRAINT "SuperAdminAudit_one_actor_chk" CHECK (
    NOT (operator_user_id IS NOT NULL AND actor_rep_id IS NOT NULL)
);

-- ── WHAT THE REP WROTE UP ──────────────────────────────────────────────────────────────────────
CREATE TABLE "RepVisitAnswer" (
    "id"                  TEXT NOT NULL,
    "visit_id"            TEXT NOT NULL,
    "app_working"         TEXT NOT NULL,
    "app_working_note"    TEXT,
    "app_working_at"      TIMESTAMP(3),
    "using_it"            TEXT NOT NULL,
    "using_it_at"         TIMESTAMP(3),
    "whats_missing_state" TEXT NOT NULL,
    "whats_missing_text"  TEXT,
    "whats_missing_at"    TIMESTAMP(3),
    "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"          TIMESTAMP(3),

    CONSTRAINT "RepVisitAnswer_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RepVisitAnswer_visit_id_key" ON "RepVisitAnswer"("visit_id");
ALTER TABLE "RepVisitAnswer" ADD CONSTRAINT "RepVisitAnswer_visit_id_fkey"
    FOREIGN KEY ("visit_id") REFERENCES "RepVisit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CLOSED SETS. 'not_asked' is a VALUE, not a null — see lib/rep-answers for the argument, and
-- lib/due-items for the precedent it follows.
ALTER TABLE "RepVisitAnswer" ADD CONSTRAINT "RepVisitAnswer_values_chk" CHECK (
       app_working         IN ('working', 'problems', 'not_asked')
   AND using_it            IN ('daily', 'sometimes', 'barely', 'not_asked')
   AND whats_missing_state IN ('not_asked', 'nothing', 'said')
);

-- THE PAIRING, in the shape of RepVisit_evidence_chk. Three real states, and without this there are
-- four representable combinations — the fourth being nonsense nobody prevents.
ALTER TABLE "RepVisitAnswer" ADD CONSTRAINT "RepVisitAnswer_missing_chk" CHECK (
       (whats_missing_state =  'said' AND whats_missing_text IS NOT NULL AND btrim(whats_missing_text) <> '')
    OR (whats_missing_state <> 'said' AND whats_missing_text IS NULL)
);

-- ONLY AN ANSWER IS AN EVENT. responseAtFor made physical: not_asked leaves the timestamp null,
-- every real answer carries one — including the negatives, which were asked and answered.
-- NOTE the deliberate asymmetry with app_working_note above: this is a SHAPE rule, which is what a
-- constraint is good at. "A problem must be described" is judgement, and lives in the refusal.
ALTER TABLE "RepVisitAnswer" ADD CONSTRAINT "RepVisitAnswer_asked_at_chk" CHECK (
       ((app_working         = 'not_asked') = (app_working_at   IS NULL))
   AND ((using_it            = 'not_asked') = (using_it_at      IS NULL))
   AND ((whats_missing_state = 'not_asked') = (whats_missing_at IS NULL))
);

-- ── THE PAYMENTS LEAD ──────────────────────────────────────────────────────────────────────────
CREATE TABLE "RepLead" (
    "id"               TEXT NOT NULL,
    "visit_id"         TEXT NOT NULL,
    "provider"         TEXT,
    "pays_now_pennies" INTEGER,
    "contract_end"     TIMESTAMP(3),
    "interest"         TEXT NOT NULL,
    "interest_at"      TIMESTAMP(3),
    "follow_up_on"     TIMESTAMP(3),
    "status"           TEXT NOT NULL DEFAULT 'open',
    "closed_at"        TIMESTAMP(3),
    "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"       TIMESTAMP(3),

    CONSTRAINT "RepLead_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RepLead_visit_id_key" ON "RepLead"("visit_id");
CREATE INDEX "RepLead_status_follow_up_on_idx" ON "RepLead"("status", "follow_up_on");
ALTER TABLE "RepLead" ADD CONSTRAINT "RepLead_visit_id_fkey"
    FOREIGN KEY ("visit_id") REFERENCES "RepVisit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- INTEREST is what the garage said; STATUS is what we did. Two axes, two closed sets.
ALTER TABLE "RepLead" ADD CONSTRAINT "RepLead_values_chk" CHECK (
       interest IN ('interested', 'not_interested', 'not_asked')
   AND status   IN ('open', 'converted', 'declined')
);

ALTER TABLE "RepLead" ADD CONSTRAINT "RepLead_asked_at_chk" CHECK (
    (interest = 'not_asked') = (interest_at IS NULL)
);

-- Closed exactly when it is not open, so a closed lead can never be missing its date and an open
-- one can never carry a stale one.
ALTER TABLE "RepLead" ADD CONSTRAINT "RepLead_closure_chk" CHECK (
    (status = 'open') = (closed_at IS NULL)
);
