import type pg from 'pg';
import { ulid } from 'ulidx';

export const DEFAULT_TTL_SECONDS = 30 * 24 * 3600;

export interface ResponseRow {
  id: string;
  createdAt: number;
  previousResponseId: string | null;
  model: string;
  inputMessages: unknown;
  output: unknown;
  usage: unknown;
  status: 'completed' | 'failed';
  expiresAt: number;
}

export function generateResponseId(): string {
  return `rsp_${ulid().toLowerCase()}`;
}

export async function insertResponseRow(pool: pg.Pool, row: ResponseRow): Promise<void> {
  await pool.query(
    `INSERT INTO ai_responses
       (id, created_at, previous_response_id, model, input_messages, output, usage, status, expires_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9)`,
    [
      row.id,
      row.createdAt,
      row.previousResponseId,
      row.model,
      JSON.stringify(row.inputMessages),
      JSON.stringify(row.output),
      JSON.stringify(row.usage),
      row.status,
      row.expiresAt,
    ],
  );
}

export async function loadResponseRow(pool: pg.Pool, id: string): Promise<ResponseRow | null> {
  const res = await pool.query(
    `SELECT id, created_at, previous_response_id, model, input_messages, output, usage, status, expires_at
       FROM ai_responses WHERE id = $1`,
    [id],
  );
  if (res.rowCount === 0) return null;
  const r = res.rows[0];
  return {
    id: r.id,
    createdAt: Number(r.created_at),
    previousResponseId: r.previous_response_id,
    model: r.model,
    inputMessages: r.input_messages,
    output: r.output,
    usage: r.usage,
    status: r.status,
    expiresAt: Number(r.expires_at),
  };
}
