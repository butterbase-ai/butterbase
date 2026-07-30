import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getAppPoolForApp } from '../services/app-pool.js';
import { AppResolver, AppNotFoundError } from '../services/app-resolver.js';
import { createAgentError, getDocUrl, isHttpError } from '../services/error-handler.js';
import { validateRlsPrerequisites } from '../services/rls-validator.js';
import { requireUserId } from '../utils/require-auth.js';
import { logFromRequest } from '../services/audit/with-audit.js';

// Functions that must never appear in RLS policy expressions.
// These can modify session state, read/write files, or execute arbitrary commands.
const BLOCKED_FUNCTIONS = [
  'set_config',
  'pg_read_file',
  'pg_read_binary_file',
  'pg_write_file',
  'lo_import',
  'lo_export',
  'dblink',
  'dblink_connect',
  'dblink_exec',
  'pg_execute_server_program',
  'pg_reload_conf',
  'pg_terminate_backend',
  'pg_cancel_backend',
];

/**
 * Checks a SQL expression for blocked function calls.
 * Returns the name of the first blocked function found, or null if safe.
 */
function validateExpressionSafety(expression: string): string | null {
  const normalized = expression.toLowerCase();
  for (const fn of BLOCKED_FUNCTIONS) {
    const regex = new RegExp(`\\b${fn}\\s*\\(`, 'i');
    if (regex.test(normalized)) {
      return fn;
    }
  }
  return null;
}

/**
 * Tables whose names start with "_" are reserved for platform use:
 * _ai_migrations (migration ledger), _rag_* (RAG infrastructure), and any
 * future internal tables. Their RLS policies are managed by Butterbase and
 * must not be mutated through user-facing endpoints — doing so can break
 * platform features. Mutation handlers must reject these tables before any
 * DB work is attempted.
 */
function isReservedTable(name: string): boolean {
  return name.startsWith('_');
}

function reservedTableReply(reply: { code: (n: number) => { send: (b: unknown) => unknown } }, table: string) {
  return reply.code(400).send(createAgentError({
    code: 'VALIDATION_RESERVED_TABLE',
    message: `Table "${table}" is reserved for platform use and cannot be modified through this API.`,
    remediation:
      'Tables prefixed with "_" (e.g. _ai_migrations, _rag_*) are managed by Butterbase. Use your own application tables instead.',
  }));
}

const createRlsPolicySchema = z.object({
  table_name: z.string(),
  user_column: z.string(),
  public_read_column: z.string().optional(),
});

const ROLE_MAP = { anon: 'butterbase_anon', user: 'butterbase_user' } as const;

const createCustomPolicySchema = z.object({
  table_name: z.string(),
  policy_name: z.string().regex(/^[a-z_][a-z0-9_]*$/, 'Policy name must be alphanumeric with underscores'),
  command: z.enum(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'ALL']).optional().default('ALL'),
  role: z.enum(['anon', 'user']).optional(),
  using_expression: z.string().optional(),
  with_check_expression: z.string().optional(),
  restrictive: z.boolean().optional().default(false),
  user_column: z.string().optional(),
}).refine(
  (data) => data.using_expression || data.with_check_expression,
  { message: 'At least one of using_expression or with_check_expression must be provided' }
);

export async function rlsRoutes(app: FastifyInstance) {
  // CREATE RLS POLICY — POST /v1/:app_id/rls
  app.post('/v1/:app_id/rls', async (request, reply) => {
    const { app_id } = request.params as { app_id: string };

    // Validate request body
    const parseResult = createRlsPolicySchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.code(400).send(createAgentError({
        code: 'VALIDATION_INVALID_SCHEMA',
        message: 'Invalid request body',
        remediation: 'Check the required fields and their types, then retry.',
        details: parseResult.error.errors,
      }));
    }

    const { table_name, user_column, public_read_column } = parseResult.data;

    if (isReservedTable(table_name)) return reservedTableReply(reply, table_name);

    try {
      const resolvedApp = await AppResolver.resolveApp(app.controlDb, app_id, requireUserId(request), request.auth?.organizationId ?? null);

      const pool = await getAppPoolForApp(app.controlDb, resolvedApp.id, resolvedApp.db_name);

      // Add validation before applying RLS
      const validation = await validateRlsPrerequisites(pool, table_name, user_column);

      if (!validation.valid) {
        return reply.code(400).send({ error: validation.error });
      }

      // Enable RLS on the table
      await pool.query(`ALTER TABLE "${table_name}" ENABLE ROW LEVEL SECURITY`);
      await pool.query(`ALTER TABLE "${table_name}" FORCE ROW LEVEL SECURITY`);

      // Create policy
      const policyName = `${table_name}_user_isolation`;

      // Get the column type to determine if we need to cast
      const columnTypeResult = await pool.query(
        `SELECT data_type FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
        [table_name, user_column]
      );

      const columnType = columnTypeResult.rows[0]?.data_type;
      const userIdExpression = columnType === 'uuid'
        ? 'current_user_id()::uuid'
        : 'current_user_id()';

      const triggerFunctionName = `${table_name}_set_user_id`;
      const triggerName = `${table_name}_set_user_id_trigger`;

      const serviceBypassName = `${table_name}_service_bypass`;
      const sqlUp = `ALTER TABLE "${table_name}" ENABLE ROW LEVEL SECURITY; ALTER TABLE "${table_name}" FORCE ROW LEVEL SECURITY; CREATE POLICY "${policyName}" ON "${table_name}" FOR ALL TO butterbase_user USING ("${user_column}" = ${userIdExpression}) WITH CHECK ("${user_column}" = ${userIdExpression}); CREATE POLICY "${serviceBypassName}" ON "${table_name}" TO butterbase_service USING (true) WITH CHECK (true); CREATE OR REPLACE FUNCTION ${triggerFunctionName}() RETURNS TRIGGER AS $$ BEGIN IF current_setting('app.role', true) NOT IN ('butterbase_service', 'butterbase_anon') THEN NEW."${user_column}" := ${userIdExpression}; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql; CREATE TRIGGER ${triggerName} BEFORE INSERT ON "${table_name}" FOR EACH ROW EXECUTE FUNCTION ${triggerFunctionName}();`;
      const checksum = createHash('sha256').update(sqlUp).digest('hex');

      const migrationName = `rls_${table_name}_user_isolation`;

      const client = await pool.connect();
      let publicReadPolicies: string[] = [];
      try {
        await client.query('BEGIN');

        await client.query(`ALTER TABLE "${table_name}" ENABLE ROW LEVEL SECURITY`);
        await client.query(`ALTER TABLE "${table_name}" FORCE ROW LEVEL SECURITY`);

        // Idempotent: retries or orphaned state from a failed pre-transaction run
        await client.query(`DROP POLICY IF EXISTS "${policyName}" ON "${table_name}"`);
        await client.query(`
          CREATE POLICY "${policyName}" ON "${table_name}"
          FOR ALL TO butterbase_user
          USING ("${user_column}" = ${userIdExpression})
          WITH CHECK ("${user_column}" = ${userIdExpression})
        `);

        // Service bypass: butterbase_service gets full access
        await client.query(`DROP POLICY IF EXISTS "${serviceBypassName}" ON "${table_name}"`);
        await client.query(`
          CREATE POLICY "${serviceBypassName}" ON "${table_name}"
          TO butterbase_service
          USING (true) WITH CHECK (true)
        `);

        await client.query(`
          CREATE OR REPLACE FUNCTION ${triggerFunctionName}()
          RETURNS TRIGGER AS $$
          BEGIN
            IF current_setting('app.role', true) NOT IN ('butterbase_service', 'butterbase_anon') THEN
              NEW."${user_column}" := ${userIdExpression};
            END IF;
            RETURN NEW;
          END;
          $$ LANGUAGE plpgsql;
        `);

        await client.query(`DROP TRIGGER IF EXISTS ${triggerName} ON "${table_name}"`);
        await client.query(`
          CREATE TRIGGER ${triggerName}
          BEFORE INSERT ON "${table_name}"
          FOR EACH ROW
          EXECUTE FUNCTION ${triggerFunctionName}();
        `);

        // Optional: create public read policies for a boolean column
        if (public_read_column) {
          const prColResult = await client.query(
            `SELECT data_type FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
            [table_name, public_read_column]
          );
          if (prColResult.rows.length === 0) {
            await client.query('ROLLBACK');
            client.release();
            return reply.code(400).send(createAgentError({
              code: 'VALIDATION_COLUMN_NOT_FOUND',
              message: `Column "${public_read_column}" does not exist in table "${table_name}"`,
              remediation: `Add the column to the table using apply_schema before using public_read_column.`,
            }));
          }
          if (prColResult.rows[0].data_type !== 'boolean') {
            await client.query('ROLLBACK');
            client.release();
            return reply.code(400).send(createAgentError({
              code: 'VALIDATION_INVALID_TYPE',
              message: `Column "${public_read_column}" must be boolean, got ${prColResult.rows[0].data_type}`,
              remediation: `public_read_column must be a boolean column (e.g., is_published, is_active).`,
            }));
          }

          const userReadPolicy = `${table_name}_public_read_user`;
          const anonReadPolicy = `${table_name}_public_read_anon`;

          await client.query(`DROP POLICY IF EXISTS "${userReadPolicy}" ON "${table_name}"`);
          await client.query(`
            CREATE POLICY "${userReadPolicy}" ON "${table_name}"
            FOR SELECT TO butterbase_user
            USING ("${public_read_column}" = true)
          `);

          await client.query(`DROP POLICY IF EXISTS "${anonReadPolicy}" ON "${table_name}"`);
          await client.query(`
            CREATE POLICY "${anonReadPolicy}" ON "${table_name}"
            FOR SELECT TO butterbase_anon
            USING ("${public_read_column}" = true)
          `);

          publicReadPolicies.push(userReadPolicy, anonReadPolicy);
        }

        await client.query(
          `INSERT INTO _ai_migrations (name, applied_by, sql_up, sql_down, checksum)
           SELECT $1, $2, $3, $4, $5
           WHERE NOT EXISTS (SELECT 1 FROM _ai_migrations WHERE name = $1)`,
          [migrationName, 'mcp', sqlUp, null, checksum]
        );

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      logFromRequest(request, {
        appId: app_id,
        category: 'admin',
        eventType: 'rls.policy.create',
        action: 'create',
        resourceType: 'rls_policy',
        resourceId: `${table_name}.${table_name}_user_isolation`,
        eventData: { table: table_name, user_column, policy_name: `${table_name}_user_isolation` },
        success: true,
      });

      return reply.send({
        success: true,
        table: table_name,
        user_column: user_column,
        policy_name: `${table_name}_user_isolation`,
        ...(publicReadPolicies.length > 0 && { public_read_policies: publicReadPolicies }),
        _meta: {
          next_actions: [
            {
              action: 'Test RLS',
              description: `Query /v1/${app_id}/${table_name} with an end-user JWT to verify isolation`,
              recommended: true
            },
            {
              action: 'configure_oauth_provider',
              description: 'Set up OAuth for end-user authentication',
              recommended: true
            }
          ]
        }
      });
    } catch (error) {
      if (isHttpError(error)) throw error;
      if (error instanceof AppNotFoundError) {
        return reply.code(404).send(createAgentError({
          code: 'RESOURCE_NOT_FOUND',
          message: error.message,
          remediation: 'Verify the app_id is correct. Use list_apps to see available apps.',
        }));
      }
      app.log.error({ error }, 'RLS policy creation failed');
      return reply.code(500).send(createAgentError({
        code: 'INTERNAL_ERROR',
        message: 'Failed to create RLS policy',
        remediation: 'An unexpected error occurred. Verify the table exists and is accessible, then retry.',
      }));
    }
  });

  // LIST RLS POLICIES — GET /v1/:app_id/rls
  app.get('/v1/:app_id/rls', async (request, reply) => {
    const { app_id } = request.params as { app_id: string };

    try {
      const resolvedApp = await AppResolver.resolveApp(app.controlDb, app_id, requireUserId(request), request.auth?.organizationId ?? null);

      const pool = await getAppPoolForApp(app.controlDb, resolvedApp.id, resolvedApp.db_name);

      // Exclude platform-managed internal tables (convention: leading
      // underscore). These cover the migration ledger (_ai_migrations), RAG
      // infra (_rag_*), and similar — Butterbase manages their RLS policies
      // and surfacing them here would let users break platform features.
      const policiesResult = await pool.query(`
        SELECT
          schemaname,
          tablename,
          policyname,
          permissive,
          roles,
          cmd,
          qual,
          with_check
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename NOT LIKE '\\_%' ESCAPE '\\'
        ORDER BY tablename, policyname
      `);

      const tablesWithRlsResult = await pool.query(`
        SELECT c.relname AS tablename
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND c.relrowsecurity = true
          AND c.relname NOT LIKE '\\_%' ESCAPE '\\'
        ORDER BY c.relname
      `);

      return reply.send({
        policies: policiesResult.rows,
        tables_with_rls: tablesWithRlsResult.rows.map((r: { tablename: string }) => r.tablename),
      });
    } catch (error) {
      if (isHttpError(error)) throw error;
      if (error instanceof AppNotFoundError) {
        return reply.code(404).send(createAgentError({
          code: 'RESOURCE_NOT_FOUND',
          message: error.message,
          remediation: 'Verify the app_id is correct. Use list_apps to see available apps.',
        }));
      }
      app.log.error({ error }, 'Failed to list RLS policies');
      return reply.code(500).send(createAgentError({
        code: 'INTERNAL_ERROR',
        message: 'Failed to list RLS policies',
        remediation: 'An unexpected error occurred querying policies. Verify the app exists and the database is accessible.',
      }));
    }
  });

  // CREATE CUSTOM POLICY — POST /v1/:app_id/rls/policies
  app.post('/v1/:app_id/rls/policies', async (request, reply) => {
    const { app_id } = request.params as { app_id: string };

    const parseResult = createCustomPolicySchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.code(400).send(createAgentError({
        code: 'VALIDATION_INVALID_SCHEMA',
        message: 'Invalid request body',
        remediation: 'Check the required fields and their types, then retry.',
        details: parseResult.error.errors,
      }));
    }

    const { table_name, policy_name, command, role, using_expression, with_check_expression, restrictive, user_column } = parseResult.data;

    if (isReservedTable(table_name)) return reservedTableReply(reply, table_name);

    // Validate expression safety BEFORE any SQL execution
    for (const [label, expr] of [
      ['using_expression', using_expression],
      ['with_check_expression', with_check_expression],
    ] as const) {
      if (expr) {
        const blockedFn = validateExpressionSafety(expr);
        if (blockedFn) {
          return reply.code(400).send(createAgentError({
            code: 'RLS_UNSAFE_EXPRESSION',
            message: `Expression contains blocked function "${blockedFn}" in ${label}`,
            remediation: `The function "${blockedFn}" is not allowed in RLS policy expressions for security reasons. Remove this function call and use only column comparisons and safe helper functions like current_user_id().`,
            documentation_url: getDocUrl('RLS_UNSAFE_EXPRESSION'),
          }));
        }
      }
    }

    try {
      const resolvedApp = await AppResolver.resolveApp(app.controlDb, app_id, requireUserId(request), request.auth?.organizationId ?? null);

      const pool = await getAppPoolForApp(app.controlDb, resolvedApp.id, resolvedApp.db_name);

      // Validate table exists
      const tableCheck = await pool.query(
        `SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = $1
        )`,
        [table_name]
      );

      if (!tableCheck.rows[0].exists) {
        return reply.code(400).send(createAgentError({
          code: 'VALIDATION_TABLE_NOT_FOUND',
          message: `Table "${table_name}" does not exist`,
          remediation: `Create the table first using apply_schema. Example: {"tables": {"${table_name}": {"columns": {...}}}}`,
        }));
      }

      // Build policy SQL — INSERT only supports WITH CHECK; SELECT/DELETE only support USING
      const toClause = role ? `TO ${ROLE_MAP[role]}` : '';
      const usingClause = using_expression ? `USING (${using_expression})` : '';
      const withCheckClause = with_check_expression ? `WITH CHECK (${with_check_expression})` : '';

      const asClause = restrictive ? 'AS RESTRICTIVE' : '';
      const policySQL = `CREATE POLICY "${policy_name}" ON "${table_name}" ${asClause} FOR ${command} ${toClause} ${usingClause} ${withCheckClause}`.replace(/\s+/g, ' ').trim();
      const checksum = createHash('sha256').update(policySQL).digest('hex');
      const migrationName = `rls_policy_${table_name}_${policy_name}`;

      // Dry-run: validate the policy SQL in a rolled-back transaction
      const dryRunClient = await pool.connect();
      try {
        await dryRunClient.query('BEGIN');
        await dryRunClient.query(`DROP POLICY IF EXISTS "${policy_name}" ON "${table_name}"`);
        await dryRunClient.query(policySQL);
        await dryRunClient.query('ROLLBACK');
      } catch (err: unknown) {
        await dryRunClient.query('ROLLBACK');
        const pgError = err as { code?: string; message?: string; hint?: string };
        if (pgError.code === '42883') {
          return reply.code(400).send(createAgentError({
            code: 'RLS_TYPE_MISMATCH',
            message: `Type mismatch in policy expression: ${pgError.message}`,
            remediation: pgError.hint || 'Ensure column types match function return types. Use ::uuid or ::text casts as needed. Example: current_user_id()::uuid',
          }));
        }
        if (pgError.code === '42601' || pgError.code?.startsWith('42')) {
          return reply.code(400).send(createAgentError({
            code: 'RLS_INVALID_EXPRESSION',
            message: `Invalid SQL in policy expression: ${pgError.message}`,
            remediation: pgError.hint || 'Check your using_expression and with_check_expression for syntax errors.',
          }));
        }
        throw err;
      } finally {
        dryRunClient.release();
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Idempotent: drop if exists
        await client.query(`DROP POLICY IF EXISTS "${policy_name}" ON "${table_name}"`);

        // Create policy
        await client.query(policySQL);

        // If user_column is provided, install a BEFORE INSERT trigger to auto-populate it
        if (user_column) {
          const triggerFunctionName = `${table_name}_set_user_id`;
          const triggerName = `${table_name}_set_user_id_trigger`;

          const colTypeResult = await client.query(
            `SELECT data_type FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
            [table_name, user_column]
          );

          if (colTypeResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return reply.code(400).send(createAgentError({
              code: 'VALIDATION_COLUMN_NOT_FOUND',
              message: `Column "${user_column}" does not exist in table "${table_name}"`,
              remediation: `Add the column to the table using apply_schema before creating an auto-populate trigger.`,
            }));
          }

          const colType = colTypeResult.rows[0].data_type;
          const userIdExpr = colType === 'uuid' ? 'current_user_id()::uuid' : 'current_user_id()';

          await client.query(`
            CREATE OR REPLACE FUNCTION ${triggerFunctionName}()
            RETURNS TRIGGER AS $$
            BEGIN
              IF current_setting('app.role', true) NOT IN ('butterbase_service', 'butterbase_anon') THEN
                NEW."${user_column}" := ${userIdExpr};
              END IF;
              RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;
          `);

          await client.query(`DROP TRIGGER IF EXISTS ${triggerName} ON "${table_name}"`);
          await client.query(`
            CREATE TRIGGER ${triggerName}
            BEFORE INSERT ON "${table_name}"
            FOR EACH ROW
            EXECUTE FUNCTION ${triggerFunctionName}();
          `);
        }

        // Record migration
        await client.query(
          `INSERT INTO _ai_migrations (name, applied_by, sql_up, sql_down, checksum)
           SELECT $1, $2, $3, $4, $5
           WHERE NOT EXISTS (SELECT 1 FROM _ai_migrations WHERE name = $1)`,
          [migrationName, 'mcp', policySQL, null, checksum]
        );

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      logFromRequest(request, {
        appId: app_id,
        category: 'admin',
        eventType: 'rls.policy.create',
        action: 'create',
        resourceType: 'rls_policy',
        resourceId: `${table_name}.${policy_name}`,
        eventData: { table: table_name, policy_name },
        success: true,
      });

      // Post-create advisory: if the expression contains a subquery against a table that has
      // RLS enabled but no permissive SELECT policy for the target role, the subquery will read
      // zero rows and the outer policy will silently evaluate false. This is the #1 source of
      // "my WITH CHECK looks trivially true but INSERT keeps failing" reports.
      const warnings: string[] = [];
      const targetRole = role ? ROLE_MAP[role] : null;
      if (targetRole) {
        const expressions = [using_expression, with_check_expression].filter(Boolean) as string[];
        const referencedTables = new Set<string>();
        for (const expr of expressions) {
          // Best-effort match: `FROM <ident>` and `JOIN <ident>` where ident is quoted or bare.
          const re = /\b(?:from|join)\s+(?:"([^"]+)"|([a-zA-Z_][a-zA-Z0-9_]*))/gi;
          let m: RegExpExecArray | null;
          while ((m = re.exec(expr)) !== null) {
            const name = m[1] || m[2];
            if (name && name.toLowerCase() !== table_name.toLowerCase()) referencedTables.add(name);
          }
        }
        if (referencedTables.size > 0) {
          const advisoryClient = await pool.connect();
          try {
            const check = await advisoryClient.query(
              `SELECT c.relname AS table_name,
                      c.relrowsecurity AS rls_enabled,
                      EXISTS (
                        SELECT 1 FROM pg_policies p
                        WHERE p.schemaname = 'public'
                          AND p.tablename = c.relname
                          AND (p.cmd = 'SELECT' OR p.cmd = 'ALL')
                          AND ($2 = ANY(p.roles) OR 'public' = ANY(p.roles))
                          AND (p.permissive = 'PERMISSIVE' OR p.permissive IS NULL)
                      ) AS has_readable_policy
               FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])`,
              [Array.from(referencedTables), targetRole]
            );
            for (const row of check.rows) {
              if (row.rls_enabled && !row.has_readable_policy) {
                warnings.push(
                  `Referenced table "${row.table_name}" has RLS enabled but no permissive SELECT policy for role "${role}". ` +
                  `Subqueries against it will return zero rows for end-users, causing this policy to silently evaluate false ` +
                  `(AUTH_RLS_POLICY_VIOLATION on writes, empty results on reads). ` +
                  `Fix: create_policy on "${row.table_name}" with command: "SELECT", role: "${role}", using_expression: <predicate>.`
                );
              }
            }
          } finally {
            advisoryClient.release();
          }
        }
      }

      return reply.send({
        success: true,
        policy_name,
        table: table_name,
        ...(warnings.length > 0 ? { warnings } : {}),
      });
    } catch (error) {
      if (isHttpError(error)) throw error;
      if (error instanceof AppNotFoundError) {
        return reply.code(404).send(createAgentError({
          code: 'RESOURCE_NOT_FOUND',
          message: error.message,
          remediation: 'Verify the app_id is correct. Use list_apps to see available apps.',
        }));
      }
      app.log.error({ error }, 'Failed to create policy');
      return reply.code(500).send(createAgentError({
        code: 'INTERNAL_ERROR',
        message: 'Failed to create policy',
        remediation: 'An unexpected error occurred. Check your policy expressions for correctness and retry.',
      }));
    }
  });

  // UPDATE CUSTOM POLICY ATOMICALLY — PATCH /v1/:app_id/rls/policies/:policy_name
  app.patch('/v1/:app_id/rls/policies/:policy_name', async (request, reply) => {
    const { app_id, policy_name } = request.params as { app_id: string; policy_name: string };

    // Schema for PATCH body — same as createCustomPolicySchema but policy_name comes from URL param
    const patchBodySchema = z.object({
      table_name: z.string(),
      command: z.enum(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'ALL']).optional().default('ALL'),
      role: z.enum(['anon', 'user']).optional(),
      using_expression: z.string().optional(),
      with_check_expression: z.string().optional(),
      restrictive: z.boolean().optional().default(false),
    }).refine(
      (data) => data.using_expression || data.with_check_expression,
      { message: 'At least one of using_expression or with_check_expression must be provided' }
    );

    const parseResult = patchBodySchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.code(400).send(createAgentError({
        code: 'VALIDATION_INVALID_SCHEMA',
        message: 'Invalid request body',
        remediation: 'Check the required fields and their types, then retry.',
        details: parseResult.error.errors,
      }));
    }

    const { table_name, command, role, using_expression, with_check_expression, restrictive } = parseResult.data;

    if (isReservedTable(table_name)) return reservedTableReply(reply, table_name);

    for (const [label, expr] of [
      ['using_expression', using_expression],
      ['with_check_expression', with_check_expression],
    ] as const) {
      if (expr) {
        const blockedFn = validateExpressionSafety(expr);
        if (blockedFn) {
          return reply.code(400).send(createAgentError({
            code: 'RLS_UNSAFE_EXPRESSION',
            message: `Expression contains blocked function "${blockedFn}" in ${label}`,
            remediation: `The function "${blockedFn}" is not allowed in RLS policy expressions for security reasons.`,
            documentation_url: getDocUrl('RLS_UNSAFE_EXPRESSION'),
          }));
        }
      }
    }

    try {
      const resolvedApp = await AppResolver.resolveApp(app.controlDb, app_id, requireUserId(request), request.auth?.organizationId ?? null);
      const pool = await getAppPoolForApp(app.controlDb, resolvedApp.id, resolvedApp.db_name);

      // 404 if the named policy does not exist on this table
      const exists = await pool.query(
        `SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = $1 AND policyname = $2`,
        [table_name, policy_name]
      );
      if ((exists.rowCount ?? 0) === 0) {
        return reply.code(404).send(createAgentError({
          code: 'RESOURCE_NOT_FOUND',
          message: `Policy "${policy_name}" not found on table "${table_name}"`,
          remediation: 'Use get_rls_policies to list existing policies, or create the policy with create_policy.',
        }));
      }

      const toClause = role ? `TO ${ROLE_MAP[role]}` : '';
      const usingClause = using_expression ? `USING (${using_expression})` : '';
      const withCheckClause = with_check_expression ? `WITH CHECK (${with_check_expression})` : '';
      const asClause = restrictive ? 'AS RESTRICTIVE' : '';
      const policySQL = `CREATE POLICY "${policy_name}" ON "${table_name}" ${asClause} FOR ${command} ${toClause} ${usingClause} ${withCheckClause}`.replace(/\s+/g, ' ').trim();
      const checksum = createHash('sha256').update(policySQL).digest('hex');
      const migrationName = `rls_policy_update_${table_name}_${policy_name}_${Date.now()}`;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`DROP POLICY IF EXISTS "${policy_name}" ON "${table_name}"`);
        await client.query(policySQL);
        await client.query(
          `INSERT INTO _ai_migrations (name, applied_by, sql_up, sql_down, checksum)
           SELECT $1, $2, $3, $4, $5
           WHERE NOT EXISTS (SELECT 1 FROM _ai_migrations WHERE name = $1)`,
          [migrationName, 'mcp', policySQL, null, checksum]
        );
        await client.query('COMMIT');
      } catch (err: unknown) {
        await client.query('ROLLBACK');
        const pgError = err as { code?: string; message?: string; hint?: string };
        if (pgError.code === '42883') {
          return reply.code(400).send(createAgentError({
            code: 'RLS_TYPE_MISMATCH',
            message: `Type mismatch in policy expression: ${pgError.message}`,
            remediation: pgError.hint || 'Ensure column types match function return types. Use ::uuid or ::text casts as needed.',
          }));
        }
        if (pgError.code?.startsWith('42')) {
          return reply.code(400).send(createAgentError({
            code: 'RLS_INVALID_EXPRESSION',
            message: `Invalid SQL in policy expression: ${pgError.message}`,
            remediation: pgError.hint || 'Check your using_expression and with_check_expression for syntax errors.',
          }));
        }
        throw err;
      } finally {
        client.release();
      }

      logFromRequest(request, {
        appId: app_id,
        category: 'admin',
        eventType: 'rls.policy.update',
        action: 'update',
        resourceType: 'rls_policy',
        resourceId: `${table_name}.${policy_name}`,
        eventData: { table: table_name, policy_name },
        success: true,
      });

      return reply.send({ success: true, policy_name, table: table_name });
    } catch (error) {
      if (isHttpError(error)) throw error;
      if (error instanceof AppNotFoundError) {
        return reply.code(404).send(createAgentError({
          code: 'RESOURCE_NOT_FOUND',
          message: error.message,
          remediation: 'Verify the app_id is correct.',
        }));
      }
      app.log.error({ error }, 'Failed to update policy');
      return reply.code(500).send(createAgentError({
        code: 'INTERNAL_ERROR',
        message: 'Failed to update policy',
        remediation: 'Check your policy expressions for correctness and retry.',
      }));
    }
  });

  // ENABLE RLS — POST /v1/:app_id/rls/enable
  app.post('/v1/:app_id/rls/enable', async (request, reply) => {
    const { app_id } = request.params as { app_id: string };

    const parseResult = z.object({ table_name: z.string() }).safeParse(request.body);
    if (!parseResult.success) {
      return reply.code(400).send(createAgentError({
        code: 'VALIDATION_INVALID_SCHEMA',
        message: 'Invalid request body',
        remediation: 'Check the required fields and their types, then retry.',
        details: parseResult.error.errors,
      }));
    }

    const { table_name } = parseResult.data;

    if (isReservedTable(table_name)) return reservedTableReply(reply, table_name);

    try {
      const resolvedApp = await AppResolver.resolveApp(app.controlDb, app_id, requireUserId(request), request.auth?.organizationId ?? null);

      const pool = await getAppPoolForApp(app.controlDb, resolvedApp.id, resolvedApp.db_name);

      // Validate table exists
      const tableCheck = await pool.query(
        `SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = $1
        )`,
        [table_name]
      );

      if (!tableCheck.rows[0].exists) {
        return reply.code(400).send(createAgentError({
          code: 'VALIDATION_TABLE_NOT_FOUND',
          message: `Table "${table_name}" does not exist`,
          remediation: `Create the table first using apply_schema. Example: {"tables": {"${table_name}": {"columns": {...}}}}`,
        }));
      }

      // Enable RLS (idempotent)
      await pool.query(`ALTER TABLE "${table_name}" ENABLE ROW LEVEL SECURITY`);
      await pool.query(`ALTER TABLE "${table_name}" FORCE ROW LEVEL SECURITY`);

      // Ensure service bypass policy exists so butterbase_service isn't blocked
      const serviceBypassName = `${table_name}_service_bypass`;
      await pool.query(`DROP POLICY IF EXISTS "${serviceBypassName}" ON "${table_name}"`);
      await pool.query(`
        CREATE POLICY "${serviceBypassName}" ON "${table_name}"
        TO butterbase_service
        USING (true) WITH CHECK (true)
      `);

      logFromRequest(request, {
        appId: app_id,
        category: 'admin',
        eventType: 'rls.enable',
        action: 'enable',
        resourceType: 'rls',
        resourceId: table_name,
        eventData: { table: table_name },
        success: true,
      });

      return reply.send({
        success: true,
        table: table_name,
        rls_enabled: true,
      });
    } catch (error) {
      if (isHttpError(error)) throw error;
      if (error instanceof AppNotFoundError) {
        return reply.code(404).send(createAgentError({
          code: 'RESOURCE_NOT_FOUND',
          message: error.message,
          remediation: 'Verify the app_id is correct. Use list_apps to see available apps.',
        }));
      }
      app.log.error({ error }, 'Failed to enable RLS');
      return reply.code(500).send(createAgentError({
        code: 'INTERNAL_ERROR',
        message: 'Failed to enable RLS',
        remediation: 'An unexpected error occurred. Verify the table exists and retry.',
      }));
    }
  });

  // DELETE RLS POLICIES — DELETE /v1/:app_id/rls/:table
  app.delete('/v1/:app_id/rls/:table', async (request, reply) => {
    const { app_id, table } = request.params as { app_id: string; table: string };

    if (isReservedTable(table)) return reservedTableReply(reply, table);

    try {
      const resolvedApp = await AppResolver.resolveApp(app.controlDb, app_id, requireUserId(request), request.auth?.organizationId ?? null);

      const pool = await getAppPoolForApp(app.controlDb, resolvedApp.id, resolvedApp.db_name);

      const triggerName = `${table}_set_user_id_trigger`;
      const triggerFunctionName = `${table}_set_user_id`;

      // Get all policies for this table
      const policies = await pool.query(
        `SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = $1`,
        [table]
      );

      if (policies.rows.length === 0) {
        // Policy row may be gone but trigger/function can remain after a failed create
        await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON "${table}"`);
        await pool.query(`DROP FUNCTION IF EXISTS ${triggerFunctionName}()`);
        return reply.code(404).send(createAgentError({
          code: 'RESOURCE_NOT_FOUND',
          message: `No RLS policies found for table "${table}"`,
          remediation: 'This table has no RLS policies to remove. Use enable_rls or create_user_isolation_policy to set up RLS first.',
        }));
      }

      // Drop all policies
      for (const row of policies.rows) {
        await pool.query(`DROP POLICY IF EXISTS "${row.policyname}" ON "${table}"`);
      }

      await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON "${table}"`);
      await pool.query(`DROP FUNCTION IF EXISTS ${triggerFunctionName}()`);

      // Disable RLS
      await pool.query(`ALTER TABLE "${table}" DISABLE ROW LEVEL SECURITY`);

      logFromRequest(request, {
        appId: app_id,
        category: 'admin',
        eventType: 'rls.disable',
        action: 'disable',
        resourceType: 'rls',
        resourceId: table,
        eventData: { table, policies_removed: policies.rows.length },
        success: true,
      });

      return reply.send({
        message: 'RLS policies removed successfully',
        table,
        policies_removed: policies.rows.length,
      });
    } catch (error) {
      if (isHttpError(error)) throw error;
      if (error instanceof AppNotFoundError) {
        return reply.code(404).send(createAgentError({
          code: 'RESOURCE_NOT_FOUND',
          message: error.message,
          remediation: 'Verify the app_id is correct. Use list_apps to see available apps.',
        }));
      }
      app.log.error({ error }, 'Failed to remove RLS policies');
      return reply.code(500).send(createAgentError({
        code: 'INTERNAL_ERROR',
        message: 'Failed to remove RLS policies',
        remediation: 'An unexpected error occurred. Verify the table exists and retry.',
      }));
    }
  });

  // DELETE SINGLE POLICY — DELETE /v1/:app_id/rls/:table/:policy_name
  app.delete('/v1/:app_id/rls/:table/:policy_name', async (request, reply) => {
    const { app_id, table, policy_name } = request.params as {
      app_id: string;
      table: string;
      policy_name: string;
    };

    if (isReservedTable(table)) return reservedTableReply(reply, table);

    if (!/^[a-z_][a-z0-9_]*$/.test(policy_name)) {
      return reply.code(400).send(createAgentError({
        code: 'VALIDATION_INVALID_SCHEMA',
        message: 'Policy name must be lowercase alphanumeric with underscores',
        remediation: 'Use only lowercase letters, digits, and underscores. The name must start with a letter or underscore.',
      }));
    }

    try {
      const resolvedApp = await AppResolver.resolveApp(app.controlDb, app_id, requireUserId(request), request.auth?.organizationId ?? null);

      const pool = await getAppPoolForApp(app.controlDb, resolvedApp.id, resolvedApp.db_name);

      // Check policy exists
      const policyCheck = await pool.query(
        `SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = $1 AND policyname = $2`,
        [table, policy_name]
      );

      if (policyCheck.rows.length === 0) {
        return reply.code(404).send(createAgentError({
          code: 'RESOURCE_NOT_FOUND',
          message: `Policy "${policy_name}" not found on table "${table}"`,
          remediation: 'Use get_rls_policies to see existing policies on this table.',
        }));
      }

      await pool.query(`DROP POLICY IF EXISTS "${policy_name}" ON "${table}"`);

      const remaining = await pool.query(
        `SELECT COUNT(*) as count FROM pg_policies WHERE schemaname = 'public' AND tablename = $1`,
        [table]
      );

      logFromRequest(request, {
        appId: app_id,
        category: 'admin',
        eventType: 'rls.policy.delete',
        action: 'delete',
        resourceType: 'rls_policy',
        resourceId: `${table}.${policy_name}`,
        eventData: { table, policy_name },
        success: true,
      });

      return reply.send({
        message: `Policy "${policy_name}" removed from table "${table}"`,
        table,
        policy_name,
        remaining_policies: parseInt(remaining.rows[0].count, 10),
      });
    } catch (error) {
      if (isHttpError(error)) throw error;
      if (error instanceof AppNotFoundError) {
        return reply.code(404).send(createAgentError({
          code: 'RESOURCE_NOT_FOUND',
          message: error.message,
          remediation: 'Verify the app_id is correct.',
        }));
      }
      app.log.error({ error }, 'Failed to remove RLS policy');
      return reply.code(500).send(createAgentError({
        code: 'INTERNAL_ERROR',
        message: 'Failed to remove RLS policy',
        remediation: 'An unexpected error occurred. Verify the table and policy name, then retry.',
      }));
    }
  });
}
