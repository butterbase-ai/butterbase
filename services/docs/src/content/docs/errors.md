---
title: Error Reference
description: Complete catalog of Butterbase API error codes, what they mean, and how to resolve them.
---

Every Butterbase API error response follows the agent-friendly shape defined by `AgentFriendlyError`:

```json
{
  "error": {
    "code": "RESOURCE_NOT_FOUND",
    "message": "App \"my-app\" not found",
    "remediation": "Verify the app_id is correct. Use list_apps to see available apps.",
    "documentation_url": "https://docs.butterbase.ai/errors#resource-not-found",
    "details": { }
  }
}
```

The `documentation_url` field links to the matching anchor on this page. Codes are grouped by category below.

## Validation errors

These indicate that the request payload, schema, or input value is malformed or fails validation. They typically map to HTTP `400 Bad Request`.

### Validation Invalid Schema

**Code:** `VALIDATION_INVALID_SCHEMA`
**Status:** 400

The request body does not conform to the expected schema (missing required fields, wrong shape, or invalid combinations).

**Remediation:** Review the validation errors in the response `details` field and correct your input. Compare your payload against the API reference for the endpoint you called.

### Validation Missing Field

**Code:** `VALIDATION_MISSING_FIELD`
**Status:** 400

A required field was not provided in the request body.

**Remediation:** Add the missing field listed in `details`. Required fields are documented per endpoint in the API reference.

### Validation Invalid Type

**Code:** `VALIDATION_INVALID_TYPE`
**Status:** 400

A field was provided with the wrong JSON type (e.g. string where an array was expected, or a non-numeric value for a numeric column).

**Remediation:** Cast or rewrite the value to match the expected type. For database columns, the schema declares the column type — JSON columns require a JSON value (object/array), not a stringified literal.

### Validation Invalid Input

**Code:** `VALIDATION_INVALID_INPUT`
**Status:** 400

PostgreSQL rejected the value as malformed user input — invalid JSON, bad numeric or date format, value too long for the column, or out-of-range numeric value (SQLSTATE class 22).

**Remediation:** Check that each field matches its column type. JSON columns require a JSON value (object/array), not a stringified array literal; numeric/date columns require properly formatted values.

### Validation Column Not Found

**Code:** `VALIDATION_COLUMN_NOT_FOUND`
**Status:** 400

The request references a column that does not exist on the target table.

**Remediation:** Check the table's current schema with `manage_schema` (action `inspect`) and verify column names. Column names are case-sensitive.

### Validation Table Not Found

**Code:** `VALIDATION_TABLE_NOT_FOUND`
**Status:** 400

The request references a table that does not exist in the app's schema.

**Remediation:** List existing tables via `manage_schema` or the dashboard. Create the table first if it is missing, or correct the table name.

### Validation Invalid Name

**Code:** `VALIDATION_INVALID_NAME`
**Status:** 400

A name (table, column, app, function, etc.) violates Butterbase's naming rules — usually disallowed characters, reserved words, or length limits.

**Remediation:** Use lowercase letters, numbers, and underscores. Names must start with a letter and avoid SQL reserved words. See the schema design guide for the full ruleset.

### Validation Constraint Violation

**Code:** `VALIDATION_CONSTRAINT_VIOLATION`
**Status:** 400

A database constraint was violated, but the violation could not be classified into one of the more specific constraint codes below.

**Remediation:** Inspect `details.constraint_details` for the underlying constraint name and adjust the request payload accordingly.

### Validation Unique Constraint Violation

**Code:** `VALIDATION_UNIQUE_CONSTRAINT_VIOLATION`
**Status:** 409

The insert/update would create a duplicate value for a column with a unique constraint.

**Remediation:** This record already exists. Use a different value for the unique field, or update the existing record instead.

### Validation Foreign Key Violation

**Code:** `VALIDATION_FOREIGN_KEY_VIOLATION`
**Status:** 400

The value provided for a foreign-key column does not match any row in the referenced table.

**Remediation:** Ensure all foreign key references point to existing records. Insert the parent row first, or correct the reference to an existing row.

### Validation Check Constraint Violation

**Code:** `VALIDATION_CHECK_CONSTRAINT_VIOLATION`
**Status:** 400

A `CHECK` constraint declared on the table rejected the value (e.g. a numeric range, regex, or domain rule).

**Remediation:** Review the constraint definition (visible in the schema) and adjust your input to satisfy it.

### Validation Not Null Violation

**Code:** `VALIDATION_NOT_NULL_VIOLATION`
**Status:** 400

A non-nullable column was not provided in the request, and no default is configured.

**Remediation:** Provide a value for the column listed in `details.column`, or set a default in the schema (e.g. `"default": "gen_random_uuid()"` for uuid columns, `"default": "now()"` for timestamps) so it auto-populates on insert.

## Authentication & authorization errors

These indicate that the caller is not authenticated, lacks permission, or supplied an invalid token. They typically map to HTTP `401 Unauthorized` or `403 Forbidden`.

### Auth Required

**Code:** `AUTH_REQUIRED`
**Status:** 401

The endpoint requires authentication but no credentials were supplied.

**Remediation:** Send an `Authorization: Bearer <token>` header. Use a service key for server-to-server calls or an end-user JWT for user-scoped calls.

### Auth Invalid Token

**Code:** `AUTH_INVALID_TOKEN`
**Status:** 401

The bearer token is malformed, signed with the wrong key, or otherwise invalid.

**Remediation:** Verify the token is the one issued to your app and was not modified in transit. Generate a fresh token if needed.

### Auth Invalid API Key

**Code:** `AUTH_INVALID_API_KEY`
**Status:** 401

The supplied API key (e.g. `bb_sk_...`) does not match a known key for this app, or the key has been revoked.

**Remediation:** Check the key in your dashboard's API Keys page. Generate a new service key if the old one was rotated. Keys are app-scoped — using a key from one app against another's endpoint will fail.

### Auth Insufficient Permissions

**Code:** `AUTH_INSUFFICIENT_PERMISSIONS`
**Status:** 403

The caller is authenticated but does not have permission to perform this action (e.g. a publishable key being used for a service-only endpoint).

**Remediation:** Use credentials with the required scope. Service keys can do everything; publishable keys are limited to client-safe operations.

### Auth Invalid End User JWT

**Code:** `AUTH_INVALID_END_USER_JWT`
**Status:** 401

The end-user JWT is invalid, signed with the wrong key, or end-user authentication is not configured for this app.

**Remediation:** Verify the `Authorization: Bearer` token is a valid JWT issued for this app. If end-user auth has not been set up, configure OAuth or generate a signing key first via `configure_oauth_provider`.

### Auth End User JWT Expired

**Code:** `AUTH_END_USER_JWT_EXPIRED`
**Status:** 401

The end-user session token has expired.

**Remediation:** Sign in again or refresh your session to obtain a new end-user token, then retry the request.

### Auth RLS Requires User JWT

**Code:** `AUTH_RLS_REQUIRES_USER_JWT`
**Status:** 401

The table has Row-Level Security enabled and requires an authenticated end-user. The request was made with a service key or anonymous credentials.

**Remediation:** Send an end-user JWT in the `Authorization` header. Service keys bypass RLS only when explicitly configured; for user-scoped data access use the end-user token your auth flow issues.

### Auth RLS Policy Violation

**Code:** `AUTH_RLS_POLICY_VIOLATION`
**Status:** 403

The end-user is authenticated but RLS policies on the target table do not permit this row or operation.

**Remediation:** Verify the policy allows the action for this user. Use `manage_rls` to inspect policies, or see the [Row-Level Security guide](/core-concepts/row-level-security/) for debugging.

## Resource errors

These indicate that the target resource does not exist or is in a conflicting state.

### Resource Not Found

**Code:** `RESOURCE_NOT_FOUND`
**Status:** 404

The requested resource (app, function, deployment, file, row, etc.) does not exist or is not accessible to the caller.

**Remediation:** Verify the identifier. Use the corresponding `list_*` MCP tool (e.g. `list_apps`, `list_functions`) to enumerate available resources.

### App Not Found

**Code:** `APP_NOT_FOUND`
**Status:** 404

The `app_id` in the request does not match any app you can access.

**Remediation:** Run `list_apps` to see your apps, or check the dashboard for the correct ID. App IDs are short slugs, not UUIDs.

### Resource Already Exists

**Code:** `RESOURCE_ALREADY_EXISTS`
**Status:** 409

A resource with the supplied identifier already exists and creation was attempted again.

**Remediation:** Either use the existing resource, choose a different identifier, or update instead of create.

### Resource Conflict

**Code:** `RESOURCE_CONFLICT`
**Status:** 409

The operation cannot proceed because of a concurrent modification or an inconsistent target state.

**Remediation:** Re-fetch the resource to see its current state, then retry the operation with up-to-date inputs.

## Quota errors

These indicate plan limits or per-resource quotas have been reached. They typically map to HTTP `402 Payment Required` or `429 Too Many Requests`.

### Quota Storage Exceeded

**Code:** `QUOTA_STORAGE_EXCEEDED`
**Status:** 402

The app has used all of its allowed storage. Further uploads are rejected.

**Remediation:** Delete unused files or upgrade the app's plan. The current usage and limit are returned in the response details.

### Quota File Size Exceeded

**Code:** `QUOTA_FILE_SIZE_EXCEEDED`
**Status:** 413

A single file exceeds the per-file size limit configured for the app's storage bucket or plan.

**Remediation:** Split the file, compress it, or upgrade the plan to raise the per-file limit. The configured limit is included in the error message.

### Quota Storage Error

**Code:** `QUOTA_STORAGE_ERROR`
**Status:** 500

An internal error occurred while checking the storage quota.

**Remediation:** Retry the upload. If the error persists, contact support — this typically indicates a transient backend issue, not an actual quota breach.

### Quota Rate Limit

**Code:** `QUOTA_RATE_LIMIT`
**Status:** 429

The caller exceeded the request-rate limit for this endpoint or app.

**Remediation:** Back off and retry after the duration in the `Retry-After` header. Batch requests where possible to reduce request volume.

### Quota Table Limit

**Code:** `QUOTA_TABLE_LIMIT`
**Status:** 402

The app has reached the maximum number of tables permitted by its plan.

**Remediation:** Drop unused tables or upgrade the plan. Plan limits are listed on the [Billing & Plans](/core-concepts/billing/) page.

### Quota Deployment Limit

**Code:** `QUOTA_DEPLOYMENT_LIMIT`
**Status:** 402

The app has reached the maximum number of frontend or function deployments permitted by its plan.

**Remediation:** Delete inactive deployments via `delete_app` / `manage_edge_ssr` or upgrade the plan.

## State errors

These indicate that the resource exists but its current state does not allow the requested operation.

### State Invalid Transition

**Code:** `STATE_INVALID_TRANSITION`
**Status:** 409

The resource cannot move from its current state to the requested state (e.g. resuming an app that is not paused).

**Remediation:** Inspect the current state, then call the right transition. The error `details` typically includes the actual and expected state.

### State Prerequisite Missing

**Code:** `STATE_PREREQUISITE_MISSING`
**Status:** 409

A prerequisite resource or configuration is missing for the action (e.g. deploying a function before the app schema is initialized).

**Remediation:** Complete the prerequisite step listed in `remediation`, then retry.

### App Paused

**Code:** `APP_PAUSED`
**Status:** 423

The app is paused; data and runtime endpoints are unavailable until it is resumed.

**Remediation:** Call the unpause/resume action on the app, or reactivate it from the dashboard. Paused apps still incur storage but reject new traffic.

## Schema errors

### Schema Destructive Change

**Code:** `SCHEMA_DESTRUCTIVE_CHANGE`
**Status:** 400

The proposed schema migration would drop a column or table containing data, and was not explicitly confirmed.

**Remediation:** Re-run the migration with the destructive-change confirmation flag, or rewrite the migration as additive (e.g. add a new column instead of replacing one). Back up data before destructive changes.

### Schema Migration Failed

**Code:** `SCHEMA_MIGRATION_FAILED`
**Status:** 500

The schema migration was rejected by PostgreSQL during execution.

**Remediation:** Check the response `details` for the underlying SQL error. Common causes are NOT NULL backfills without a default, foreign keys to non-existent rows, or type changes that fail to cast existing data.

## RLS errors

### RLS Unsafe Expression

**Code:** `RLS_UNSAFE_EXPRESSION`
**Status:** 400

The submitted RLS policy expression contains a construct that is not allowed (e.g. mutating subqueries, disallowed functions, or unsafe casts).

**Remediation:** Rewrite the policy using the allowed expression grammar. See the [Row-Level Security guide](/core-concepts/row-level-security/) for permitted patterns.

## Realtime errors

### Realtime Not Configured

**Code:** `REALTIME_NOT_CONFIGURED`
**Status:** 400

Realtime has not been enabled for the app or for the specific table.

**Remediation:** Enable realtime via `manage_realtime` before subscribing. Realtime must be enabled per-table.

### Realtime Connection Limit

**Code:** `REALTIME_CONNECTION_LIMIT`
**Status:** 429

The app has reached the maximum number of concurrent realtime connections permitted by its plan.

**Remediation:** Close idle connections, share connections across clients, or upgrade the plan.

## Function errors

### Function Timeout

**Code:** `FUNCTION_TIMEOUT`
**Status:** 504

The serverless function exceeded its execution timeout.

**Remediation:** Optimize the function or move long-running work to a background job. Function timeouts are plan-dependent — see `core-concepts/functions` for limits.

## Integration errors

### Integrations Not Configured

**Code:** `INTEGRATIONS_NOT_CONFIGURED`
**Status:** 400

The integrations subsystem is not set up for this app.

**Remediation:** Run `configure_integration` to enable integrations, then connect the desired toolkit.

### Integrations Toolkit Not Enabled

**Code:** `INTEGRATIONS_TOOLKIT_NOT_ENABLED`
**Status:** 400

The named toolkit (e.g. `slack`, `github`) is not enabled for this app.

**Remediation:** Enable the toolkit via `configure_integration` before invoking its tools.

### Integrations Not Connected

**Code:** `INTEGRATIONS_NOT_CONNECTED`
**Status:** 400

The end-user does not have an active connected account for the requested toolkit.

**Remediation:** Run the OAuth flow for the user with `manage_oauth` to create a connected account, then retry the action.

### Integrations Connection Expired

**Code:** `INTEGRATIONS_CONNECTION_EXPIRED`
**Status:** 401

The user's connected-account credentials have expired and could not be refreshed.

**Remediation:** Re-run the OAuth consent flow for the user to mint a fresh connection.

### Integrations Execution Failed

**Code:** `INTEGRATIONS_EXECUTION_FAILED`
**Status:** 502

The downstream integration tool returned an error during execution.

**Remediation:** Inspect `details` for the upstream provider's error body. Common causes are invalid arguments, missing scopes, or rate limits at the provider.

### Integrations Quota Exceeded

**Code:** `INTEGRATIONS_QUOTA_EXCEEDED`
**Status:** 429

The integrations execution quota for this app or user has been exhausted.

**Remediation:** Wait for the quota window to reset, or upgrade the plan.

## External-system errors

These indicate that an upstream provider (S3, Cloudflare, the database, or a generic network call) returned an error.

### S3 Error

**Code:** `S3_ERROR`
**Status:** 502

The S3-compatible storage backend returned an unexpected error.

**Remediation:** Retry the request with backoff. If the error persists, contact support; this is a backend issue, not a client error.

### External S3 Error

**Code:** `EXTERNAL_S3_ERROR`
**Status:** 502

A request to the underlying object-storage provider failed (e.g. transient network error, signature mismatch, or provider-side outage).

**Remediation:** Retry with exponential backoff. If the failure recurs, capture the request ID from `details` and contact support.

### External DB Error

**Code:** `EXTERNAL_DB_ERROR`
**Status:** 502

The PostgreSQL backend returned an error that is not classified as a constraint or validation issue.

**Remediation:** Retry once. Persistent failures usually indicate a backend incident — check the status page or contact support.

### External Network Error

**Code:** `EXTERNAL_NETWORK_ERROR`
**Status:** 502

A network call to an upstream service failed (DNS, connection, or transport-level error).

**Remediation:** Retry with backoff. If the upstream service is one you provided (e.g. a webhook target), verify its availability and TLS configuration.

### External Cloudflare Error

**Code:** `EXTERNAL_CLOUDFLARE_ERROR`
**Status:** 502

A Cloudflare API call (Workers, Pages, R2, Durable Objects, etc.) returned an error.

**Remediation:** Inspect `details` for the Cloudflare error code. Some errors are transient and resolve on retry; others (e.g. account-limit errors) require dashboard or plan action.

## Internal errors

### Internal Error

**Code:** `INTERNAL_ERROR`
**Status:** 500

An unexpected error occurred inside Butterbase that does not match a more specific code.

**Remediation:** Retry the request. If the error reproduces, capture the response body (which includes a request identifier where available) and contact support.
