import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiPost, apiGet, apiDelete } from '../api-client.js';

export function registerMoveApp(server: McpServer) {
  server.tool(
    'move_app',
    `Migrate an app to a different region. Checks eligibility first, then enqueues the migration.

Parameters:
  - app_id:      The app to migrate (e.g. app_abc123)
  - dest_region: Target region slug (e.g. "us-west-2", "eu-central-1")

Returns: migration_id and initial status "queued".

Common errors:
  - 409 ineligible: App already has an in-progress migration, or is already in dest_region.
  - 404: App not found — verify app_id with manage_app (action: "list").`,
    {
      app_id: z.string().describe('The app ID to migrate (e.g. app_abc123)'),
      dest_region: z.string().describe('Target region slug (e.g. "us-west-2")'),
    },
    {
      title: 'Move App',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    async ({ app_id, dest_region }) => {
      try {
        const result = await apiPost(`/v1/apps/${app_id}/move`, { dest_region });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true as const };
      }
    },
  );

  server.tool(
    'move_app_status',
    `Get the current status of an app migration.

Parameters:
  - app_id:       The app being migrated
  - migration_id: The migration ID returned by move_app

Returns: current_step, source/dest regions, replica state, timing, and progress info.

Steps in order: requested → reserving_dest → blocking_writes → dumping_data → restoring_data →
  copying_blobs → copying_runtime → flipping_routing → setting_up_reverse_replication →
  unblocking_writes → completed`,
    {
      app_id: z.string().describe('The app ID (e.g. app_abc123)'),
      migration_id: z.string().describe('The migration ID returned by move_app'),
    },
    {
      title: 'Move App Status',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    async ({ app_id, migration_id }) => {
      try {
        const result = await apiGet(`/v1/apps/${app_id}/migrations/${migration_id}`);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true as const };
      }
    },
  );

  server.tool(
    'teardown_source_replica',
    `Tear down the source replica kept after a completed app migration.

After a move completes, the source region retains a read replica for rollback safety.
Once you're confident the migration is stable, call this to decommission it and stop
incurring source-region costs.

Parameters:
  - migration_id: The migration ID whose source replica should be torn down

Returns: { status: "torn_down" } on success.

Common errors:
  - 404: Migration not found or not owned by you.
  - 409 teardown_failed: Replica is in a state that prevents teardown.`,
    {
      migration_id: z.string().describe('The migration ID whose source replica to tear down'),
    },
    {
      title: 'Teardown Source Replica',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    async ({ migration_id }) => {
      try {
        const result = await apiDelete(`/v1/source-replicas/${migration_id}`);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true as const };
      }
    },
  );
}
