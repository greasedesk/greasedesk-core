-- A GATE NEVER WRITES THE OWNER'S SWITCH. ITS OVERRIDE IS A LEASE, IN ITS OWN TABLE.
--
-- Hand-written, applied with `migrate deploy`. Supersedes 20260910210000_prospect_sending_lease,
-- applied minutes earlier and never read by anything, whose two columns this drops.
--
-- ── WHY THE FIRST SHAPE WAS WRONG ──────────────────────────────────────────────────────────────
-- It put the lease IN the owner's row. That made a killed gate harmless to prospects, but it still
-- OVERWROTE the owner's decision: on a day the owner has sending ON, a gate killed mid-lease would
-- leave real sending silently OFF. Failing closed is the right direction, but it is still a gate
-- changing a decision that is not the gate's to change — and a restore was still needed to undo it.
-- In its own table the owner's row is never touched, so there is nothing to restore at all.
--
-- ── WHY A LEASE AT ALL ─────────────────────────────────────────────────────────────────────────
-- prospect-gate has to watch a real send, so it turned the switch ON and restored it in a `finally`.
-- A killed process runs no `finally` — SIGKILL is what gates.mjs does to a gate that overruns its
-- timeout. Proven 10 Sep 2026 by killing the gate mid-run: the switch stayed ON, changed_by
-- 'prospect-gate' — sending ON for every real consented prospect, with placeholder copy.
--
-- ── WHAT A LEASE IS ────────────────────────────────────────────────────────────────────────────
-- Sending ON or OFF for ONE prospect, until expires_at. It is consulted only when a run names that
-- prospect, so no cron run (which names none) and no other prospect ever sees it; after it expires it
-- is ignored. A lease left behind by a killed process is therefore harmless the moment it is written.
-- Deleting the prospect deletes its lease. The reader is sendingAllows() in lib/prospects.ts.
--
--   _short_chk  at most five minutes from creation, so a "lease" cannot be an open switch in disguise.
ALTER TABLE "ProspectSending" DROP CONSTRAINT "ProspectSending_lease_pair_chk";
ALTER TABLE "ProspectSending" DROP CONSTRAINT "ProspectSending_lease_on_chk";
ALTER TABLE "ProspectSending" DROP CONSTRAINT "ProspectSending_lease_short_chk";
ALTER TABLE "ProspectSending" DROP COLUMN "only_prospect_id";
ALTER TABLE "ProspectSending" DROP COLUMN "expires_at";

CREATE TABLE "ProspectSendingLease" (
    "prospect_id" TEXT NOT NULL,
    "enabled"     BOOLEAN NOT NULL,
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at"  TIMESTAMP(3) NOT NULL,
    "created_by"  TEXT NOT NULL,

    CONSTRAINT "ProspectSendingLease_pkey" PRIMARY KEY ("prospect_id")
);
ALTER TABLE "ProspectSendingLease" ADD CONSTRAINT "ProspectSendingLease_prospect_id_fkey"
  FOREIGN KEY ("prospect_id") REFERENCES "Prospect"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProspectSendingLease" ADD CONSTRAINT "ProspectSendingLease_short_chk"
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '5 minutes');
