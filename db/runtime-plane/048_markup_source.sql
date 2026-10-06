-- @scope: runtime
-- 048: Record WHICH pricing rule produced markup_pct on each charge:
--   'special'          — org is special_pricing and the model was in the book
--   'global'           — normal path (not special, or model absent from book)
--   'global_degraded'  — special-book lookup FAILED and we fell back to global
-- Without this, a 20% charge on a special customer is indistinguishable from a
-- silently degraded lookup. Nullable: rows written before this migration have
-- no recorded source.
ALTER TABLE ai_usage_logs ADD COLUMN IF NOT EXISTS markup_source text;
ALTER TABLE ai_image_jobs ADD COLUMN IF NOT EXISTS markup_source text;
ALTER TABLE ai_video_jobs ADD COLUMN IF NOT EXISTS markup_source text;
