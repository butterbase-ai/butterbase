-- @scope: runtime
-- Admission/worker claims and app teardown/move share the app-row lock.
-- No provider IO occurs in these transactions. Already-claimed work may finish
-- late; tombstones and attempt identities survive deletion for reconciliation.
BEGIN;
ALTER TABLE ai_video_preparations ADD COLUMN source_erased_at timestamptz;
CREATE FUNCTION video_preparation_redacted_request(original jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
 SELECT jsonb_build_object('request',jsonb_build_object('model',original->'request'->'model') ||
 CASE WHEN jsonb_typeof(original->'request'->'duration')='number' THEN jsonb_build_object('duration',original->'request'->'duration') ELSE '{}'::jsonb END,
 'selection',original->'selection')
$$;
CREATE OR REPLACE FUNCTION protect_video_preparation_originals() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.id,NEW.organization_id,NEW.app_id,NEW.user_id,NEW.end_user_sub,NEW.model,NEW.deadline,NEW.input_expires_at)
  IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.app_id,OLD.user_id,OLD.end_user_sub,OLD.model,OLD.deadline,OLD.input_expires_at)
  OR (OLD.input_identity IS NOT NULL AND NEW.input_identity IS DISTINCT FROM OLD.input_identity)
  OR (OLD.retry_consumed AND NOT NEW.retry_consumed)
  OR (OLD.terminal_outcome IS NOT NULL AND NEW.terminal_outcome IS DISTINCT FROM OLD.terminal_outcome)
  OR (OLD.source_erased_at IS NOT NULL AND NEW.source_erased_at IS DISTINCT FROM OLD.source_erased_at)
 THEN RAISE EXCEPTION 'video preparation originals/outcome are immutable'; END IF;
 IF NEW.request_json IS DISTINCT FROM OLD.request_json OR NEW.source_erased_at IS DISTINCT FROM OLD.source_erased_at THEN
  IF NOT (OLD.source_erased_at IS NULL AND NEW.source_erased_at IS NOT NULL AND OLD.input_expires_at<=now() AND OLD.deadline<=now()
    AND NEW.request_json=video_preparation_redacted_request(OLD.request_json)) THEN
   RAISE EXCEPTION 'video preparation request is immutable except expired source erasure';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION fence_video_preparation_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner apps%ROWTYPE;
BEGIN
 -- Recovery/settlement do not claim the preparation. Cancel/erase never needs
 -- fresh authority. Every new preparation claim serializes with app teardown.
 IF TG_OP='INSERT' OR (NEW.lease_owner IS NOT NULL AND NEW.fence IS DISTINCT FROM OLD.fence) THEN
  SELECT * INTO owner FROM apps WHERE id=NEW.app_id FOR UPDATE;
  IF NOT FOUND OR NOT (owner.provisioning_status='ready' OR (TG_OP='INSERT' AND owner.provisioning_status='migration_target_reserved' AND NEW.status IN ('completed','failed','cancelled','expired'))) OR owner.organization_id::text IS DISTINCT FROM NEW.organization_id
    OR owner.owner_id::text IS DISTINCT FROM NEW.user_id THEN
   RAISE EXCEPTION 'video preparation admission unavailable' USING ERRCODE='55000';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ai_video_preparation_admission BEFORE INSERT OR UPDATE ON ai_video_preparations FOR EACH ROW EXECUTE FUNCTION fence_video_preparation_admission();
CREATE FUNCTION fence_reference_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner apps%ROWTYPE;
BEGIN
 IF TG_OP='UPDATE' AND NEW.cleanup_pending THEN
  SELECT * INTO owner FROM apps WHERE id=NEW.app_id FOR UPDATE;
  IF FOUND AND owner.provisioning_status IN ('migrating','migration_target_reserved') THEN RETURN NULL; END IF;
 END IF;
 IF TG_OP='INSERT' OR (NEW.lease_owner IS NOT NULL AND NEW.fence IS DISTINCT FROM OLD.fence AND NOT NEW.cleanup_pending AND NEW.status IN ('registering','pending')) THEN
  SELECT * INTO owner FROM apps WHERE id=NEW.app_id FOR UPDATE;
  IF NOT FOUND OR NOT (owner.provisioning_status='ready' OR (TG_OP='INSERT' AND owner.provisioning_status='migration_target_reserved' AND NEW.status IN ('new','active','failed','deleted') AND (NEW.lease_expires_at IS NULL OR NEW.lease_expires_at<=now()))) OR owner.organization_id::text IS DISTINCT FROM NEW.organization_id THEN
   RAISE EXCEPTION 'reference admission unavailable' USING ERRCODE='55000';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ai_reference_asset_admission BEFORE INSERT OR UPDATE ON ai_reference_assets FOR EACH ROW EXECUTE FUNCTION fence_reference_admission();
CREATE TRIGGER ai_reference_group_admission BEFORE INSERT OR UPDATE ON ai_reference_asset_groups FOR EACH ROW EXECUTE FUNCTION fence_reference_admission();
CREATE FUNCTION fence_app_reference_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR (NEW.provisioning_status IN ('deleting','deprovisioning') AND NEW.provisioning_status IS DISTINCT FROM OLD.provisioning_status) THEN
  UPDATE ai_video_preparations SET deleted_at=COALESCE(deleted_at,now()),status=CASE WHEN status IN ('pending','in_progress') THEN 'cancelled' ELSE status END,
   fence=fence+1,lease_owner=NULL,lease_expires_at=NULL,updated_at=now() WHERE app_id=OLD.id AND archived_after_move IS NULL;
  UPDATE ai_reference_assets SET cleanup_pending=true,deleted_at=COALESCE(deleted_at,now()),updated_at=now() WHERE app_id=OLD.id AND archived_after_move IS NULL AND cleaned_at IS NULL;
  UPDATE ai_reference_asset_groups SET cleanup_pending=true,deleted_at=COALESCE(deleted_at,now()),updated_at=now() WHERE app_id=OLD.id AND archived_after_move IS NULL AND cleaned_at IS NULL;
 ELSIF NEW.provisioning_status='migrating' AND OLD.provisioning_status IS DISTINCT FROM NEW.provisioning_status THEN
  IF EXISTS(SELECT 1 FROM ai_video_preparations WHERE app_id=OLD.id AND archived_after_move IS NULL AND status IN ('pending','in_progress'))
   OR EXISTS(SELECT 1 FROM ai_video_attempts WHERE app_id=OLD.id AND archived_after_move IS NULL AND settlement_status!='acknowledged')
   OR EXISTS(SELECT 1 FROM ai_reference_assets WHERE app_id=OLD.id AND archived_after_move IS NULL AND (cleanup_pending OR status IN ('registering','pending','uncertain') OR lease_expires_at>now()))
   OR EXISTS(SELECT 1 FROM ai_reference_asset_groups WHERE app_id=OLD.id AND archived_after_move IS NULL AND (cleanup_pending OR status IN ('registering','pending','uncertain') OR lease_expires_at>now())) THEN
    RAISE EXCEPTION 'app has retained reference work; drain before moving' USING ERRCODE='55000';
  END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER apps_reference_lifecycle BEFORE DELETE OR UPDATE OF provisioning_status ON apps FOR EACH ROW EXECUTE FUNCTION fence_app_reference_lifecycle();
COMMIT;
