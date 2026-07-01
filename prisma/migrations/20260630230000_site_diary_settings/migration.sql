-- Additive/non-destructive: per-site diary display settings. Existing sites get sensible defaults
-- (open Mon–Sat, 08:00–18:00, week starts Monday). Weekday numbering: 0=Sun .. 6=Sat.
ALTER TABLE "Site" ADD COLUMN "open_days"  INTEGER[] NOT NULL DEFAULT '{1,2,3,4,5,6}';
ALTER TABLE "Site" ADD COLUMN "open_hour"  INTEGER   NOT NULL DEFAULT 8;
ALTER TABLE "Site" ADD COLUMN "close_hour" INTEGER   NOT NULL DEFAULT 18;
ALTER TABLE "Site" ADD COLUMN "week_start" INTEGER   NOT NULL DEFAULT 1;
