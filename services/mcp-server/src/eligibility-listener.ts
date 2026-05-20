import pg from 'pg';
import { invalidateActiveWindow } from './active-window-cache.js';

/**
 * Listens for `hackathon_active_changed` Postgres NOTIFY and refreshes
 * the process-wide active-window cache.
 *
 * The `hackathon_participants_changed` channel is intentionally NOT
 * listened to: per-user eligibility is no longer cached here.
 */
export async function startActiveWindowListener(connectionString: string) {
  let client: pg.Client | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;

  const scheduleReconnect = () => {
    if (reconnectTimer) return;
    if (client) {
      try { void client.end(); } catch { /* ignore */ }
      client = null;
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, 1000);
  };

  const connect = async () => {
    try {
      const c = new pg.Client({ connectionString });
      client = c;
      c.on('notification', (msg) => {
        if (msg.channel === 'hackathon_active_changed') {
          void invalidateActiveWindow();
        }
      });
      c.on('error', (err) => {
        console.error('active-window listener error — reconnecting', err);
        scheduleReconnect();
      });
      c.on('end', () => {
        console.warn('active-window listener ended — reconnecting');
        scheduleReconnect();
      });
      await c.connect();
      await c.query('LISTEN hackathon_active_changed');
      console.log('active-window listener connected');
    } catch (err) {
      console.error('active-window listener connect failed — retrying', err);
      scheduleReconnect();
    }
  };

  await connect();
  return { stop: () => { if (reconnectTimer) clearTimeout(reconnectTimer); if (client) void client.end(); } };
}

// Keep the old export name as an alias so any callers that import it by the
// old name don't break until they're updated.
export { startActiveWindowListener as startEligibilityListener };
