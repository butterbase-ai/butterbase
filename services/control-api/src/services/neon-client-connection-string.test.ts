import { describe, it, expect, vi, afterEach } from 'vitest';
import { getConnectionString } from './neon-client.js';

/**
 * Regression guard for the obsolete `:6543` pooler port.
 *
 * A live probe against the Neon API returns the pooled host as
 * `ep-<id>-pooler.<region>.aws.neon.tech` with NO explicit port (default
 * 5432). `getConnectionString` used to inject `url.port = '6543'` when it
 * built the pooled URI from a cached pooler host, producing an unusable
 * connection string in `app_db_connections.pooler_connection_string`.
 */

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const DIRECT_URI =
  'postgresql://butterbase:pw@ep-still-frost-12345678.us-east-1.aws.neon.tech/db_app_k3f9x2m1qp0z?sslmode=require';
const POOLER_HOST = 'ep-still-frost-12345678-pooler.us-east-1.aws.neon.tech';

describe('getConnectionString pooled URI construction', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('builds the pooled URI by swapping the host only — never injects :6543', async () => {
    // Neon hands back the pooler host inline, so the construct branch runs and
    // the second (pooled=true) request is skipped.
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        uri: DIRECT_URI,
        connection_parameters: { pooler_host: POOLER_HOST },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    // Fresh project id per run so the module-level poolerHostCache can't
    // leak state between tests.
    const projectId = `proj-construct-${Math.random().toString(36).slice(2)}`;
    const res = await getConnectionString(projectId, 'db_app_k3f9x2m1qp0z', 'butterbase');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.connectionUri).toBe(DIRECT_URI);
    expect(res.poolerHost).toBe(POOLER_HOST);
    expect(res.pooledConnectionUri).toBe(
      'postgresql://butterbase:pw@ep-still-frost-12345678-pooler.us-east-1.aws.neon.tech/db_app_k3f9x2m1qp0z?sslmode=require',
    );
    expect(res.pooledConnectionUri).not.toContain('6543');
    expect(new URL(res.pooledConnectionUri!).port).toBe('');
  });

  it('reuses the cached pooler host on a later call and still emits no port', async () => {
    const projectId = `proj-cache-${Math.random().toString(36).slice(2)}`;

    // 1st call: no pooler_host inline → falls through to the pooled=true
    // endpoint, whose URI (port-free, as the real API returns) is used
    // verbatim and seeds the cache.
    const first = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ uri: DIRECT_URI }))
      .mockResolvedValueOnce(
        jsonResponse({
          uri: `postgresql://butterbase:pw@${POOLER_HOST}/db_app_k3f9x2m1qp0z?sslmode=require`,
        }),
      );
    vi.stubGlobal('fetch', first);
    const seeded = await getConnectionString(projectId, 'db_app_k3f9x2m1qp0z', 'butterbase');
    expect(seeded.pooledConnectionUri).not.toContain('6543');
    expect(first).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();

    // 2nd call for another database on the same project: cache hit → the
    // construct branch, which is the one that used to append :6543.
    const second = vi.fn().mockResolvedValue(
      jsonResponse({
        uri: 'postgresql://butterbase:pw@ep-still-frost-12345678.us-east-1.aws.neon.tech/cust_app_k3f9x2m1qp0z_us_west_2?sslmode=require',
      }),
    );
    vi.stubGlobal('fetch', second);
    const res = await getConnectionString(projectId, 'cust_app_k3f9x2m1qp0z_us_west_2', 'butterbase');

    expect(second).toHaveBeenCalledTimes(1);
    expect(res.pooledConnectionUri).toBe(
      `postgresql://butterbase:pw@${POOLER_HOST}/cust_app_k3f9x2m1qp0z_us_west_2?sslmode=require`,
    );
    expect(res.pooledConnectionUri).not.toContain('6543');
    expect(new URL(res.pooledConnectionUri!).port).toBe('');
  });
});
