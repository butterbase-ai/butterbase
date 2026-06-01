import type pg from 'pg';
import { encrypt, decrypt } from './crypto.js';

function getEncryptionKey(): string {
  const k = process.env.AUTH_ENCRYPTION_KEY;
  if (!k) throw new Error('AUTH_ENCRYPTION_KEY not set; cannot handle webhook secrets');
  return k;
}

export interface CloneWebhookConfig {
  app_id: string;
  webhook_url: string;
  /** Decrypted plaintext secret — for signing only; never expose to clients. */
  webhook_secret: string;
}

export async function upsertCloneWebhook(
  db: Pick<pg.Pool, 'query'>,
  appId: string,
  webhookUrl: string,
  webhookSecret: string,
): Promise<void> {
  const encrypted = encrypt(webhookSecret, getEncryptionKey());
  await db.query(
    `INSERT INTO app_clone_webhooks (app_id, webhook_url, webhook_secret_encrypted, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (app_id) DO UPDATE
       SET webhook_url = EXCLUDED.webhook_url,
           webhook_secret_encrypted = EXCLUDED.webhook_secret_encrypted,
           updated_at = now()`,
    [appId, webhookUrl, encrypted],
  );
}

export async function getCloneWebhook(
  db: Pick<pg.Pool, 'query'>,
  appId: string,
): Promise<CloneWebhookConfig | null> {
  const res = await db.query(
    `SELECT app_id, webhook_url, webhook_secret_encrypted
       FROM app_clone_webhooks
      WHERE app_id = $1`,
    [appId],
  );
  if (res.rows.length === 0) return null;
  const row = res.rows[0];
  return {
    app_id: row.app_id,
    webhook_url: row.webhook_url,
    webhook_secret: decrypt(row.webhook_secret_encrypted, getEncryptionKey()),
  };
}

export async function deleteCloneWebhook(
  db: Pick<pg.Pool, 'query'>,
  appId: string,
): Promise<void> {
  await db.query(
    `DELETE FROM app_clone_webhooks WHERE app_id = $1`,
    [appId],
  );
}

export async function enqueueWebhookDelivery(
  db: Pick<pg.Pool, 'query'>,
  payload: {
    appId: string;
    jobId: string;
    sourceAppId: string;
    destAppId: string | null;
    destRegion: string;
    completedAt: Date;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO clone_webhook_outbox
       (app_id, job_id, source_app_id, dest_app_id, dest_region, completed_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      payload.appId,
      payload.jobId,
      payload.sourceAppId,
      payload.destAppId,
      payload.destRegion,
      payload.completedAt,
    ],
  );
}
