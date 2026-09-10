-- A GATE'S "ON" IS A LEASE: ONE PROSPECT, A FEW MINUTES — NEVER AN OPEN SWITCH.
--
-- Hand-written, applied with `migrate deploy`.
--
-- ── WHY ────────────────────────────────────────────────────────────────────────────────────────
-- prospect-gate has to see a real send go out, so it turned the switch ON and restored it in a
-- `finally`. Killed mid-run — SIGKILL, which is exactly what gates.mjs does to a gate that overruns
-- its timeout — no `finally` runs. Proven on 10 Sep 2026 by killing the gate while the switch was on:
-- the row stayed `enabled = true, changed_by = 'prospect-gate'`, which is sending ON for every real
-- consented prospect, with placeholder copy in the templates. A teardown cannot be what makes this
-- safe, because the one case that matters is the one where the teardown does not execute.
--
-- ── WHAT A LEASE IS ────────────────────────────────────────────────────────────────────────────
-- A row with `only_prospect_id` and `expires_at` is ON for that ONE prospect until that moment, and
-- OFF for everybody else throughout — including every cron run, which names no prospect. After it
-- expires it is OFF for that prospect too. So a lease left behind by a killed process is harmless
-- the instant it is written, not merely once somebody cleans it up. The reader is sendingAllows()
-- in lib/prospects.ts, and it is the only reader.
--
-- The owner's switch is the row WITHOUT them: open-ended and for everyone. NULL in both columns is
-- the meaningful absence "not a lease", and setProspectSending writes it explicitly.
--
-- ── THE SHAPE IS THE DATABASE'S, NOT THE GATE'S GOOD MANNERS ───────────────────────────────────
--   _lease_pair_chk   a lease names a prospect AND an expiry, or neither — an unscoped expiring ON
--                     would be sending-for-everyone for a while, which is the thing being prevented.
--   _lease_on_chk     a lease is an ON. An "off, expiring" row would be the owner's switch with
--                     a timer nobody asked for.
--   _lease_short_chk  at most five minutes from when it was written, so nobody can write a
--                     year-long "lease" that is really an open switch with extra steps.
ALTER TABLE "ProspectSending" ADD COLUMN "only_prospect_id" TEXT;
ALTER TABLE "ProspectSending" ADD COLUMN "expires_at" TIMESTAMP(3);

ALTER TABLE "ProspectSending" ADD CONSTRAINT "ProspectSending_lease_pair_chk"
  CHECK ((only_prospect_id IS NULL) = (expires_at IS NULL));
ALTER TABLE "ProspectSending" ADD CONSTRAINT "ProspectSending_lease_on_chk"
  CHECK (expires_at IS NULL OR enabled);
ALTER TABLE "ProspectSending" ADD CONSTRAINT "ProspectSending_lease_short_chk"
  CHECK (expires_at IS NULL OR expires_at <= changed_at + interval '5 minutes');
