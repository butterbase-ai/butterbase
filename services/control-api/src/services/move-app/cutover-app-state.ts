import type pg from 'pg';
import { withAppStateLocks } from '../app-state-lock.js';
import { ConflictError, NotFoundError } from '../api-errors.js';

interface CutoverContext {
  controlPool: Pick<pg.Pool, 'connect'>;
  runtimePoolFor(region: string): Pick<pg.Pool, 'query'>;
}

/** Long replication/copy work must finish before calling this. The destination
 * is prepared before the control transaction publishes it. A failed commit
 * leaves old routing intact; a committed retry never recopies the old home.
 */
export async function cutoverAppState(ctx: CutoverContext, appId: string, from: string, to: string): Promise<void> {
  await withAppStateLocks(ctx.controlPool, [appId], async ([ref], client) => {
    if (!ref) throw new NotFoundError('app', appId);
    if (ref.region === to) return;
    if (ref.region !== from) throw new ConflictError('App home changed during migration; reconcile before retrying.');
    const current = await ctx.runtimePoolFor(ref.region).query(
      `SELECT paused, paused_at, paused_reason, paused_by, last_active_at, idle_warned_at, idle_pause_notified_at, idle_reminded_at
         FROM apps WHERE id = $1`, [appId],
    );
    const state = current.rows[0];
    if (!state) throw new NotFoundError('app', appId);
    const dest = await ctx.runtimePoolFor(to).query(
      `UPDATE apps SET paused = $2, paused_at = $3, paused_reason = $4, paused_by = $5,
         last_active_at = $6, idle_warned_at = $7, idle_pause_notified_at = $8,
         idle_reminded_at = $9,
         region = $10, provisioning_status = 'ready', db_provisioned = true WHERE id = $1`,
      [appId, state.paused, state.paused_at, state.paused_reason, state.paused_by,
        state.last_active_at, state.idle_warned_at, state.idle_pause_notified_at, state.idle_reminded_at, to],
    );
    if (dest.rowCount === 0) throw new NotFoundError('destination app', appId);
    await client.query('UPDATE org_app_index SET region = $2, updated_at = now() WHERE app_id = $1', [appId,to]);
  });
}
