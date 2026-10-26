// Test-only database boundary: keep the real logger and SQL argument assembly.
// The import map replaces postgres so no database connection can be opened.
export const queries: Array<{ sql: string; args: unknown[] }> = [];

export let queryHandler: ((sql: string, args: unknown[]) => { rows: unknown[]; rowCount: number }) | undefined;
export function setQueryHandler(handler: typeof queryHandler) { queryHandler = handler; }

export class PoolClient {
  async queryObject<T = Record<string, unknown>>(sql: string, args: unknown[] = []) {
    queries.push({ sql, args });
    const result = queryHandler?.(sql, args);
    return result ? { ...result, rows: result.rows as T[] } : { rows: [] as T[], rowCount: 0 };
  }

  release() {}
}

export class Pool {
  constructor(_url: string, _size: number) {}

  async connect(): Promise<PoolClient> {
    return new PoolClient();
  }
}
