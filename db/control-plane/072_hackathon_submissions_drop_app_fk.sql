-- 072_hackathon_submissions_drop_app_fk.sql
--
-- Post OSS-split the control-plane `apps` table only mirrors a subset of all
-- apps; the cross-region authoritative catalog is `user_app_index`. The
-- hackathon submit handler now auto-resolves app_id from a butterbase.dev URL
-- via user_app_index, which can yield an app_id that exists in the catalog
-- but not in the legacy `apps` mirror. The existing FK on
-- hackathon_submissions.app_id → apps(id) would reject those rows, so drop it.
-- We keep the column (TEXT, nullable) so existing readers continue to work.

ALTER TABLE hackathon_submissions
    DROP CONSTRAINT IF EXISTS hackathon_submissions_app_id_fkey;
