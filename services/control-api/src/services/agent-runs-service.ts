import type { Pool } from 'pg';

export type RunStatus =
  | 'queued' | 'running' | 'paused' | 'cancelling' | 'waiting_for_human'
  | 'completed' | 'failed' | 'cancelled' | 'timed_out';

export type CallerKind = 'end_user' | 'function' | 'dashboard';

export interface RunRow {
  id: string;
  app_id: string;
  agent_id: string;
  caller_kind: CallerKind;
  caller_user_id: string | null;
  caller_ip: string | null;
  status: RunStatus;
  input: unknown;
  output: unknown | null;
  error: unknown | null;
  webhook_url: string | null;
  idempotency_key: string | null;
  payload_hash: Buffer | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

const RUN_COLS = `id, app_id, agent_id, caller_kind, caller_user_id, caller_ip,
  status, input, output, error, webhook_url, idempotency_key, payload_hash,
  created_at, started_at, finished_at`;

export async function findRunByIdempotencyKey(
  db: Pool, appId: string, key: string,
): Promise<RunRow | null> {
  const r = await db.query(
    `SELECT ${RUN_COLS} FROM agent_runs WHERE app_id = $1 AND idempotency_key = $2`,
    [appId, key],
  );
  return r.rows[0] ?? null;
}

export async function createRun(
  db: Pool,
  appId: string,
  agentId: string,
  input: {
    caller_kind: CallerKind;
    caller_user_id?: string | null;
    caller_ip?: string | null;
    input: unknown;
    webhook_url?: string;
    idempotency_key?: string;
    payload_hash?: Buffer;
  },
): Promise<RunRow> {
  const r = await db.query(
    `INSERT INTO agent_runs
       (app_id, agent_id, caller_kind, caller_user_id, caller_ip,
        input, webhook_url, idempotency_key, payload_hash)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
     RETURNING ${RUN_COLS}`,
    [
      appId, agentId, input.caller_kind,
      input.caller_user_id ?? null,
      input.caller_ip ?? null,
      JSON.stringify(input.input),
      input.webhook_url ?? null,
      input.idempotency_key ?? null,
      input.payload_hash ?? null,
    ],
  );
  return r.rows[0];
}

export async function getRunById(
  db: Pool, appId: string, runId: string,
): Promise<RunRow | null> {
  const r = await db.query(
    `SELECT ${RUN_COLS} FROM agent_runs WHERE app_id = $1 AND id = $2`,
    [appId, runId],
  );
  return r.rows[0] ?? null;
}

export async function listRunsForAgent(
  db: Pool, appId: string, agentId: string, limit = 50,
): Promise<RunRow[]> {
  const r = await db.query(
    `SELECT ${RUN_COLS} FROM agent_runs
     WHERE app_id = $1 AND agent_id = $2
     ORDER BY created_at DESC LIMIT $3`,
    [appId, agentId, limit],
  );
  return r.rows;
}
