-- @scope: runtime
-- Phase 2: per-function impersonation gate.
--
-- Lets a service-key caller assert "act on behalf of user X" via the
-- `X-Butterbase-As-User` header. The runtime sets `ctx.user.id` to the
-- impersonated id BEFORE invoking the function. This replaces the
-- bearer-equality anti-pattern (`req.headers.authorization === Bearer
-- ctx.env.BUTTERBASE_API_KEY`) which broke under per-function key minting
-- and any future key rotation.
--
-- Default TRUE preserves existing behavior: legacy templates that already
-- implicitly trusted any app-scoped service key with an as-user assertion
-- (the equality-check pattern was trying to express exactly this) keep
-- working without changes. Functions that should never accept impersonation
-- (admin-only mutators, billing webhooks, etc.) flip the flag to FALSE at
-- deploy time via the new `allowServiceKeyImpersonation` deploy parameter
-- or `manage_function` update action.
--
-- Enforcement lives in control-api/routes/auto-api.ts: when an as-user
-- header is present and the caller is an app-scoped service key, the route
-- looks up this flag on the target function and 403s if FALSE before
-- forwarding to the runtime. The flag is loaded by function-loader and
-- cached alongside the function code, so the hot path stays one DB hit.

ALTER TABLE public.app_functions
  ADD COLUMN IF NOT EXISTS allow_service_key_impersonation BOOLEAN NOT NULL DEFAULT true;
