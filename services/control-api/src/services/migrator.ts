import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = path.resolve(__dirname, '../../../../db/data-plane');

export async function runDataPlaneMigrations(dbNameOrConnectionString: string): Promise<void> {
  const isConnectionString = dbNameOrConnectionString.startsWith('postgres');

  const pool = isConnectionString
    ? new pg.Pool({ connectionString: dbNameOrConnectionString, max: 1, ssl: { rejectUnauthorized: false } })
    : new pg.Pool({
        host: config.dataPlaneDb.host,
        port: config.dataPlaneDb.port,
        user: config.dataPlaneDb.user,
        password: config.dataPlaneDb.password,
        database: dbNameOrConnectionString,
        max: 1,
      });

  const client = await pool.connect();
  try {
    // Bootstrap: ensure tracking table exists before we can query it
    await client.query(`
      CREATE TABLE IF NOT EXISTS _data_plane_migrations (
        id SERIAL PRIMARY KEY,
        filename TEXT NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // Get already-applied migrations
    const { rows: applied } = await client.query(
      'SELECT filename FROM _data_plane_migrations ORDER BY id'
    );
    const appliedSet = new Set(applied.map((r) => r.filename));

    // Read SQL files sorted numerically
    const files = fs
      .readdirSync(TEMPLATE_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      if (appliedSet.has(file)) {
        continue;
      }

      const sql = fs.readFileSync(path.join(TEMPLATE_DIR, file), 'utf-8');

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO _data_plane_migrations (filename) VALUES ($1)',
          [file]
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Data-plane migration ${file} failed: ${err}`);
      }
    }
  } finally {
    client.release();
    await pool.end();
  }
}
