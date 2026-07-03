-- Per-site breaks (lunch etc.): non-working bands the footprint skips + the diary draws. Additive,
-- nullable JSON = [{start,end}] minutes-from-midnight. NULL everywhere at first → identical to current
-- behaviour (breaks default to [] in computeFootprint), so nothing moves until a site sets a break.
ALTER TABLE "Site" ADD COLUMN "breaks" JSONB;
