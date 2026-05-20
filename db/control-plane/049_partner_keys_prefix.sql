-- @scope: platform
-- 049: Store the first 10 characters of each partner key as a non-sensitive
-- preview so the admin UI can identify keys without decrypting them.
-- Existing rows have no plaintext available, so prefix stays NULL until rotated.

ALTER TABLE partner_keys
    ADD COLUMN IF NOT EXISTS key_prefix TEXT;
