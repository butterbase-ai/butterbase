// services/control-api/src/services/webhook-handler.ts
import { Pool, PoolClient } from 'pg';

export type WebhookSource = 'stripe' | 'cloudflare';

export class WebhookError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message);
    this.name = 'WebhookError';
  }
}

/**
 * Generic webhook handler with idempotency and transaction support
 *
 * Pattern:
 * 1. Begin transaction
 * 2. Check if event already processed (idempotency)
 * 3. Record event as processed
 * 4. Execute handler logic
 * 5. Commit transaction
 *
 * If any step fails, rollback transaction
 */
export async function handleWebhook(
  db: Pool,
  source: WebhookSource,
  eventId: string,
  eventType: string,
  handler: (client: PoolClient) => Promise<void>
): Promise<void> {
  if (!eventId || typeof eventId !== 'string') {
    throw new WebhookError('Invalid event ID', 'INVALID_EVENT_ID');
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Idempotency check: skip if already processed
    const existing = await client.query(
      'SELECT 1 FROM processed_webhook_events WHERE source = $1 AND event_id = $2',
      [source, eventId]
    );

    if (existing.rows.length > 0) {
      await client.query('COMMIT');
      console.log(`[Webhook] Event ${eventId} from ${source} already processed, skipping`);
      return;
    }

    // Record event as processed
    await client.query(
      'INSERT INTO processed_webhook_events (source, event_id, event_type) VALUES ($1, $2, $3)',
      [source, eventId, eventType]
    );

    // Execute handler logic
    await handler(client);

    await client.query('COMMIT');
    console.log(`[Webhook] Successfully processed event ${eventId} from ${source}`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw new WebhookError(
      `Failed to process webhook: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'WEBHOOK_PROCESSING_FAILED'
    );
  } finally {
    client.release();
  }
}
