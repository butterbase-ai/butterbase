-- @scope: platform
-- Fix the remaining FKs that block platform_users deletion.
--
-- Four tables track the user who deployed something via a nullable
-- `deployed_by UUID REFERENCES platform_users(id)` column with no ON DELETE
-- action specified — defaults to NO ACTION, which blocks DELETE FROM
-- platform_users with:
--   23503 update or delete on table "platform_users" violates foreign key
--   constraint "<table>_deployed_by_fkey" on table "<table>"
--
-- Switch all four to ON DELETE SET NULL. These are audit columns, not
-- ownership columns — the parent row belongs to an app, not the deployer,
-- and we want the deployment history to survive the deployer's account
-- deletion (NULL deployer = anonymized audit trail).
--
-- Idempotent: drops by name and recreates. Tables are typed differently
-- (apps.id is TEXT for app_deployments / app_functions / app_durable_objects /
-- app_edge_ssr_deployments) but deployed_by is uniformly UUID.

ALTER TABLE app_deployments
    DROP CONSTRAINT IF EXISTS app_deployments_deployed_by_fkey;
ALTER TABLE app_deployments
    ADD CONSTRAINT app_deployments_deployed_by_fkey
    FOREIGN KEY (deployed_by) REFERENCES platform_users(id) ON DELETE SET NULL;

ALTER TABLE app_functions
    DROP CONSTRAINT IF EXISTS app_functions_deployed_by_fkey;
ALTER TABLE app_functions
    ADD CONSTRAINT app_functions_deployed_by_fkey
    FOREIGN KEY (deployed_by) REFERENCES platform_users(id) ON DELETE SET NULL;

ALTER TABLE app_edge_ssr_deployments
    DROP CONSTRAINT IF EXISTS app_edge_ssr_deployments_deployed_by_fkey;
ALTER TABLE app_edge_ssr_deployments
    ADD CONSTRAINT app_edge_ssr_deployments_deployed_by_fkey
    FOREIGN KEY (deployed_by) REFERENCES platform_users(id) ON DELETE SET NULL;

ALTER TABLE app_durable_objects
    DROP CONSTRAINT IF EXISTS app_durable_objects_deployed_by_fkey;
ALTER TABLE app_durable_objects
    ADD CONSTRAINT app_durable_objects_deployed_by_fkey
    FOREIGN KEY (deployed_by) REFERENCES platform_users(id) ON DELETE SET NULL;
