-- THE REASON A VISIT WAS NOT SCANNED BECOMES A CODE, AND THE PROSE GOES WITH THE TENANT.
--
-- Hand-written, applied with `migrate deploy`. `migrate dev` proposes a RESET here.
--
-- RepVisit SURVIVES a tenant purge — it is the supporting document for the commission ledger, and
-- purge-completeness-gate names it. `reason` shipped as free prose, so "Dave's tablet was flat" was
-- a name we kept after an erasure. A code answers the audit question ("why was this not scanned?")
-- and holds nothing about the garage's people; the sentence moves to RepVisitNote, which the purge
-- sweeps by visit id exactly as it does the answers.
--
-- Zero rows exist, so nothing is migrated — the whole slice is still dormant.

-- ── THE PROSE, IN ITS OWN ROW ──────────────────────────────────────────────────────────────────
CREATE TABLE "RepVisitNote" (
    "id"         TEXT NOT NULL,
    "visit_id"   TEXT NOT NULL,
    "body"       TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3),

    CONSTRAINT "RepVisitNote_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RepVisitNote_visit_id_key" ON "RepVisitNote"("visit_id");
ALTER TABLE "RepVisitNote" ADD CONSTRAINT "RepVisitNote_visit_id_fkey"
    FOREIGN KEY ("visit_id") REFERENCES "RepVisit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A note that exists with nothing in it is a row nobody meant to write. The absence of a note is
-- the absence of the ROW.
ALTER TABLE "RepVisitNote" ADD CONSTRAINT "RepVisitNote_body_chk" CHECK (btrim(body) <> '');

-- ── THE CLOSED SET, in the shape of MarketingContact_reason_check ───────────────────────────────
-- EVERY VALUE IS A CASE WHERE THE REP WAS THERE. "Could not attend" and "garage closed" are
-- deliberately absent: a visit nobody attended is not a visit with a reason, it is a month with no
-- visit, and recording one would set satisfies_period and pay the full rate for a meeting that
-- never happened. There is no 'other' either — the prose that would explain it is erased with the
-- tenant, so 'other' degrades to noise at the moment the audit needs it. Amending the set is a
-- migration, which is the deliberate act MarketingContact.reason has twice made.
ALTER TABLE "RepVisit" ADD CONSTRAINT "RepVisit_reason_chk" CHECK (reason IS NULL OR reason = ANY (ARRAY[
  'screen_unavailable'::text,   -- no working device to display the code
  'no_one_could_sign_in'::text, -- a device, but nobody on site who could sign in to show it
  'scan_failed'::text,          -- the code was displayed and the read did not complete
  'code_expired'::text          -- displayed, but stale by the time it was read
]));

-- ── AND THE PAIRING, BOTH WAYS ─────────────────────────────────────────────────────────────────
-- Replaces the btrim form: a reason is no longer prose to be non-empty, it is a code the constraint
-- above already closes. What this holds is the AGREEMENT between source and evidence — and it now
-- refuses a reason beside a SCAN, which the first version allowed. A scan is the evidence; a reason
-- next to one is a contradiction rather than extra detail.
ALTER TABLE "RepVisit" DROP CONSTRAINT "RepVisit_evidence_chk";
ALTER TABLE "RepVisit" ADD CONSTRAINT "RepVisit_evidence_chk" CHECK (
      (source = 'scan'     AND code_step IS NOT NULL AND reason IS NULL)
   OR (source = 'operator' AND reason IS NOT NULL)
);
