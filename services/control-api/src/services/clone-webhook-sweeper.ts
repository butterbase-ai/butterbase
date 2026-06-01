import { createHmac } from 'node:crypto';
import type pg from 'pg';
import { decrypt } from './crypto.js';

const BATCH_SIZE = 50;
const MAX_ATTEMPTS = 3;
const DELIVER_TIMEOUT_MS = 10_000;
const DEFAULT_INTERVAL_MS = 30_000;

/** Retry delay in milliseconds indexed by current attempt (0-based). */
const RETRY_DELAYS_MS = [30_000, 5 * 60_000, 30 * 60_000];

export interface SweeperLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

/**
 * Compute HMAC-SHA256 signature for a webhook body.
 * Returns a string in the format: `sha256=<hex>`.
 */
export function computeSignature(secret: string, body: string): string {
  const hex = createHmac('sha256', secret).update(body).digest('hex');
  return `sha256=${hex}`;
}

function getEncryptionKey(): string {
  const k = process.env.AUTH_ENCRYPTION_KEY;
  if (!k) throw new Error('AUTH_ENCRYPTION_KEY not set; cannot handle webhook secrets');
  return k;
}

interface OutboxRow {
  id: string;
  app_id: string;
  job_id: string;
  source_app_id: string;
  dest_app_id: string | null;
  dest_region: string;
  completed_at: Date;
  attempts: number;
}

interface WebhookConfigRow {
  app_id: string;
  webhook_url: string;
  webhook_secret_encrypted: string;
}

/**
 * Process one batch of pending outbox rows: fetch webhook config, sign and
 * deliver to the webhook URL, then mark delivered or schedule a retry.
 */
export async function runOnce(
  controlDb: Pick<pg.Pool, 'query'>,
  logger: SweeperLogger,
): Promise<void> {
  const pending = await controlDb.query<OutboxRow>(
    `SELECT id, app_id, job_id, source_app_id, dest_app_id, dest_region, completed_at, attempts
       FROM clone_webhook_outbox
      WHERE delivered_at IS NULL
        AND next_attempt_at <= now()
      ORDER BY next_attempt_at
      LIMIT $1`,
    [BATCH_SIZE],
  );

  if (pending.rows.length === 0) return;

  for (const row of pending.rows) {
    await processRow(controlDb, row, logger);
  }
}

async function processRow(
  controlDb: Pick<pg.Pool, 'query'>,
  row: OutboxRow,
  logger: SweeperLogger,
): Promise<void> {
  // Look up webhook config (may have been cleared since enqueue).
  const cfgResult = await controlDb.query<WebhookConfigRow>(
    `SELECT app_id, webhook_url, webhook_secret_encrypted
       FROM app_clone_webhooks
      WHERE app_id = $1`,
    [row.app_id],
  );

  if (cfgResult.rows.length === 0) {
    // Webhook cleared after enqueue — mark as delivered with a note.
    await controlDb.query(
      `UPDATE clone_webhook_outbox
          SET delivered_at = now(), last_error = 'webhook_cleared'
        WHERE id = $1`,
      [row.id],
    );
    return;
  }

  const cfg = cfgResult.rows[0];
  const secret = decrypt(cfg.webhook_secret_encrypted, getEncryptionKey());

  const payload = {
    event: 'clone_completed',
    job_id: row.job_id,
    source_app_id: row.source_app_id,
    dest_app_id: row.dest_app_id,
    dest_region: row.dest_region,
    completed_at: row.completed_at,
  };
  const body = JSON.stringify(payload);
  const sig = computeSignature(secret, body);

  let deliveryError: string | null = null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DELIVER_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(cfg.webhook_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Butterbase-Signature': sig,
          'X-Butterbase-Event': 'clone_completed',
        },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (response.ok) {
      // 2xx: mark delivered
      await controlDb.query(
        `UPDATE clone_webhook_outbox
            SET delivered_at = now(), attempts = $1
          WHERE id = $2`,
        [row.attempts + 1, row.id],
      );
      return;
    }

    deliveryError = `HTTP ${response.status}`;
  } catch (err) {
    deliveryError = err instanceof Error ? err.message : String(err);
  }

  // Delivery failed — retry or give up.
  const nextAttempts = row.attempts + 1;
  if (nextAttempts >= MAX_ATTEMPTS) {
    logger.warn(
      { outboxId: row.id, jobId: row.job_id, appId: row.app_id, attempts: nextAttempts, error: deliveryError },
      '[clone-webhook-sweeper] max attempts reached; giving up',
    );
    await controlDb.query(
      `UPDATE clone_webhook_outbox
          SET attempts = $1,
              last_error = $2
        WHERE id = $3`,
      [`max_attempts: ${deliveryError}`, nextAttempts, row.id],
    );
  } else {
    const delayMs = RETRY_DELAYS_MS[Math.min(row.attempts, RETRY_DELAYS_MS.length - 1)];
    const delaySeconds = Math.floor(delayMs / 1000);
    await controlDb.query(
      `UPDATE clone_webhook_outbox
          SET attempts = $1,
              last_error = $2,
              next_attempt_at = now() + interval '${delaySeconds} seconds'
        WHERE id = $3`,
      [nextAttempts, deliveryError, row.id],
    );
  }
}

/**
 * Start the clone-webhook sweeper background loop.
 * Returns a handle with `stop()` to gracefully halt the loop.
 */
export function startCloneWebhookSweeper(
  controlDb: Pick<pg.Pool, 'query'>,
  logger: SweeperLogger,
  intervalMs: number = DEFAULT_INTERVAL_MS,
): { stop(): Promise<void> } {
  let running = true;
  let currentTimer: ReturnType<typeof setTimeout> | null = null;
  let activeRun: Promise<void> | null = null;

  async function tick(): Promise<void> {
    if (!running) return;
    try {
      await runOnce(controlDb, logger);
    } catch (err) {
      logger.error({ err }, '[clone-webhook-sweeper] tick failed');
    } finally {
      if (running) {
        currentTimer = setTimeout(() => {
          activeRun = tick();
        }, intervalMs);
      }
    }
  }

  logger.info({ intervalMs }, '[clone-webhook-sweeper] started');
  activeRun = tick();

  return {
    async stop() {
      running = false;
      if (currentTimer !== null) clearTimeout(currentTimer);
      if (activeRun) await activeRun.catch(() => {});
      logger.info({}, '[clone-webhook-sweeper] stopped');
    },
  };
}
