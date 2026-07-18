-- Media rebuild: a video poster-frame key + a display rotation on JobCardPhoto. Both additive +
-- non-destructive. rotation defaults 0 (existing media unrotated); poster_r2_key null on existing
-- videos → the grid shows a placeholder tile (no backfill, no transcode). Rotation is a display
-- interpretation (CSS transform) — it never re-encodes or touches the R2 bytes.
ALTER TABLE "JobCardPhoto" ADD COLUMN "poster_r2_key" TEXT;
ALTER TABLE "JobCardPhoto" ADD COLUMN "rotation" INTEGER NOT NULL DEFAULT 0;
