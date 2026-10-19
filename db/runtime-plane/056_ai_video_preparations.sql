-- @scope: runtime
-- 056: Generic durable video preparation/attempt and scoped reference assets.
-- RELEASE ORDER: deploy move/reverse-move registry compatibility FIRST, then
-- apply this migration; enable admission only after old workers are gone.
-- app_id deliberately has NO cascading apps FK: deletion first marks durable
-- tombstones, then removes the app. Unsettled receipts and opaque cleanup handles
-- must survive that deletion. Cleanup/retention workers own eventual row removal.
BEGIN;

CREATE TABLE ai_video_preparations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  app_id text NOT NULL,
  user_id text NOT NULL,
  end_user_sub text,
  model text NOT NULL,
  request_json jsonb NOT NULL,
  input_identity jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','completed','failed','cancelled','expired')),
  stage text CHECK (stage IN ('preparing_references','submitting','polling','settling')),
  terminal_outcome jsonb,
  retry_consumed boolean NOT NULL DEFAULT false,
  deadline timestamptz NOT NULL,
  input_expires_at timestamptz NOT NULL,
  deleted_at timestamptz,
  lease_owner text,
  lease_expires_at timestamptz,
  fence integer NOT NULL DEFAULT 0,
  archived_after_move uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_video_preparations_work ON ai_video_preparations (created_at) WHERE status IN ('pending','in_progress') AND archived_after_move IS NULL;
CREATE INDEX ai_video_preparations_app ON ai_video_preparations (app_id, created_at);

CREATE TABLE ai_video_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  preparation_id uuid NOT NULL REFERENCES ai_video_preparations(id),
  organization_id text NOT NULL,
  app_id text NOT NULL,
  attempt_number integer NOT NULL CHECK (attempt_number IN (1,2)),
  reservation_id uuid NOT NULL UNIQUE,
  provider_slot text NOT NULL,
  credential_namespace text NOT NULL,
  billing_context jsonb NOT NULL,
  submission_state text NOT NULL DEFAULT 'created' CHECK (submission_state IN ('created','submitting','accepted','uncertain','terminal')),
  provider_handle jsonb,
  diagnostic jsonb,
  terminal_outcome jsonb,
  terminal_at timestamptz,
  settlement_status text NOT NULL DEFAULT 'not_due' CHECK (settlement_status IN ('not_due','pending','acknowledged')),
  settlement_receipt jsonb,
  settled_at timestamptz,
  lease_owner text,
  lease_expires_at timestamptz,
  fence integer NOT NULL DEFAULT 0,
  archived_after_move uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (preparation_id, attempt_number),
  CHECK ((submission_state = 'terminal') = (terminal_outcome IS NOT NULL AND terminal_at IS NOT NULL)),
  CHECK ((settlement_status = 'acknowledged') = (settlement_receipt IS NOT NULL AND settled_at IS NOT NULL)),
  CHECK (settlement_status = 'not_due' OR submission_state = 'terminal')
);
CREATE INDEX ai_video_attempts_app ON ai_video_attempts (app_id);
CREATE INDEX ai_video_attempts_unsettled ON ai_video_attempts (created_at) WHERE settlement_status = 'pending' AND archived_after_move IS NULL;

CREATE TABLE ai_reference_asset_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  app_id text NOT NULL,
  end_user_sub text,
  provider_slot text NOT NULL,
  credential_namespace text NOT NULL,
  provider_id text,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','registering','pending','active','uncertain','failed','deleted')),
  diagnostic jsonb,
  cleanup_pending boolean NOT NULL DEFAULT false,
  deleted_at timestamptz,
  cleaned_at timestamptz,
  lease_owner text,
  lease_expires_at timestamptz,
  fence integer NOT NULL DEFAULT 0,
  archived_after_move uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Two partial indexes preserve NULL-vs-empty subject isolation on older PG too.
CREATE UNIQUE INDEX ai_reference_groups_owner ON ai_reference_asset_groups (organization_id, app_id, end_user_sub, provider_slot, credential_namespace) WHERE end_user_sub IS NOT NULL;
CREATE UNIQUE INDEX ai_reference_groups_no_subject ON ai_reference_asset_groups (organization_id, app_id, provider_slot, credential_namespace) WHERE end_user_sub IS NULL;

CREATE TABLE ai_reference_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  app_id text NOT NULL,
  end_user_sub text,
  provider_slot text NOT NULL,
  credential_namespace text NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  provider_id text,
  group_id uuid REFERENCES ai_reference_asset_groups(id),
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','registering','pending','active','uncertain','failed','deleted')),
  diagnostic jsonb,
  cleanup_pending boolean NOT NULL DEFAULT false,
  deleted_at timestamptz,
  cleaned_at timestamptz,
  lease_owner text,
  lease_expires_at timestamptz,
  fence integer NOT NULL DEFAULT 0,
  archived_after_move uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ai_reference_assets_owner_hash ON ai_reference_assets (organization_id, app_id, end_user_sub, provider_slot, credential_namespace, sha256) WHERE end_user_sub IS NOT NULL;
CREATE UNIQUE INDEX ai_reference_assets_no_subject_hash ON ai_reference_assets (organization_id, app_id, provider_slot, credential_namespace, sha256) WHERE end_user_sub IS NULL;
CREATE INDEX ai_reference_assets_cleanup ON ai_reference_assets (updated_at) WHERE cleanup_pending AND archived_after_move IS NULL;
CREATE INDEX ai_reference_groups_cleanup ON ai_reference_asset_groups (updated_at) WHERE cleanup_pending AND archived_after_move IS NULL;

CREATE FUNCTION protect_video_preparation_originals() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.organization_id, NEW.app_id, NEW.user_id, NEW.end_user_sub, NEW.model, NEW.request_json, NEW.deadline, NEW.input_expires_at)
    IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.app_id, OLD.user_id, OLD.end_user_sub, OLD.model, OLD.request_json, OLD.deadline, OLD.input_expires_at)
    OR (OLD.input_identity IS NOT NULL AND NEW.input_identity IS DISTINCT FROM OLD.input_identity)
    OR (OLD.retry_consumed AND NOT NEW.retry_consumed)
    OR (OLD.terminal_outcome IS NOT NULL AND NEW.terminal_outcome IS DISTINCT FROM OLD.terminal_outcome) THEN
    RAISE EXCEPTION 'video preparation originals/outcome are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ai_video_preparations_immutable BEFORE UPDATE ON ai_video_preparations FOR EACH ROW EXECUTE FUNCTION protect_video_preparation_originals();

CREATE FUNCTION protect_video_attempt_originals() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.preparation_id, NEW.organization_id, NEW.app_id, NEW.attempt_number, NEW.reservation_id, NEW.provider_slot, NEW.credential_namespace, NEW.billing_context)
    IS DISTINCT FROM (OLD.id, OLD.preparation_id, OLD.organization_id, OLD.app_id, OLD.attempt_number, OLD.reservation_id, OLD.provider_slot, OLD.credential_namespace, OLD.billing_context)
    OR (OLD.terminal_outcome IS NOT NULL AND (NEW.terminal_outcome, NEW.terminal_at) IS DISTINCT FROM (OLD.terminal_outcome, OLD.terminal_at))
    OR (OLD.settled_at IS NOT NULL AND (NEW.settled_at, NEW.settlement_receipt, NEW.settlement_status) IS DISTINCT FROM (OLD.settled_at, OLD.settlement_receipt, OLD.settlement_status))
    OR (OLD.provider_handle IS NOT NULL AND NEW.provider_handle IS DISTINCT FROM OLD.provider_handle) THEN
    RAISE EXCEPTION 'video attempt reservation/billing/outcome/receipt are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ai_video_attempts_immutable BEFORE UPDATE ON ai_video_attempts FOR EACH ROW EXECUTE FUNCTION protect_video_attempt_originals();
COMMIT;
