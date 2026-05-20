import pg from 'pg';

export interface PromoteParams {
  apiKey: string;
  projectId: string;
}

const NEON_API_BASE = 'https://console.neon.tech/api/v2';

export async function promoteReplicaToPrimary(params: PromoteParams): Promise<void> {
  if (!params.apiKey) throw new Error('NEON_API_KEY is empty');
  if (!params.projectId) throw new Error('projectId is empty');

  const res = await fetch(`${NEON_API_BASE}/projects/${params.projectId}/promote`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Neon promotion failed (${res.status}): ${body}`);
  }
}

export async function getReplicationLagSeconds(
  standbyUrl: string,
  injectedClient?: pg.Client
): Promise<number | null> {
  const client =
    injectedClient ?? new pg.Client({ connectionString: standbyUrl, connectionTimeoutMillis: 5000 });
  if (!injectedClient) await client.connect();
  try {
    const res = await client.query<{ lag_seconds: string | number | null }>(
      `SELECT EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp())) AS lag_seconds`
    );
    const raw = res.rows[0]?.lag_seconds;
    return raw === null || raw === undefined ? null : Number(raw);
  } finally {
    if (!injectedClient) await client.end();
  }
}
