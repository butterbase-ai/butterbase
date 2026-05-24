-- @scope: platform
-- 079_cloudflare_deployment_index.sql
-- Routing table so the Cloudflare deployment webhook can resolve a
-- cloudflare_deployment_id back to (app_id, region) without touching
-- app_deployments. app_deployments was moved to per-region runtime DBs;
-- the webhook arrives on controlDb and needs to learn the region to
-- forward the rest of its work to the right runtime pool.
--
-- Writers (deployment.service.ts) will INSERT a row immediately after
-- they learn the Cloudflare deployment_id from a successful deploy.
-- The webhook handler will SELECT this row to resolve routing.
--
-- Backfill from any existing controlDb app_deployments rows that still
-- carry a cloudflare_deployment_id, joining user_app_index for region.

CREATE TABLE IF NOT EXISTS cloudflare_deployment_index (
  cloudflare_deployment_id TEXT PRIMARY KEY,
  app_id                   TEXT NOT NULL,
  region                   TEXT NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cloudflare_deployment_index_app_id
  ON cloudflare_deployment_index (app_id);

INSERT INTO cloudflare_deployment_index (cloudflare_deployment_id, app_id, region, created_at)
SELECT ad.cloudflare_deployment_id,
       ad.app_id,
       COALESCE(uai.region, 'us-east-1') AS region,
       ad.created_at
  FROM app_deployments ad
  LEFT JOIN user_app_index uai ON uai.app_id = ad.app_id
 WHERE ad.cloudflare_deployment_id IS NOT NULL
ON CONFLICT (cloudflare_deployment_id) DO NOTHING;

COMMENT ON TABLE cloudflare_deployment_index IS
  'controlDb routing table: cloudflare_deployment_id -> (app_id, region). Read by the Cloudflare webhook handler to forward to the regional runtime DB.';
