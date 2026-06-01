import type { FastifyInstance } from 'fastify';
import { getAppPoolForApp } from '../services/app-pool.js';
import { introspectSchema } from '../services/schema-introspector.js';
import { diffSchema } from '../services/schema-differ.js';
import { applyMigration } from '../services/schema-applier.js';
import { SchemaDSLSchema } from '../services/schema-validator.js';
import { AppResolver, AppNotFoundError } from '../services/app-resolver.js';
import { createAgentError, getDocUrl, isHttpError } from '../services/error-handler.js';
import { config } from '../config.js';
import { requireUserId } from '../utils/require-auth.js';
import { logFromRequest } from '../services/audit/with-audit.js';

export async function schemaRoutes(app: FastifyInstance) {
  app.get('/v1/:app_id/schema', async (request, reply) => {
    const { app_id } = request.params as { app_id: string };

    try {
      const resolvedApp = await AppResolver.resolveApp(
        app.controlDb,
        app_id,
        requireUserId(request)
      );

      const pool = await getAppPoolForApp(app.controlDb, resolvedApp.id, resolvedApp.db_name);
      const schema = await introspectSchema(pool);
      delete schema._fkConstraints;

      // Count tables for resource_info
      const tableCount = Object.keys(schema.tables).length;

      return {
        app_id,
        schema,
        api_base: `${config.apiBaseUrl}/v1/${app_id}`,
        _meta: {
          resource_info: {
            table_count: tableCount,
            tables: Object.keys(schema.tables)
          },
          next_actions: [
            {
              action: 'create_rls_policy',
              description: 'Set up row-level security to restrict data access per user',
              tool: 'create_rls_policy',
              when: 'After creating tables with user-specific data'
            }
          ]
        }
      };
    } catch (error) {
      if (isHttpError(error)) throw error;
      if (error instanceof AppNotFoundError) {
        return reply.code(404).send(createAgentError({
          code: 'APP_NOT_FOUND',
          message: `App "${app_id}" not found`,
          remediation: 'Verify the app_id is correct. Use list_apps to see available apps.',
          documentation_url: getDocUrl('APP_NOT_FOUND')
        }));
      }
      throw error;
    }
  });

  app.post('/v1/:app_id/schema/apply', async (request, reply) => {
    const { app_id } = request.params as { app_id: string };
    const body = request.body as {
      schema: unknown;
      dry_run?: boolean;
      name?: string;
    };

    // Hoisted so the catch block can run a follow-up COUNT(*) when 23502 fires
    // during ALTER TABLE — surfacing the offending-row count helps users decide
    // whether to delete, backfill, or relax to nullable.
    let pool: Awaited<ReturnType<typeof getAppPoolForApp>> | undefined;

    try {
      const resolvedApp = await AppResolver.resolveApp(
        app.controlDb,
        app_id,
        requireUserId(request)
      );

      // Validate DSL input
      const parseResult = SchemaDSLSchema.safeParse(body.schema);
      if (!parseResult.success) {
        return reply.code(400).send(createAgentError({
          code: 'VALIDATION_INVALID_SCHEMA',
          message: 'Schema validation failed',
          remediation: 'Review the validation errors in the details field and correct your schema definition.',
          documentation_url: getDocUrl('VALIDATION_INVALID_SCHEMA'),
          details: parseResult.error.issues
        }));
      }

      pool = await getAppPoolForApp(app.controlDb, resolvedApp.id, resolvedApp.db_name);
      const desired = parseResult.data;
      const current = await introspectSchema(pool);
      const statements = diffSchema(current, desired);

      // Helper: sync _seed_tables to match the _seed flags in the DSL.
      // Called unconditionally so that toggling _seed without any DDL change
      // (statements.length === 0) is still persisted.
      const syncSeedTables = async (): Promise<void> => {
        const client = await pool!.connect();
        try {
          for (const [tableName, tableDef] of Object.entries(desired.tables)) {
            if (tableDef._seed === true) {
              await client.query(
                `INSERT INTO _seed_tables (name) VALUES ($1) ON CONFLICT DO NOTHING`,
                [tableName]
              );
            } else {
              await client.query(
                `DELETE FROM _seed_tables WHERE name = $1`,
                [tableName]
              );
            }
          }
        } finally {
          client.release();
        }
      };

      if (statements.length === 0) {
        await syncSeedTables();
        return { applied: 0, statements: [], message: 'Schema is up to date' };
      }

      // Check for destructive operations without opt-in
      const unauthorized = statements.filter(
        (s) => s.destructive && !s.authorized
      );
      if (unauthorized.length > 0) {
        return reply.code(409).send(createAgentError({
          code: 'SCHEMA_DESTRUCTIVE_CHANGE',
          message: 'Destructive schema changes require explicit authorization',
          remediation: 'Add _drop array for tables or _dropColumns array for columns to authorize destructive operations.',
          documentation_url: getDocUrl('SCHEMA_DESTRUCTIVE_CHANGE'),
          details: unauthorized.map((s) => s.description)
        }));
      }

      if (body.dry_run) {
        return {
          dry_run: true,
          applied: statements.length,
          statements: statements.map((s) => ({
            sql: s.sql,
            description: s.description,
            destructive: s.destructive,
          })),
        };
      }

      const migrationName =
        body.name || `schema_${new Date().toISOString().replace(/[:.]/g, '-')}`;

      const result = await applyMigration(
        pool,
        statements,
        migrationName
      );

      await syncSeedTables();

      logFromRequest(request, {
        appId: app_id,
        category: 'admin',
        eventType: 'schema.apply',
        action: 'update',
        resourceType: 'schema',
        resourceId: migrationName,
        eventData: {
          migration_name: migrationName,
          statement_count: statements.length,
          destructive: statements.some((s) => s.destructive),
        },
        success: true,
      });

      return reply.code(200).send(result);
    } catch (error) {
      if (isHttpError(error)) throw error;
      if (error instanceof AppNotFoundError) {
        return reply.code(404).send(createAgentError({
          code: 'APP_NOT_FOUND',
          message: `App "${app_id}" not found`,
          remediation: 'Verify the app_id is correct. Use list_apps to see available apps.',
          documentation_url: getDocUrl('APP_NOT_FOUND')
        }));
      }

      const pgError = error as Error & {
        code?: string;
        severity?: string;
        column?: string;
        table?: string;
      };
      logFromRequest(request, {
        appId: app_id,
        category: 'admin',
        eventType: 'schema.apply',
        action: 'update',
        resourceType: 'schema',
        eventData: { pg_code: pgError.code },
        success: false,
        errorMessage: pgError.message,
      });

      // 23502 during ALTER TABLE ADD COLUMN: the new column is non-nullable but
      // existing rows would be NULL. Surface the offending row count and a
      // remediation tailored to this specific case — the generic SQL-error
      // text is misleading here ("references a missing table/column" doesn't apply).
      if (pgError.code === '23502') {
        const col = pgError.column;
        const tbl = pgError.table;
        let rowCount: number | undefined;
        if (pool && tbl) {
          try {
            const countRes = await pool.query(
              `SELECT COUNT(*)::int AS n FROM "${tbl.replace(/"/g, '""')}"`
            );
            rowCount = countRes.rows[0]?.n as number | undefined;
          } catch {
            // best-effort — never let the count query mask the real error
          }
        }
        const colRef = col && tbl ? `column "${col}" on table "${tbl}"` : 'the new column';
        const rowsPhrase =
          typeof rowCount === 'number'
            ? `${rowCount} existing row${rowCount === 1 ? '' : 's'} would be NULL`
            : 'existing rows would be NULL';
        return reply.code(400).send(createAgentError({
          code: 'SCHEMA_MIGRATION_FAILED',
          message:
            `Cannot add ${colRef} as NOT NULL: ${rowsPhrase}, which violates the constraint.`,
          remediation:
            'Choose one: (1) delete the existing rows first, ' +
            '(2) add the column as nullable now and backfill values before tightening it, ' +
            'or (3) provide a `default` so existing rows get a value automatically. ' +
            'Example default for uuid: "default": "gen_random_uuid()"; for timestamps: "default": "now()".',
          documentation_url: getDocUrl('SCHEMA_MIGRATION_FAILED'),
          details: {
            pg_code: pgError.code,
            severity: pgError.severity,
            ...(col ? { column: col } : {}),
            ...(tbl ? { table: tbl } : {}),
            ...(typeof rowCount === 'number' ? { existing_row_count: rowCount } : {}),
          },
        }));
      }

      // PG SQLSTATE codes are 5 chars from [0-9A-Z]. Many start with letters
      // (e.g. 0A000 feature_not_supported, 2F002, XX001) — don't restrict to digit prefixes.
      if (pgError.code && /^[0-9A-Z]{5}$/.test(pgError.code)) {
        return reply.code(400).send(createAgentError({
          code: 'SCHEMA_MIGRATION_FAILED',
          message: pgError.message,
          remediation: 'Review the SQL error and fix the schema definition. '
            + 'Common causes: referencing a table/column that does not exist, '
            + 'invalid column types, or duplicate names.',
          documentation_url: getDocUrl('SCHEMA_MIGRATION_FAILED'),
          details: { pg_code: pgError.code, severity: pgError.severity },
        }));
      }

      throw error;
    }
  });

  app.get('/v1/:app_id/migrations', async (request, reply) => {
    const { app_id } = request.params as { app_id: string };

    try {
      const resolvedApp = await AppResolver.resolveApp(
        app.controlDb,
        app_id,
        requireUserId(request)
      );

      const pool = await getAppPoolForApp(app.controlDb, resolvedApp.id, resolvedApp.db_name);
      const result = await pool.query(`
        SELECT id, name AS description, sql_up AS applied_sql, applied_at
        FROM _ai_migrations
        ORDER BY applied_at DESC
      `);

      // Data-plane template migrations (may not exist on older apps)
      let templateMigrations: { id: number; filename: string; applied_at: string }[] = [];
      try {
        const tmResult = await pool.query(`
          SELECT id, filename, applied_at
          FROM _data_plane_migrations
          ORDER BY id ASC
        `);
        templateMigrations = tmResult.rows;
      } catch {
        // Table doesn't exist yet — app hasn't had backfill run
      }

      return {
        app_id,
        migrations: result.rows,
        template_migrations: templateMigrations,
      };
    } catch (error) {
      if (isHttpError(error)) throw error;
      if (error instanceof AppNotFoundError) {
        return reply.code(404).send({ error: error.message });
      }
      throw error;
    }
  });
}
