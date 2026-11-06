-- @scope: runtime
-- Deploy optional move/reverse registration before applying this migration.
-- Keep output admission disabled until every storage reader enforces its policy.
BEGIN;

ALTER TABLE storage_objects
  ADD COLUMN access_scope text NOT NULL DEFAULT 'app' CHECK(access_scope IN ('app','prepared_video')),
  ADD COLUMN access_subject text,
  ADD COLUMN published_at timestamptz,
  ADD CONSTRAINT storage_objects_prepared_private CHECK(access_scope='app' OR NOT public);

CREATE TABLE ai_video_preparation_outputs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 preparation_id uuid NOT NULL REFERENCES ai_video_preparations(id),
 attempt_id uuid NOT NULL REFERENCES ai_video_attempts(id),
 organization_id text NOT NULL,
 app_id text NOT NULL,
 user_id text NOT NULL,
 end_user_sub text,
 output_index integer NOT NULL CHECK(output_index>=0),
 expected_outputs integer NOT NULL CHECK(expected_outputs BETWEEN 1 AND 8 AND output_index<expected_outputs),
 object_id uuid NOT NULL UNIQUE,
 bucket text NOT NULL CHECK(length(bucket) BETWEEN 1 AND 255),
 object_key text NOT NULL CHECK(length(object_key) BETWEEN 1 AND 1024),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','copying','copied','stored','cleanup_pending','deleted','failed')),
 provider_cost_usd numeric(12,6) CHECK(provider_cost_usd>=0 AND provider_cost_usd<>'NaN'::numeric),
 provider_completed_at timestamptz NOT NULL DEFAULT now(),
 source_handle text CHECK(octet_length(source_handle)<=8192),
 size_bytes bigint CHECK(size_bytes>0 AND size_bytes<=268435456),
 sha256 text CHECK(sha256 ~ '^[0-9a-f]{64}$'),
 content_type text CHECK(content_type IN ('video/mp4','video/webm')),
 capacity_reserved boolean NOT NULL DEFAULT false,
 upload_claim_fence integer,
 upload_uncertain_until timestamptz,
 uncertain_put boolean NOT NULL DEFAULT false,
 deadline timestamptz NOT NULL,
 next_action_at timestamptz NOT NULL DEFAULT now(),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
 error_code text,
 deleted_at timestamptz,
 cleanup_not_before timestamptz NOT NULL DEFAULT now(),
 cleanup_probe_until timestamptz,
 lease_owner text,
 lease_expires_at timestamptz,
 claim_attempt_fence integer,
 fence integer NOT NULL DEFAULT 0,
 archived_after_move uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(attempt_id,output_index),
 UNIQUE(bucket,object_key),
 CHECK(state NOT IN ('copied','stored') OR (size_bytes IS NOT NULL AND sha256 IS NOT NULL AND content_type IS NOT NULL)),
 CHECK(state<>'copied' OR capacity_reserved),
 CHECK(state<>'stored' OR NOT capacity_reserved)
);
CREATE INDEX ai_video_outputs_app ON ai_video_preparation_outputs(app_id,attempt_id);
CREATE INDEX ai_video_outputs_work ON ai_video_preparation_outputs(next_action_at)
 WHERE archived_after_move IS NULL AND state IN ('pending','copying','copied','cleanup_pending','deleted');

CREATE FUNCTION protect_video_output_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.deleted_at IS NOT NULL OR NEW.state IN ('copied','stored','cleanup_pending','deleted','failed') THEN NEW.source_handle := NULL; END IF;
 IF (NEW.id,NEW.preparation_id,NEW.attempt_id,NEW.organization_id,NEW.app_id,NEW.user_id,NEW.end_user_sub,
     NEW.output_index,NEW.expected_outputs,NEW.object_id,NEW.bucket,NEW.object_key,NEW.deadline,NEW.provider_completed_at)
 IS DISTINCT FROM (OLD.id,OLD.preparation_id,OLD.attempt_id,OLD.organization_id,OLD.app_id,OLD.user_id,OLD.end_user_sub,
     OLD.output_index,OLD.expected_outputs,OLD.object_id,OLD.bucket,OLD.object_key,OLD.deadline,OLD.provider_completed_at)
 OR (OLD.provider_cost_usd IS NOT NULL AND NEW.provider_cost_usd IS DISTINCT FROM OLD.provider_cost_usd)
 OR (OLD.sha256 IS NOT NULL AND (NEW.sha256,NEW.size_bytes,NEW.content_type) IS DISTINCT FROM (OLD.sha256,OLD.size_bytes,OLD.content_type))
 OR (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at) THEN
  RAISE EXCEPTION 'video output identity and measured bytes are immutable';
 END IF;
 IF OLD.uncertain_put AND NOT NEW.uncertain_put THEN RAISE EXCEPTION 'uncertain upload history is immutable'; END IF;
 IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
   (OLD.state='pending' AND NEW.state IN ('copying','cleanup_pending','failed')) OR
   (OLD.state='copying' AND NEW.state IN ('pending','copied','cleanup_pending','failed')) OR
   (OLD.state='copied' AND NEW.state IN ('stored','cleanup_pending','failed')) OR
   (OLD.state='stored' AND NEW.state='cleanup_pending') OR
   (OLD.state='cleanup_pending' AND NEW.state='deleted') OR
   (OLD.state='deleted' AND NEW.state='cleanup_pending') OR
   (OLD.state='failed' AND NEW.state='cleanup_pending')) THEN
  RAISE EXCEPTION 'invalid video output state transition';
 END IF;
 IF OLD.deleted_at IS NOT NULL AND NEW.state NOT IN ('cleanup_pending','deleted','failed') THEN
  RAISE EXCEPTION 'deleted video output cannot be resurrected';
 END IF;
 IF OLD.archived_after_move IS NOT NULL AND
    (NEW.state,NEW.lease_owner,NEW.fence,NEW.sha256,NEW.size_bytes,NEW.source_handle) IS DISTINCT FROM
    (OLD.state,OLD.lease_owner,OLD.fence,OLD.sha256,OLD.size_bytes,OLD.source_handle) THEN
  RAISE EXCEPTION 'archived video output cannot perform work';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER video_outputs_immutable BEFORE UPDATE ON ai_video_preparation_outputs
 FOR EACH ROW EXECUTE FUNCTION protect_video_output_identity();

CREATE FUNCTION fence_video_output_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner apps%ROWTYPE; parent ai_video_preparations%ROWTYPE; attempt ai_video_attempts%ROWTYPE;
 fresh boolean; restoring boolean;
BEGIN
 fresh := TG_OP='INSERT' OR (NEW.lease_owner IS NOT NULL AND NEW.fence IS DISTINCT FROM OLD.fence)
   OR (NEW.state IS DISTINCT FROM OLD.state AND NEW.state IN ('copying','copied','stored'));
 IF NOT fresh THEN RETURN NEW; END IF;
 IF TG_OP='INSERT' THEN
  SELECT * INTO owner FROM apps WHERE id=NEW.app_id FOR UPDATE;
 ELSE
  BEGIN SELECT * INTO owner FROM apps WHERE id=NEW.app_id FOR UPDATE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN RETURN NULL; END;
 END IF;
 IF NEW.state IN ('cleanup_pending','deleted') THEN
  IF owner.provisioning_status IN ('migrating','migration_target_reserved') OR
    (owner.id IS NOT NULL AND owner.organization_id::text IS DISTINCT FROM NEW.organization_id) THEN RETURN NULL; END IF;
  RETURN NEW;
 END IF;
 SELECT * INTO parent FROM ai_video_preparations WHERE id=NEW.preparation_id;
 SELECT * INTO attempt FROM ai_video_attempts WHERE id=NEW.attempt_id;
 restoring := TG_OP='INSERT' AND owner.provisioning_status='migration_target_reserved'
   AND NEW.state IN ('stored','deleted','failed') AND NEW.lease_owner IS NULL;
 IF owner.id IS NULL OR (owner.provisioning_status<>'ready' AND NOT restoring)
  OR owner.organization_id::text IS DISTINCT FROM NEW.organization_id OR owner.owner_id::text IS DISTINCT FROM NEW.user_id
  OR parent.id IS NULL OR attempt.id IS NULL OR attempt.preparation_id<>parent.id
  OR (parent.app_id,parent.organization_id,parent.user_id,parent.end_user_sub)
    IS DISTINCT FROM (NEW.app_id,NEW.organization_id,NEW.user_id,NEW.end_user_sub)
  OR (attempt.app_id,attempt.organization_id) IS DISTINCT FROM (NEW.app_id,NEW.organization_id)
  OR (NOT restoring AND (attempt.submission_state<>'accepted' OR parent.deleted_at IS NOT NULL
    OR parent.archived_after_move IS NOT NULL OR attempt.archived_after_move IS NOT NULL OR parent.deadline<=now()))
  OR NEW.deadline>parent.deadline THEN
   RAISE EXCEPTION 'video output scope or accepted-attempt admission unavailable' USING ERRCODE='55000';
 END IF;
 IF NEW.lease_owner IS NOT NULL AND NEW.state='copying' AND NEW.claim_attempt_fence IS DISTINCT FROM attempt.fence THEN
  RAISE EXCEPTION 'video output claim uses a stale attempt fence' USING ERRCODE='55000';
 END IF;
 IF EXISTS(SELECT 1 FROM ai_video_preparation_outputs WHERE attempt_id=NEW.attempt_id
   AND id<>NEW.id AND expected_outputs<>NEW.expected_outputs) THEN RAISE EXCEPTION 'video output count is immutable'; END IF;
 IF NEW.state='stored' AND NOT EXISTS(
  SELECT 1 FROM storage_objects s WHERE s.id=NEW.object_id AND s.app_id=NEW.app_id
   AND s.organization_id::text=NEW.organization_id AND s.bucket=NEW.bucket AND s.key=NEW.object_key
   AND s.size_bytes=NEW.size_bytes AND s.content_type=NEW.content_type
   AND s.access_scope='prepared_video' AND s.access_subject IS NOT DISTINCT FROM NEW.end_user_sub
   AND NOT s.public AND s.archived_after_move IS NULL
 ) THEN RAISE EXCEPTION 'stored video output requires matching storage metadata'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER video_outputs_admission BEFORE INSERT OR UPDATE ON ai_video_preparation_outputs
 FOR EACH ROW EXECUTE FUNCTION fence_video_output_admission();

CREATE FUNCTION require_retained_video_output() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner apps%ROWTYPE; actual_ids jsonb; actual_count integer; expected integer;
BEGIN
 IF NEW.submission_state<>'terminal' OR OLD.submission_state='terminal' OR NEW.terminal_outcome->>'status'<>'completed' THEN RETURN NEW; END IF;
 IF NOT (NEW.terminal_outcome ? 'outputObjectIds') THEN
  IF NEW.billing_context->>'outputStorageVersion'='1' THEN RAISE EXCEPTION 'completed attempt requires retained output metadata'; END IF;
  RETURN NEW;
 END IF;
 -- The attempt row is already locked. Never wait child->app during teardown.
 BEGIN SELECT * INTO owner FROM apps WHERE id=NEW.app_id FOR UPDATE NOWAIT;
 EXCEPTION WHEN lock_not_available THEN RETURN NULL; END;
 IF owner.id IS NULL OR owner.provisioning_status<>'ready' OR owner.organization_id::text<>NEW.organization_id
    OR OLD.lease_expires_at IS NULL OR OLD.lease_expires_at<=now()
    OR NOT EXISTS(SELECT 1 FROM ai_video_preparations p WHERE p.id=NEW.preparation_id
      AND p.app_id=NEW.app_id AND p.organization_id=NEW.organization_id AND p.user_id=owner.owner_id::text
      AND p.deleted_at IS NULL AND p.archived_after_move IS NULL) THEN RETURN NULL; END IF;
 SELECT count(*)::integer,min(o.expected_outputs),jsonb_agg(o.object_id::text ORDER BY o.output_index)
  INTO actual_count,expected,actual_ids
 FROM ai_video_preparation_outputs o JOIN storage_objects s ON s.id=o.object_id
 WHERE o.attempt_id=NEW.id AND o.preparation_id=NEW.preparation_id AND o.app_id=NEW.app_id
  AND o.organization_id=NEW.organization_id AND o.state='stored' AND o.deleted_at IS NULL AND o.archived_after_move IS NULL
  AND s.app_id=o.app_id AND s.organization_id::text=o.organization_id AND s.bucket=o.bucket AND s.key=o.object_key
  AND s.size_bytes=o.size_bytes AND s.content_type=o.content_type AND s.access_scope='prepared_video'
  AND s.access_subject IS NOT DISTINCT FROM o.end_user_sub AND NOT s.public AND s.published_at IS NULL AND s.archived_after_move IS NULL;
 IF actual_count=0 OR actual_count<>expected OR actual_ids IS DISTINCT FROM NEW.terminal_outcome->'outputObjectIds' THEN
  RAISE EXCEPTION 'completed attempt requires every retained output and matching storage metadata';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER video_attempts_retained_output BEFORE UPDATE ON ai_video_attempts
 FOR EACH ROW EXECUTE FUNCTION require_retained_video_output();

CREATE FUNCTION protect_prepared_storage_policy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.access_scope='prepared_video' AND
   ((NEW.access_scope,NEW.access_subject,NEW.app_id,NEW.organization_id,NEW.key,NEW.bucket)
     IS DISTINCT FROM (OLD.access_scope,OLD.access_subject,OLD.app_id,OLD.organization_id,OLD.key,OLD.bucket)
    OR (OLD.published_at IS NOT NULL AND NEW.published_at IS DISTINCT FROM OLD.published_at)) THEN
   RAISE EXCEPTION 'prepared storage access policy is immutable';
 END IF;
 IF NEW.access_scope='prepared_video' AND OLD.published_at IS NULL AND NEW.published_at IS NOT NULL
  AND NOT EXISTS(SELECT 1 FROM ai_video_preparation_outputs o
    JOIN ai_video_preparations p ON p.id=o.preparation_id JOIN ai_video_attempts a ON a.id=o.attempt_id
    WHERE o.object_id=NEW.id AND o.app_id=NEW.app_id AND o.organization_id=NEW.organization_id::text
      AND o.state='stored' AND o.deleted_at IS NULL AND o.archived_after_move IS NULL
      AND p.status='completed' AND p.deleted_at IS NULL AND p.archived_after_move IS NULL
      AND p.terminal_outcome->'outputObjectIds' ? NEW.id::text
      AND a.settlement_status='acknowledged' AND a.settlement_receipt->>'status'='settled') THEN
  RAISE EXCEPTION 'prepared output publication requires completed delivery and acknowledged settlement';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER storage_prepared_policy BEFORE UPDATE ON storage_objects FOR EACH ROW
 EXECUTE FUNCTION protect_prepared_storage_policy();

CREATE FUNCTION tombstone_prepared_storage_object() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner apps%ROWTYPE;
BEGIN
 IF EXISTS(SELECT 1 FROM ai_video_preparation_outputs WHERE object_id=OLD.id AND archived_after_move IS NULL) THEN
  BEGIN SELECT * INTO owner FROM apps WHERE id=OLD.app_id FOR UPDATE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN RETURN NULL; END;
 END IF;
 UPDATE ai_video_preparation_outputs SET state='cleanup_pending',deleted_at=COALESCE(deleted_at,now()),
  error_code='object_deleted',fence=fence+1,lease_owner=NULL,lease_expires_at=NULL,
  next_action_at=now(),updated_at=now()
 WHERE object_id=OLD.id AND app_id=OLD.app_id AND archived_after_move IS NULL AND state NOT IN ('cleanup_pending','deleted');
 RETURN OLD;
END $$;
CREATE TRIGGER storage_prepared_delete BEFORE DELETE ON storage_objects FOR EACH ROW
 EXECUTE FUNCTION tombstone_prepared_storage_object();

CREATE FUNCTION fence_app_video_output_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR (NEW.provisioning_status IN ('deleting','deprovisioning') AND NEW.provisioning_status IS DISTINCT FROM OLD.provisioning_status) THEN
  UPDATE ai_video_preparation_outputs SET state='cleanup_pending',deleted_at=COALESCE(deleted_at,now()),
   error_code='app_deleted',
   cleanup_not_before=GREATEST(cleanup_not_before,COALESCE(upload_uncertain_until,now())),
   uncertain_put=uncertain_put OR upload_uncertain_until IS NOT NULL,
   fence=fence+1,lease_owner=NULL,lease_expires_at=NULL,next_action_at=now(),updated_at=now()
  WHERE app_id=OLD.id AND archived_after_move IS NULL AND state<>'deleted';
 ELSIF NEW.provisioning_status='migrating' AND OLD.provisioning_status IS DISTINCT FROM NEW.provisioning_status THEN
  IF EXISTS(SELECT 1 FROM ai_video_preparation_outputs WHERE app_id=OLD.id AND archived_after_move IS NULL
    AND (state IN ('pending','copying','copied','cleanup_pending') OR (state='deleted' AND cleanup_probe_until>now()))) THEN
   RAISE EXCEPTION 'app has retained output work; drain before moving' USING ERRCODE='55000';
  END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER apps_video_output_lifecycle BEFORE DELETE OR UPDATE OF provisioning_status ON apps
 FOR EACH ROW EXECUTE FUNCTION fence_app_video_output_lifecycle();
COMMIT;
