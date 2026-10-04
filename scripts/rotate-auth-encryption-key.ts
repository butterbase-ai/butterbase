#!/usr/bin/env tsx
/**
 * Key rotation script for AUTH_ENCRYPTION_KEY.
 *
 * Re-encrypts every AES-256-GCM ciphertext stored under the current key with
 * a new key. Run in dry-run mode first (default), then with --fix once you've
 * verified the row counts look right.
 *
 * Covered columns
 * ───────────────
 * Control-plane (CONTROL_DB_URL):
 *   app_oauth_configs.client_secret_encrypted          (nullable)
 *   app_meetings_webhooks.forward_secret_encrypted
 *   app_integration_configs.credentials_encrypted      (nullable)
 *
 * Runtime-plane (one pool per region, NEON_RUNTIME_PROJECT_ID_<REGION>):
 *   app_signing_keys.private_key_encrypted
 *   app_frontend_env_vars.encrypted_value
 *   app_env_vars.encrypted_env_vars
 *   app_functions.encrypted_env_vars                   (nullable)
 *   apps.ai_config                                     (JSONB → byokKey field)
 *
 * Usage
 * ─────
 *   OLD_KEY=<64-hex>  NEW_KEY=<64-hex> \
 *   CONTROL_DB_URL=postgresql://... \
 *   BUTTERBASE_REGIONS=us-east-1,eu-west-1 \
 *   NEON_RUNTIME_PROJECT_ID_US_EAST_1=postgresql://... \
 *   NEON_RUNTIME_PROJECT_ID_EU_WEST_1=postgresql://... \
 *     tsx scripts/rotate-auth-encryption-key.ts          # dry-run
 *     tsx scripts/rotate-auth-encryption-key.ts --fix    # apply
 *
 * OLD_KEY defaults to the current AUTH_ENCRYPTION_KEY env var.
 * NEW_KEY must always be passed explicitly (no default) to prevent accidents.
 *
 * Safety notes
 * ────────────
 * - Dry-run (default) reads and decrypts every row to verify the old key is
 *   correct, then reports what would be re-encrypted. Nothing is written.
 * - With --fix: re-encryption of each table runs inside a single transaction
 *   that is rolled back on any error in that table's batch.
 * - The script exits non-zero if any row fails to decrypt (wrong key, corrupt
 *   ciphertext). Fix those rows before rotating.
 * - After --fix completes, update AUTH_ENCRYPTION_KEY in your secrets store
 *   and redeploy. The old key can be retired once all services are running the
 *   new key and a successful health-check confirms decryption works.
 */

import pg from 'pg';
import crypto from 'node:crypto';

// ─── CLI / env ──────────────────────────────────────────────────────────────

const FIX = process.argv.includes('--fix');

function requireHex64(value: string | undefined, name: string): string {
  if (!value || !/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${name} must be a 64-character hex string (32 bytes)`);
  }
  return value;
}

const OLD_KEY = requireHex64(
  parseArg('--old-key') ?? process.env.AUTH_ENCRYPTION_KEY,
  'OLD_KEY (--old-key or AUTH_ENCRYPTION_KEY)',
);
const NEW_KEY = requireHex64(
  parseArg('--new-key') ?? process.env.AUTH_ENCRYPTION_KEY_NEW,
  'NEW_KEY (--new-key or AUTH_ENCRYPTION_KEY_NEW)',
);

if (OLD_KEY === NEW_KEY) {
  throw new Error('OLD_KEY and NEW_KEY are identical — nothing to rotate');
}

function parseArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

// ─── Crypto helpers ──────────────────────────────────────────────────────────

const GCM_AUTH_TAG_BYTES = 16;

function reencrypt(ciphertext: string, oldKeyHex: string, newKeyHex: string): string {
  // Decrypt with old key
  const [ivB64, ctB64, tagB64] = ciphertext.split(':');
  if (!ivB64 || !ctB64 || !tagB64) {
    throw new Error(`Ciphertext is not in iv:ciphertext:authTag format: ${ciphertext.slice(0, 40)}…`);
  }
  const oldKey = Buffer.from(oldKeyHex, 'hex');
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(tagB64, 'base64');
  if (authTag.length !== GCM_AUTH_TAG_BYTES) {
    throw new Error(`Invalid auth tag length: ${authTag.length}`);
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', oldKey, iv, {
    authTagLength: GCM_AUTH_TAG_BYTES,
  });
  decipher.setAuthTag(authTag);
  const plaintext = decipher.update(Buffer.from(ctB64, 'base64'), undefined, 'utf8') + decipher.final('utf8');

  // Re-encrypt with new key
  const newKey = Buffer.from(newKeyHex, 'hex');
  const newIv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', newKey, newIv, {
    authTagLength: GCM_AUTH_TAG_BYTES,
  });
  let encrypted = cipher.update(plaintext, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  const newTag = cipher.getAuthTag().toString('base64');
  return `${newIv.toString('base64')}:${encrypted}:${newTag}`;
}

// ─── Generic column re-encryptor ─────────────────────────────────────────────

interface ReencryptResult {
  total: number;
  skipped: number; // null / already-skipped
  errors: number;
}

/**
 * Re-encrypts a single `iv:ct:tag` column across all rows in a table.
 * `pkCol` is the primary-key column used for row-by-row updates.
 * Nullable columns skip NULL rows silently.
 */
async function reencryptColumn(
  pool: pg.Pool,
  label: string,
  table: string,
  column: string,
  pkCol: string,
  oldKey: string,
  newKey: string,
  fix: boolean,
): Promise<ReencryptResult> {
  const result: ReencryptResult = { total: 0, skipped: 0, errors: 0 };

  const rows = await pool
    .query<Record<string, string>>(`SELECT "${pkCol}", "${column}" FROM "${table}"`)
    .then(r => r.rows);

  const updates: { pk: string; newValue: string }[] = [];

  for (const row of rows) {
    const value: string | null = row[column];
    if (value == null) {
      result.skipped++;
      continue;
    }
    result.total++;
    try {
      updates.push({ pk: row[pkCol], newValue: reencrypt(value, oldKey, newKey) });
    } catch (err) {
      console.error(`  [error] ${label} pk=${row[pkCol]}: ${(err as Error).message}`);
      result.errors++;
    }
  }

  console.log(
    `  ${label}: ${result.total} rows to re-encrypt, ${result.skipped} null-skipped` +
      (result.errors ? `, ${result.errors} ERRORS` : ''),
  );

  if (!fix || updates.length === 0) return result;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const { pk, newValue } of updates) {
      await client.query(`UPDATE "${table}" SET "${column}" = $1 WHERE "${pkCol}" = $2`, [newValue, pk]);
    }
    await client.query('COMMIT');
    console.log(`  ${label}: committed ${updates.length} updates`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`  ${label}: ROLLBACK — ${(err as Error).message}`);
    result.errors++;
  } finally {
    client.release();
  }

  return result;
}

/**
 * Re-encrypts a JSONB column's nested string field (e.g. apps.ai_config → byokKey).
 */
async function reencryptJsonbField(
  pool: pg.Pool,
  label: string,
  table: string,
  pkCol: string,
  jsonbCol: string,
  field: string,
  oldKey: string,
  newKey: string,
  fix: boolean,
): Promise<ReencryptResult> {
  const result: ReencryptResult = { total: 0, skipped: 0, errors: 0 };

  const rows = await pool
    .query<Record<string, string>>(
      `SELECT "${pkCol}", "${jsonbCol}" FROM "${table}" WHERE "${jsonbCol}" ->> $1 IS NOT NULL`,
      [field],
    )
    .then(r => r.rows);

  const updates: { pk: string; newConfig: unknown }[] = [];

  for (const row of rows) {
    result.total++;
    try {
      const config = typeof row[jsonbCol] === 'string' ? JSON.parse(row[jsonbCol]) : row[jsonbCol];
      const newFieldValue = reencrypt(config[field] as string, oldKey, newKey);
      updates.push({ pk: row[pkCol], newConfig: { ...config, [field]: newFieldValue } });
    } catch (err) {
      console.error(`  [error] ${label} pk=${row[pkCol]}: ${(err as Error).message}`);
      result.errors++;
    }
  }

  console.log(`  ${label}: ${result.total} rows to re-encrypt` + (result.errors ? `, ${result.errors} ERRORS` : ''));

  if (!fix || updates.length === 0) return result;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const { pk, newConfig } of updates) {
      await client.query(`UPDATE "${table}" SET "${jsonbCol}" = $1 WHERE "${pkCol}" = $2`, [
        JSON.stringify(newConfig),
        pk,
      ]);
    }
    await client.query('COMMIT');
    console.log(`  ${label}: committed ${updates.length} updates`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`  ${label}: ROLLBACK — ${(err as Error).message}`);
    result.errors++;
  } finally {
    client.release();
  }

  return result;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function processControlPlane(controlUrl: string): Promise<number> {
  const pool = new pg.Pool({ connectionString: controlUrl });
  console.log('\n[control-plane]');
  let errors = 0;
  try {
    const tasks = [
      reencryptColumn(pool, 'app_oauth_configs.client_secret_encrypted', 'app_oauth_configs', 'client_secret_encrypted', 'id', OLD_KEY, NEW_KEY, FIX),
      reencryptColumn(pool, 'app_meetings_webhooks.forward_secret_encrypted', 'app_meetings_webhooks', 'forward_secret_encrypted', 'app_id', OLD_KEY, NEW_KEY, FIX),
      reencryptColumn(pool, 'app_integration_configs.credentials_encrypted', 'app_integration_configs', 'credentials_encrypted', 'id', OLD_KEY, NEW_KEY, FIX),
    ];
    const results = await Promise.all(tasks);
    errors = results.reduce((sum, r) => sum + r.errors, 0);
  } finally {
    await pool.end();
  }
  return errors;
}

async function processRuntimeRegion(region: string, url: string): Promise<number> {
  const pool = new pg.Pool({ connectionString: url });
  console.log(`\n[runtime:${region}]`);
  let errors = 0;
  try {
    // Run sequentially — large tables benefit from serial writes to avoid lock contention
    const results = await Promise.all([
      reencryptColumn(pool, 'app_signing_keys.private_key_encrypted', 'app_signing_keys', 'private_key_encrypted', 'id', OLD_KEY, NEW_KEY, FIX),
      reencryptColumn(pool, 'app_frontend_env_vars.encrypted_value', 'app_frontend_env_vars', 'encrypted_value', 'app_id', OLD_KEY, NEW_KEY, FIX),
      reencryptColumn(pool, 'app_env_vars.encrypted_env_vars', 'app_env_vars', 'encrypted_env_vars', 'app_id', OLD_KEY, NEW_KEY, FIX),
      reencryptColumn(pool, 'app_functions.encrypted_env_vars', 'app_functions', 'encrypted_env_vars', 'id', OLD_KEY, NEW_KEY, FIX),
      reencryptJsonbField(pool, 'apps.ai_config→byokKey', 'apps', 'id', 'ai_config', 'byokKey', OLD_KEY, NEW_KEY, FIX),
    ]);
    errors = results.reduce((sum, r) => sum + r.errors, 0);
  } finally {
    await pool.end();
  }
  return errors;
}

async function main(): Promise<void> {
  console.log(`mode: ${FIX ? 'APPLY' : 'dry-run (pass --fix to write)'}`);
  console.log(`old key: ${OLD_KEY.slice(0, 8)}…  new key: ${NEW_KEY.slice(0, 8)}…`);

  const controlUrl =
    process.env.CONTROL_DB_URL ?? 'postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control';

  const regions = (process.env.BUTTERBASE_REGIONS ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  if (regions.length === 0) {
    console.warn('BUTTERBASE_REGIONS is empty — skipping runtime-plane tables');
  }

  let totalErrors = 0;
  totalErrors += await processControlPlane(controlUrl);

  for (const region of regions) {
    const urlVar = `NEON_RUNTIME_PROJECT_ID_${region.toUpperCase().replace(/-/g, '_')}`;
    const url = process.env[urlVar];
    if (!url) {
      console.warn(`[${region}] no ${urlVar}; skipping`);
      continue;
    }
    totalErrors += await processRuntimeRegion(region, url);
  }

  console.log(`\n─── summary ───`);
  if (totalErrors > 0) {
    console.error(`${totalErrors} error(s) encountered — fix them before deploying the new key`);
    process.exit(1);
  } else if (!FIX) {
    console.log('dry-run complete — no errors. Run with --fix to apply.');
  } else {
    console.log('rotation complete. Next: set AUTH_ENCRYPTION_KEY=<new-key> in secrets and redeploy.');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
