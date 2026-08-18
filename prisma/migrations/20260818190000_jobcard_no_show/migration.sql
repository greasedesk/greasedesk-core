-- No-show as a job card outcome: its own terminal status, never collapsed into cancellation.
-- A cancellation is notice; a no-show is silence — and the fact is worth money (two no-shows →
-- ask for a deposit). Additive only.
ALTER TYPE "JobCardStatus" ADD VALUE 'no_show';
