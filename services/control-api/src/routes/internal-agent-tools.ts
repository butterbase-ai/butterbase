import type { FastifyPluginAsync } from 'fastify';
import { z, ZodError } from 'zod';
import { requireInternalServiceToken } from '../services/agent-tool-callback-auth.js';
import { dispatchBuiltin } from '../services/agent-tools/builtin-dispatcher.js';
import { invokeFunction } from '../services/function-invoke.js';

const builtinBody = z.object({
  app_id: z.string(),
  run_id: z.string().uuid(),
  caller_kind: z.enum(['end_user', 'function', 'dashboard']),
  caller_user_id: z.string().nullable(),
  args: z.record(z.unknown()),
});

const fnBody = builtinBody.extend({
  function_name: z.string(),
});

export const internalAgentToolsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireInternalServiceToken);

  /**
   * POST /internal/agent-tools/builtin/:tool_name
   *
   * Dispatches a built-in tool call on behalf of the agent runtime.
   * Enforces RLS by mapping caller_kind → butterbase_user | butterbase_service.
   */
  app.post('/internal/agent-tools/builtin/:tool_name', async (req, reply) => {
    let params: { tool_name: string };
    let body: z.infer<typeof builtinBody>;

    try {
      params = z.object({ tool_name: z.string() }).parse(req.params);
      body = builtinBody.parse(req.body);
    } catch (err) {
      if (err instanceof ZodError) {
        return reply.code(400).send({ ok: false, error: 'invalid request', issues: err.issues });
      }
      throw err;
    }

    const result = await dispatchBuiltin(
      params.tool_name,
      body.args,
      {
        appId: body.app_id,
        runId: body.run_id,
        callerKind: body.caller_kind,
        callerUserId: body.caller_user_id,
      },
      app.controlDb,
    );

    reply.code(result.ok ? 200 : 400).send(result);
  });

  /**
   * POST /internal/agent-tools/function-invoke
   *
   * Invokes a user-defined serverless function as a tool.
   * Proxies through the existing function-invoke service which calls the Deno runtime.
   */
  app.post('/internal/agent-tools/function-invoke', async (req, reply) => {
    let body: z.infer<typeof fnBody>;

    try {
      body = fnBody.parse(req.body);
    } catch (err) {
      if (err instanceof ZodError) {
        return reply.code(400).send({ ok: false, error: 'invalid request', issues: err.issues });
      }
      throw err;
    }

    const r = await invokeFunction({
      appId: body.app_id,
      functionName: body.function_name,
      args: body.args,
      callerKind: body.caller_kind,
      callerUserId: body.caller_user_id,
      runId: body.run_id,
    });

    reply.code(r.ok ? 200 : 400).send(r);
  });
};
