import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { apiError } from '../utils/api-error.js';
import { payloadHashBuf } from '../utils/canonical-json.js';
import { requireUserId } from '../utils/require-auth.js';
import { getRuntimeDbForApp, resolveAppHomeRegion } from '../services/region-resolver.js';
import {
  graphSpecSchema,
  agentAccessPatchSchema,
  createAgent, listAgents, getAgent, updateAgent, deleteAgent,
  type GraphSpec,
} from '../services/agents-service.js';

// Builtins that mutate state. Keep in sync with services/agent-runtime/src/agent_runtime/tools/builtin/.
const WRITE_BUILTINS = new Set([
  'insert_row', 'update_row', 'delete_row',
  'upsert_row', 'write_storage', 'delete_storage',
]);

/** Returns names of tools in the spec that write. Empty if the agent is read-only. */
function writeToolsInSpec(spec: GraphSpec): string[] {
  const offenders = new Set<string>();
  const refs: Array<{ source: string; name: string; mode_override?: string }> = [];
  for (const node of Object.values(spec.nodes)) {
    if (node.type === 'tool') refs.push(node.tool_ref);
    if (node.type === 'llm') refs.push(...(node.tools ?? []));
  }
  for (const ref of refs) {
    if (ref.mode_override === 'read_write') offenders.add(ref.name);
    if (ref.source === 'builtin' && WRITE_BUILTINS.has(ref.name)) offenders.add(ref.name);
  }
  return [...offenders];
}
import {
  createMcpServer, listMcpServers, deleteMcpServer, probeMcpServer,
  type ProbeFn,
} from '../services/agent-mcp-servers-service.js';

let _injectedProbeFn: ProbeFn | undefined;
/** Override the MCP probe function — for testing only. */
export function setProbeFn(fn: ProbeFn | undefined) {
  _injectedProbeFn = fn;
}
import {
  createRun, getRunById, listRunsForAgent, findRunByIdempotencyKey,
} from '../services/agent-runs-service.js';
import {
  startRun as startRunRemote,
  cancelRun as cancelRunRemote,
  resumeRun as resumeRunRemote,
} from '../services/agent-runtime-client.js';

type RuntimeClient = {
  startRun: (runId: string, region: string) => Promise<void>;
  cancelRun: (runId: string, region: string) => Promise<void>;
  resumeRun: (runId: string, region: string, input: unknown) => Promise<void>;
};
let _injectedRuntimeClient: RuntimeClient | undefined;
/** Override the runtime client — for testing only. */
export function setRuntimeClient(c: RuntimeClient | undefined) {
  _injectedRuntimeClient = c;
}

const createBody = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  display_name: z.string().optional(),
  description: z.string().optional(),
  graph_spec: graphSpecSchema,
  default_model: z.string().optional(),
}).merge(agentAccessPatchSchema);

const patchBody = z.object({
  display_name: z.string().optional(),
  description: z.string().optional(),
  graph_spec: graphSpecSchema.optional(),
  default_model: z.string().optional(),
  status: z.enum(['active', 'disabled']).optional(),
}).merge(agentAccessPatchSchema);

const mcpServerCreateBody = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  transport: z.enum(['http', 'sse', 'streamable_http']),
  url: z.string().url(),
  auth_header: z.string().optional(),
  tool_acl: z.record(z.string(), z.unknown()).optional(),
});

const runCreateBody = z.object({
  input: z.unknown(),
  webhook_url: z.string().url().optional(),
  idempotency_key: z.string().min(1).max(128).optional(),
  caller_user_id: z.string().optional(),
});

async function assertOwner(
  app: FastifyInstance,
  appId: string,
  userId: string,
): Promise<
  | { ok: true; runtimeDb: Pool; region: string }
  | { ok: false; code: number; error: string }
> {
  // apps + agent_* live in runtime-plane (Phase 2). Resolve the regional pool
  // first, then read owner_id from there. getRuntimeDbForApp throws typed
  // errors for "app not found" / "still provisioning" — surface them as 404 /
  // 503 instead of bubbling as INTERNAL_ERROR. Region is returned so route
  // handlers can pass it to agent-runtime — both lookups hit the same Redis
  // cache, so the second call is free.
  let runtimeDb: Pool;
  let region: string;
  try {
    runtimeDb = await getRuntimeDbForApp(app.controlDb, appId);
    region = await resolveAppHomeRegion(app.controlDb, appId);
  } catch (err: any) {
    const code: string = err?.code ?? err?.name ?? '';
    if (code === 'APP_NOT_FOUND') return { ok: false, code: 404, error: 'App not found' };
    if (code === 'APP_PROVISIONING') {
      return { ok: false, code: 503, error: 'App database is still being provisioned' };
    }
    throw err;
  }
  const r = await runtimeDb.query(
    'SELECT owner_id FROM apps WHERE id = $1',
    [appId],
  );
  if (r.rows.length === 0) return { ok: false, code: 404, error: 'App not found' };
  if (r.rows[0].owner_id !== userId) return { ok: false, code: 403, error: 'Not authorized' };
  return { ok: true, runtimeDb, region };
}

export async function agentsRoutes(app: FastifyInstance) {
  app.get('/v1/:appId/agents', async (request, reply) => {
    const { appId } = request.params as { appId: string };
    const userId = requireUserId(request);
    const own = await assertOwner(app, appId, userId);
    if (!own.ok) return reply.code(own.code).send({ error: own.error });
    try {
      const agents = await listAgents(own.runtimeDb, appId);
      return { agents };
    } catch (error) {
      app.log.error({ err: error }, 'list agents failed');
      return reply.code(500).send(apiError(error, 'Failed to list agents'));
    }
  });

  app.post('/v1/:appId/agents', async (request, reply) => {
    const { appId } = request.params as { appId: string };
    const userId = requireUserId(request);
    const own = await assertOwner(app, appId, userId);
    if (!own.ok) return reply.code(own.code).send({ error: own.error });
    const parsed = createBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid body', issues: parsed.error.issues });
    }
    if (parsed.data.visibility === 'public' && parsed.data.safety_acknowledged !== true) {
      const offenders = writeToolsInSpec(parsed.data.graph_spec);
      if (offenders.length > 0) {
        return reply.code(400).send({
          error: 'unsafe_public_visibility',
          message: 'Agent has write-mode tools. Pass safety_acknowledged=true to override.',
          offending_tools: offenders,
        });
      }
    }
    try {
      const agent = await createAgent(own.runtimeDb, appId, parsed.data);
      return reply.code(201).send({ agent });
    } catch (error: any) {
      if (error?.code === '23505') {
        return reply.code(409).send({ error: 'Agent name already exists' });
      }
      app.log.error({ err: error }, 'create agent failed');
      return reply.code(500).send(apiError(error, 'Failed to create agent'));
    }
  });

  app.get('/v1/:appId/agents/:name', async (request, reply) => {
    const { appId, name } = request.params as { appId: string; name: string };
    const userId = requireUserId(request);
    const own = await assertOwner(app, appId, userId);
    if (!own.ok) return reply.code(own.code).send({ error: own.error });
    const agent = await getAgent(own.runtimeDb, appId, name);
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });
    return { agent };
  });

  app.patch('/v1/:appId/agents/:name', async (request, reply) => {
    const { appId, name } = request.params as { appId: string; name: string };
    const userId = requireUserId(request);
    const own = await assertOwner(app, appId, userId);
    if (!own.ok) return reply.code(own.code).send({ error: own.error });
    const parsed = patchBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid body', issues: parsed.error.issues });
    }
    const existing = await getAgent(own.runtimeDb, appId, name);
    if (!existing) return reply.code(404).send({ error: 'Agent not found' });
    const targetVisibility = parsed.data.visibility ?? existing.visibility ?? 'private';
    const targetSpec: GraphSpec = parsed.data.graph_spec ?? existing.graph_spec;
    if (targetVisibility === 'public' && parsed.data.safety_acknowledged !== true) {
      const offenders = writeToolsInSpec(targetSpec);
      if (offenders.length > 0) {
        return reply.code(400).send({
          error: 'unsafe_public_visibility',
          message: 'Agent has write-mode tools. Pass safety_acknowledged=true to override.',
          offending_tools: offenders,
        });
      }
    }
    const agent = await updateAgent(own.runtimeDb, appId, name, parsed.data);
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });
    return { agent };
  });

  app.delete('/v1/:appId/agents/:name', async (request, reply) => {
    const { appId, name } = request.params as { appId: string; name: string };
    const userId = requireUserId(request);
    const own = await assertOwner(app, appId, userId);
    if (!own.ok) return reply.code(own.code).send({ error: own.error });
    const ok = await deleteAgent(own.runtimeDb, appId, name);
    if (!ok) return reply.code(404).send({ error: 'Agent not found' });
    return reply.code(204).send();
  });

  app.post('/v1/:appId/agents/:name/validate', async (request, reply) => {
    const { appId } = request.params as { appId: string };
    const userId = requireUserId(request);
    const own = await assertOwner(app, appId, userId);
    if (!own.ok) return reply.code(own.code).send({ error: own.error });
    const parsed = z.object({ graph_spec: graphSpecSchema })
      .safeParse(request.body);
    if (!parsed.success) {
      return reply.code(200).send({ valid: false, issues: parsed.error.issues });
    }
    return { valid: true };
  });

  app.get('/v1/:appId/mcp-servers', async (request, reply) => {
    const { appId } = request.params as { appId: string };
    const userId = requireUserId(request);
    const own = await assertOwner(app, appId, userId);
    if (!own.ok) return reply.code(own.code).send({ error: own.error });
    const servers = await listMcpServers(own.runtimeDb, appId);
    return { servers };
  });

  app.post('/v1/:appId/mcp-servers', async (request, reply) => {
    const { appId } = request.params as { appId: string };
    const userId = requireUserId(request);
    const own = await assertOwner(app, appId, userId);
    if (!own.ok) return reply.code(own.code).send({ error: own.error });
    const parsed = mcpServerCreateBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid body', issues: parsed.error.issues });
    }
    try {
      const server = await createMcpServer(own.runtimeDb, appId, parsed.data);
      return reply.code(201).send({ server });
    } catch (error: any) {
      if (error?.code === '23505') {
        return reply.code(409).send({ error: 'MCP server name already exists' });
      }
      return reply.code(500).send(apiError(error, 'Failed to create MCP server'));
    }
  });

  app.delete('/v1/:appId/mcp-servers/:id', async (request, reply) => {
    const { appId, id } = request.params as { appId: string; id: string };
    const userId = requireUserId(request);
    const own = await assertOwner(app, appId, userId);
    if (!own.ok) return reply.code(own.code).send({ error: own.error });
    const ok = await deleteMcpServer(own.runtimeDb, appId, id);
    if (!ok) return reply.code(404).send({ error: 'MCP server not found' });
    return reply.code(204).send();
  });

  app.post('/v1/:appId/mcp-servers/:id/probe', async (request, reply) => {
    const { appId, id } = request.params as { appId: string; id: string };
    const userId = requireUserId(request);
    const own = await assertOwner(app, appId, userId);
    if (!own.ok) return reply.code(own.code).send({ error: own.error });

    const result = await probeMcpServer(own.runtimeDb, appId, id, _injectedProbeFn);

    if (result.ok) {
      return reply.code(200).send({ ok: true, tools: result.tools });
    } else {
      if (result.error === 'MCP server not found') {
        return reply.code(404).send({ ok: false, error: result.error });
      }
      return reply.code(502).send({ ok: false, error: result.error });
    }
  });

  app.post('/v1/:appId/agents/:name/runs', async (request, reply) => {
    const { appId, name } = request.params as { appId: string; name: string };
    const userId = requireUserId(request);
    const own = await assertOwner(app, appId, userId);
    if (!own.ok) return reply.code(own.code).send({ error: own.error });

    const parsed = runCreateBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid body', issues: parsed.error.issues });
    }

    const agent = await getAgent(own.runtimeDb, appId, name);
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });
    if (agent.status !== 'active') {
      return reply.code(400).send({ error: 'Agent is disabled' });
    }

    const newHash = payloadHashBuf(parsed.data.input);

    if (parsed.data.idempotency_key) {
      const existing = await findRunByIdempotencyKey(
        own.runtimeDb, appId, parsed.data.idempotency_key,
      );
      if (existing) {
        const sameHash = existing.payload_hash != null
          && Buffer.compare(existing.payload_hash, newHash) === 0;
        if (sameHash) {
          return reply.code(202).send({ run_id: existing.id, status: existing.status });
        }
        return reply.code(409).send({
          error: 'idempotency_key_reuse',
          existing_run_id: existing.id,
        });
      }
    }

    // Plan 1: caller_kind defaults to 'function' for owner-authenticated calls.
    // The end_user-authenticated public path lands in Plan 3 along with auth glue.
    const run = await createRun(own.runtimeDb, appId, agent.id, {
      caller_kind: 'function',
      caller_user_id: parsed.data.caller_user_id,
      input: parsed.data.input,
      webhook_url: parsed.data.webhook_url,
      idempotency_key: parsed.data.idempotency_key,
      payload_hash: newHash,
    });

    try {
      await (_injectedRuntimeClient?.startRun ?? startRunRemote)(run.id, own.region);
    } catch (error) {
      app.log.error({ err: error, runId: run.id }, 'agent-runtime start failed');
      await own.runtimeDb.query(
        `UPDATE agent_runs
           SET status = 'failed',
               error = $2::jsonb,
               finished_at = now()
         WHERE id = $1 AND status = 'queued'`,
        [run.id, JSON.stringify({
          message: error instanceof Error ? error.message : String(error),
          type: 'AgentRuntimeStartFailed',
        })],
      );
    }

    const final = await getRunById(own.runtimeDb, appId, run.id);
    return reply.code(202).send({ run_id: run.id, status: final?.status ?? 'queued' });
  });

  app.get('/v1/:appId/agents/:name/runs/:id', async (request, reply) => {
    const { appId, name, id } = request.params as { appId: string; name: string; id: string };
    const userId = requireUserId(request);
    const own = await assertOwner(app, appId, userId);
    if (!own.ok) return reply.code(own.code).send({ error: own.error });
    const agent = await getAgent(own.runtimeDb, appId, name);
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });
    const run = await getRunById(own.runtimeDb, appId, id);
    if (!run || run.agent_id !== agent.id) {
      return reply.code(404).send({ error: 'Run not found' });
    }
    return { run };
  });

  app.get('/v1/:appId/agents/:name/runs', async (request, reply) => {
    const { appId, name } = request.params as { appId: string; name: string };
    const userId = requireUserId(request);
    const own = await assertOwner(app, appId, userId);
    if (!own.ok) return reply.code(own.code).send({ error: own.error });
    const agent = await getAgent(own.runtimeDb, appId, name);
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });
    const runs = await listRunsForAgent(own.runtimeDb, appId, agent.id);
    return { runs };
  });

  app.post('/v1/:appId/agents/:name/runs/:id/cancel', async (request, reply) => {
    const { appId, name, id } = request.params as { appId: string; name: string; id: string };
    const userId = requireUserId(request);
    const own = await assertOwner(app, appId, userId);
    if (!own.ok) return reply.code(own.code).send({ error: own.error });
    const agent = await getAgent(own.runtimeDb, appId, name);
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });
    const run = await getRunById(own.runtimeDb, appId, id);
    if (!run || run.agent_id !== agent.id) {
      return reply.code(404).send({ error: 'Run not found' });
    }
    if (['completed', 'failed', 'cancelled'].includes(run.status)) {
      return reply.code(409).send({ error: `Run already terminal (status: ${run.status})` });
    }
    await (_injectedRuntimeClient?.cancelRun ?? cancelRunRemote)(run.id, own.region);
    return reply.code(202).send({ run_id: run.id, status: 'cancelling' });
  });

  app.post('/v1/:appId/agents/:name/runs/:id/resume', async (request, reply) => {
    const { appId, name, id } = request.params as { appId: string; name: string; id: string };
    const userId = requireUserId(request);
    const own = await assertOwner(app, appId, userId);
    if (!own.ok) return reply.code(own.code).send({ error: own.error });
    const agent = await getAgent(own.runtimeDb, appId, name);
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });
    const run = await getRunById(own.runtimeDb, appId, id);
    if (!run || run.agent_id !== agent.id) {
      return reply.code(404).send({ error: 'Run not found' });
    }
    const parsed = z.object({ input: z.unknown() }).safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid body', issues: parsed.error.issues });
    }
    if (run.status !== 'paused') {
      return reply.code(409).send({ error: `Run is not paused (current status: ${run.status})` });
    }
    await (_injectedRuntimeClient?.resumeRun ?? resumeRunRemote)(run.id, own.region, parsed.data.input);
    return reply.code(202).send({ run_id: run.id, status: 'queued' });
  });

  app.get('/v1/:appId/agents/:name/runs/:id/events.json', async (request, reply) => {
    const { appId, name, id } = request.params as { appId: string; name: string; id: string };
    const userId = requireUserId(request);
    const own = await assertOwner(app, appId, userId);
    if (!own.ok) return reply.code(own.code).send({ error: own.error });
    const agent = await getAgent(own.runtimeDb, appId, name);
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });
    const run = await getRunById(own.runtimeDb, appId, id);
    if (!run || run.agent_id !== agent.id) return reply.code(404).send({ error: 'Run not found' });

    const sinceSeqRaw = Number((request.query as any)?.since_seq ?? 0);
    const sinceSeq = Number.isFinite(sinceSeqRaw) ? sinceSeqRaw : 0;
    const limitRaw = Number((request.query as any)?.limit ?? 100);
    const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 100, 1), 500);

    const r = await own.runtimeDb.query(
      `SELECT seq, type, payload, created_at FROM agent_run_events
       WHERE run_id = $1::uuid AND seq > $2 ORDER BY seq LIMIT $3`,
      [id, sinceSeq, limit],
    );
    return { events: r.rows };
  });
}
