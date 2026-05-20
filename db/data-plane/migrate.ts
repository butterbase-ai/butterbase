import { promises as fs } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

export class MigrationScopeError extends Error {
  constructor(file: string, foundScope: string | null) {
    super(`Migration ${file} has scope "${foundScope ?? '<none>'}", expected "data"`);
  }
}

export interface DataMigration {
  file: string;
  sql: string;
}

export async function resolveDataMigrations(dir: string): Promise<DataMigration[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const files = entries.filter((f) => f.endsWith('.sql')).sort();
  const out: DataMigration[] = [];
  for (const f of files) {
    const sql = await fs.readFile(path.join(dir, f), 'utf8');
    const match = sql.match(/^\s*--\s*@scope:\s*(\w+)/m);
    const scope = match?.[1] ?? null;
    if (scope !== 'data') throw new MigrationScopeError(f, scope);
    out.push({ file: f, sql });
  }
  return out;
}

interface ApplyArgs {
  regions: string[];
  dataProjectIdsByRegion: Record<string, string>;
  /** Resolves per-region data-DB connection strings to per-app DB URLs. */
  listAppDbsForRegion: (region: string) => Promise<Array<{ appId: string; url: string }>>;
}

export async function applyDataMigrations(args: ApplyArgs, dir: string): Promise<void> {
  const migrations = await resolveDataMigrations(dir);
  if (migrations.length === 0) {
    console.log('[data-plane] no migrations to apply');
    return;
  }
  for (const region of args.regions) {
    const apps = await args.listAppDbsForRegion(region);
    console.log(`[data-plane] region=${region} apps=${apps.length} migrations=${migrations.length}`);
    for (const app of apps) {
      const pool = new pg.Pool({ connectionString: app.url });
      try {
        await pool.query(`CREATE TABLE IF NOT EXISTS _migrations (
          file TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
        const { rows } = await pool.query<{ file: string }>(`SELECT file FROM _migrations`);
        const applied = new Set(rows.map((r) => r.file));
        for (const m of migrations) {
          if (applied.has(m.file)) continue;
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            await client.query(m.sql);
            await client.query(`INSERT INTO _migrations (file) VALUES ($1)`, [m.file]);
            await client.query('COMMIT');
            console.log(`[data-plane] [${region}/${app.appId}] applied: ${m.file}`);
          } catch (e) {
            await client.query('ROLLBACK').catch(() => {});
            throw e;
          } finally {
            client.release();
          }
        }
      } finally {
        await pool.end();
      }
    }
  }
}

// CLI entry — minimal: no apps in v1, just verify the runner loads.
if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = new URL('.', import.meta.url).pathname;
  resolveDataMigrations(dir).then((m) => {
    console.log(`[data-plane] resolved ${m.length} migration(s)`);
  });
}
