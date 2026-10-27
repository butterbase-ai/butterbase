# Key Rotation Runbook

Covers `AUTH_ENCRYPTION_KEY` and `OPERATOR_CRED_KEY` — the two AES-256-GCM data-encryption keys used by control-api.

**Rule:** Do not rotate either key in production if the on-call engineer is unreachable. Both rotations require a coordinated secrets update + redeploy, and a rollback window.

---

## When to rotate

- Annually (SOC 2 CC6.1 key-management requirement)
- Suspected credential exposure (leaked env vars, former employee with secrets access)
- Routine security review finding

---

## What each key protects

### AUTH_ENCRYPTION_KEY

| Plane | Table | Column |
|-------|-------|--------|
| Control | `app_oauth_configs` | `client_secret_encrypted` |
| Control | `app_meetings_webhooks` | `forward_secret_encrypted` |
| Control | `app_integration_configs` | `credentials_encrypted` |
| Runtime (all regions) | `app_signing_keys` | `private_key_encrypted` |
| Runtime | `app_frontend_env_vars` | `encrypted_value` |
| Runtime | `app_env_vars` | `encrypted_env_vars` |
| Runtime | `app_functions` | `encrypted_env_vars` |
| Runtime | `apps` | `ai_config→byokKey` (JSONB field) |

Format: `base64(iv):base64(ciphertext):base64(authTag)` — AES-256-GCM, 12-byte IV, 16-byte tag.

### OPERATOR_CRED_KEY

| Plane | Table | Columns |
|-------|-------|---------|
| Control | `dashboard_agent_operator_credentials` | `ciphertext`, `iv`, `auth_tag` |

Each row also binds `organization_id` as GCM additional-authenticated data (AAD), preventing row-copy attacks. The rotation script preserves this binding.

---

## Prerequisites

- `tsx` available (`npm i -g tsx` or use `npx tsx`)
- Read/write access to the databases being rotated
- The current key values (from Fly secrets or your secrets manager)
- A maintenance window: rotation itself is fast (~seconds), but the subsequent redeploy takes ~3–4 minutes

---

## Generating a new key

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Store the output somewhere safe before proceeding. You'll need both the old and new values throughout the procedure.

---

## Rotating AUTH_ENCRYPTION_KEY

### Step 1 — Dry run (verify old key decrypts everything)

```bash
OLD_KEY=<current-64-hex> \
NEW_KEY=<new-64-hex> \
CONTROL_DB_URL=postgresql://... \
BUTTERBASE_REGIONS=us-east-1,eu-west-1 \
NEON_RUNTIME_PROJECT_ID_US_EAST_1=postgresql://... \
NEON_RUNTIME_PROJECT_ID_EU_WEST_1=postgresql://... \
  npx tsx scripts/rotate-auth-encryption-key.ts
```

Expected output: row counts per table, zero errors. If you see decrypt errors, stop — those rows have a different problem (corruption or were encrypted under a third key) that must be resolved first.

`OLD_KEY` defaults to the current `AUTH_ENCRYPTION_KEY` env var if not passed explicitly.

### Step 2 — Apply

Add `--fix` to the same command. All updates for each table run in a single transaction; a failure in any table rolls back that table's batch and exits non-zero.

```bash
OLD_KEY=<current-64-hex> \
NEW_KEY=<new-64-hex> \
... \
  npx tsx scripts/rotate-auth-encryption-key.ts --fix
```

### Step 3 — Update secrets and redeploy

```bash
# Fly.io — stage first, then deploy
fly secrets set AUTH_ENCRYPTION_KEY=<new-64-hex> --app butterbase-platform --stage
fly deploy --app butterbase-platform
```

Or trigger via GitHub Actions (the project's normal deploy path):

```bash
gh workflow run deploy.yml -f target=platform
```

### Step 4 — Verify

- Hit a route that decrypts data (e.g. load an app's env vars in the dashboard).
- Check control-api logs for any `decrypt` errors.
- Run the dry-run script again with `OLD_KEY=<new-key> NEW_KEY=<anything>` — it should report the same row counts and zero errors, confirming all rows are now encrypted under the new key.

### Rollback

If the deploy fails or decryption errors appear in production:

1. Re-run the rotation script with `OLD_KEY=<new-key> NEW_KEY=<old-key> --fix` to re-encrypt back.
2. Re-deploy with the old `AUTH_ENCRYPTION_KEY`.

Both operations are idempotent — the script handles already-rotated rows correctly because it re-encrypts every non-null value regardless.

---

## Rotating OPERATOR_CRED_KEY

### Step 1 — Dry run

```bash
OLD_KEY=<current-64-hex> \
NEW_KEY=<new-64-hex> \
CONTROL_DB_URL=postgresql://... \
  npx tsx scripts/rotate-operator-cred-key.ts
```

`OLD_KEY` defaults to `OPERATOR_CRED_KEY` if not passed.

### Step 2 — Apply

```bash
OLD_KEY=<current-64-hex> \
NEW_KEY=<new-64-hex> \
CONTROL_DB_URL=postgresql://... \
  npx tsx scripts/rotate-operator-cred-key.ts --fix
```

All rows in `dashboard_agent_operator_credentials` are updated in a single transaction.

### Step 3 — Update secrets and redeploy

```bash
fly secrets set OPERATOR_CRED_KEY=<new-64-hex> --app butterbase-platform --stage
fly deploy --app butterbase-platform
```

### Step 4 — Verify

Trigger an operator-agent turn for any org that has a credential — the dashboard-agent service will call `getOperatorCredential()` and will error loudly if the key is wrong.

### Rollback

Re-run with old and new keys swapped (`--fix`), then redeploy with the original `OPERATOR_CRED_KEY`.

---

## Local / staging rehearsal

Use the local Docker stack (`npm run e2e:bootstrap`) to rehearse without risk:

```bash
# 1. Seed a credential
OPERATOR_CRED_KEY=0000000000000000000000000000000000000000000000000000000000000001 \
CONTROL_DB_URL=postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control \
  npx tsx scripts/seed-operator-credential.ts <org-id> <service-key>

# 2. Generate a new key
NEW_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")

# 3. Dry run
OLD_KEY=0000000000000000000000000000000000000000000000000000000000000001 \
NEW_KEY=$NEW_KEY \
CONTROL_DB_URL=postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control \
  npx tsx scripts/rotate-operator-cred-key.ts

# 4. Apply
... --fix

# 5. Verify — should decrypt cleanly with new key
OPERATOR_CRED_KEY=$NEW_KEY \
CONTROL_DB_URL=postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control \
  npx tsx -e "
    import pg from 'pg';
    import { getOperatorCredential } from './services/control-api/src/services/dashboard-agent/operator-credential.js';
    const pool = new pg.Pool({ connectionString: process.env.CONTROL_DB_URL });
    console.log(await getOperatorCredential(pool, '<org-id>'));
    await pool.end();
  "
```

For `AUTH_ENCRYPTION_KEY`, point the rotation script at the local control DB and the local runtime DB URL. The local runtime DB defaults to `NEON_RUNTIME_PROJECT_ID_US_EAST_1` in the docker stack; check `SETUP.md` for the exact URL.

---

## Auditor notes

- Both keys are AES-256-GCM with 96-bit random IVs and 128-bit authentication tags (pinned — CWE-310 / OWASP-A02:2021).
- `OPERATOR_CRED_KEY` additionally binds `organization_id` as GCM AAD, preventing row-copy credential theft.
- Rotation scripts (`scripts/rotate-*.ts`) are the only supported path for re-keying; direct SQL updates to encrypted columns are not permitted (the application role's `UPDATE`/`DELETE` on `audit_events` is revoked as of migration 125/056; the same posture applies to these tables by convention).
- Rotation frequency target: annual, or immediately on suspected compromise.
