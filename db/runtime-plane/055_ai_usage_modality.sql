-- @scope: runtime
-- 055: Record the modality of each AI call (chat | embedding | image | video |
-- audio | decisions) so usage can be split by type. Added with decision-model
-- support (typesafe/jev-1.13 etc.), whose spend would otherwise be
-- indistinguishable from embeddings.
--
-- Nullable: rows written before this migration read as "unspecified".
ALTER TABLE ai_usage_logs ADD COLUMN IF NOT EXISTS modality text;
