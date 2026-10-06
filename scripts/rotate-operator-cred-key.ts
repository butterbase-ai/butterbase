#!/usr/bin/env tsx
/**
 * Key rotation script for OPERATOR_CRED_KEY.
 *
 * Re-encrypts every row in dashboard_agent_operator_credentials using a new
 * AES-256-GCM key. Each row is decrypted with the old key (using the org ID
 * as GCM additional-authenticated data) and re-encrypted with the new key,
 * preserving the AAD binding.
 *
 * Usage
 * ─────
 *   OLD_KEY=<64-hex>  NEW_KEY=<64-hex> \
 *   CONTROL_DB_URL=postgresql://... \
 *     tsx scripts/rotate-operator-cred-key.ts          # dry-run
 *     tsx scripts/rotate-operator-cred-key.ts --fix    # apply
 *
 * OLD_KEY defaults to the current OPERATOR_CRED_KEY env var.
 * NEW_KEY must always be provided explicitly (no fallback).
 *
 * Safety notes
 * ────────────
 * - Dry-run (default) decrypts every row to confirm the old key is correct.
 *   Nothing is written.
 * - With --fix: all updates run inside a single transaction. Any error rolls
 *   back the entire batch so you're never left with a partially-rotated table.
 * - The AAD (org ID) is preserved during re-encryption, so the row-copy
 *   protection is maintained after rotation.
 * - After --fix, update OPERATOR_CRED_KEY in your secrets store and redeploy.
 */

import pg from 'pg';
import crypto from 'node:crypto';

// ─── CLI / env ───────────────────────────────────────────────────────────────

const FIX = process.argv.includes('--fix');

function parseArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function requireHex64(value: string | undefined, name: string): string {
  if (!value || !/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${name} must be a 64-character hex string (32 bytes)`);
  }
  return value;
}

const OLD_KEY = requireHex64(
  parseArg('--old-key') ?? process.env.OPERATOR_CRED_KEY,
  'OLD_KEY (--old-key or OPERATOR_CRED_KEY)',
);
const NEW_KEY = requireHex64(
  parseArg('--new-key') ?? process.env.OPERATOR_CRED_KEY_NEW,
  'NEW_KEY (--new-key or OPERATOR_CRED_KEY_NEW)',
);

if (OLD_KEY === NEW_KEY) {
  throw new Error('OLD_KEY and NEW_KEY are identical — nothing to rotate');
}

// ─── Crypto ──────────────────────────────────────────────────────────────────

const ALGORITHM = 'aes-256-gcm';
const AUTH_TAG_LENGTH = 16;

interface CredRow {
  organization_id: string;
  ciphertext: string;
  iv: string;
  auth_tag: string;
}

function decryptCred(row: CredRow, keyHex: string): string {
  const key = Buffer.from(keyHex, 'hex');
  const iv = Buffer.from(row.iv, 'base64');
  const authTag = Buffer.from(row.auth_tag, 'base64');
  const aad = Buffer.from(row.organization_id, 'utf8');

  if (authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error(`Invalid auth tag length: ${authTag.length} (expected ${AUTH_TAG_LENGTH})`);
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAAD(aad);
  decipher.setAuthTag(authTag);
  return Buffer.concat([
    decipher.update(Buffer.from(row.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function encryptCred(
  orgId: string,
  plaintext: string,
  keyHex: string,
): { ciphertext: string; iv: string; auth_tag: string } {
  const key = Buffer.from(keyHex, 'hex');
  const iv = crypto.randomBytes(12);
  const aad = Buffer.from(orgId, 'utf8');

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    auth_tag: authTag.toString('base64'),
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`mode: ${FIX ? 'APPLY' : 'dry-run (pass --fix to write)'}`);
  console.log(`old key: ${OLD_KEY.slice(0, 8)}…  new key: ${NEW_KEY.slice(0, 8)}…`);

  const controlUrl =
    process.env.CONTROL_DB_URL ?? 'postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control';

  const pool = new pg.Pool({ connectionString: controlUrl });

  try {
    const rows = await pool
      .query<CredRow>('SELECT organization_id, ciphertext, iv, auth_tag FROM dashboard_agent_operator_credentials')
      .then(r => r.rows);

    console.log(`\n[dashboard_agent_operator_credentials] ${rows.length} row(s)`);

    if (rows.length === 0) {
      console.log('nothing to rotate');
      return;
    }

    // Decrypt every row with the old key to validate before writing anything
    const reencrypted: { orgId: string; newCt: ReturnType<typeof encryptCred> }[] = [];
    let errors = 0;

    for (const row of rows) {
      try {
        const plaintext = decryptCred(row, OLD_KEY);
        const newCt = encryptCred(row.organization_id, plaintext, NEW_KEY);
        reencrypted.push({ orgId: row.organization_id, newCt });
      } catch (err) {
        console.error(`  [error] org=${row.organization_id}: ${(err as Error).message}`);
        errors++;
      }
    }

    console.log(`  verified: ${reencrypted.length} ok, ${errors} error(s)`);

    if (errors > 0) {
      console.error('Aborting — fix decrypt errors before rotating');
      process.exit(1);
    }

    if (!FIX) {
      console.log('\ndry-run complete — no errors. Run with --fix to apply.');
      return;
    }

    // All rows decrypted cleanly — write atomically
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const { orgId, newCt } of reencrypted) {
        await client.query(
          `UPDATE dashboard_agent_operator_credentials
              SET ciphertext = $1, iv = $2, auth_tag = $3
            WHERE organization_id = $4`,
          [newCt.ciphertext, newCt.iv, newCt.auth_tag, orgId],
        );
      }
      await client.query('COMMIT');
      console.log(`  committed ${reencrypted.length} updates`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`ROLLBACK — ${(err as Error).message}`);
      process.exit(1);
    } finally {
      client.release();
    }

    console.log('\nrotation complete. Next: set OPERATOR_CRED_KEY=<new-key> in secrets and redeploy.');
  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
