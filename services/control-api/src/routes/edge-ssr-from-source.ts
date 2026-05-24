// Edge SSR "from source" deployment routes
// Creates deployment + build-job rows, provides a presigned source upload URL,
// kicks off the build via BuildDriver, and streams build logs as SSE.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import crypto from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { AppResolver, AppNotFoundError } from '../services/app-resolver.js';
import {
  createAgentError,
  getDocUrl,
  detectInvalidInput,
  createInvalidInputError,
  detectConstraintViolation,
  createConstraintViolationError,
} from '../services/error-handler.js';
import { RESOURCE_NOT_FOUND, STATE_PREREQUISITE_MISSING, QUOTA_FILE_SIZE_EXCEEDED } from '@butterbase/shared/error-types';
import { requireUserId } from '../utils/require-auth.js';
import * as R2 from '../services/r2.js';
import * as BuildDriver from '../services/build-driver.service.js';
import { loadAppEnvVars } from '../services/build-driver.service.js';
import { logFromRequest } from '../services/audit/with-audit.js';
import { config } from '../config.js';
import { resolveAppHomeRegion } from '../services/region-resolver.js';
import { getRuntimeDbPool } from '../services/runtime-db.js';

const createSchema = z.object({
  framework: z.enum(['nextjs-edge', 'remix-edge', 'other-edge']).default('nextjs-edge'),
});

const startSchema = z.object({
  buildCommand: z.string().min(1).max(500).default('npx @cloudflare/next-on-pages'),
  outputDir: z.string().min(1).max(200).default('.vercel/output/static'),
  packageManager: z.enum(['npm', 'pnpm', 'yarn']).default('npm'),
  lockfileHash: z.string().regex(/^[a-f0-9]{8,64}$/),
  userEnv: z.record(z.string(), z.string()).default({}),
});

export async function registerEdgeSsrFromSourceRoutes(fastify: FastifyInstance) {
  const { controlDb } = fastify;

  fastify.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppNotFoundError) {
      return reply.code(404).send(createAgentError({
        code: RESOURCE_NOT_FOUND,
        message: 'App not found',
        remediation: 'Verify the app_id is correct. Use list_apps to see available apps. If you just called init_app, the database may still be provisioning — wait a few seconds and retry.',
        documentation_url: getDocUrl(RESOURCE_NOT_FOUND),
      }));
    }

    const invalidInput = detectInvalidInput(error);
    if (invalidInput.isInvalidInput) {
      return reply.code(400).send(createInvalidInputError(invalidInput.code!, invalidInput.detail));
    }

    const constraintCheck = detectConstraintViolation(error);
    if (constraintCheck.isConstraint) {
      return reply.code(400).send(
        createConstraintViolationError(constraintCheck.constraintType!, constraintCheck.details!, { column: constraintCheck.column, tableName: constraintCheck.tableName })
      );
    }

    throw error;
  });

  // POST /v1/:appId/edge-ssr/deployments/from-source
  // Creates deployment + build-job rows, returns presigned R2 PUT URL for source zip.
  fastify.post('/v1/:appId/edge-ssr/deployments/from-source', async (request, reply) => {
    const { appId } = request.params as { appId: string };
    const userId = requireUserId(request);
    await AppResolver.resolveApp(controlDb, appId, userId);

    const body = createSchema.parse(request.body ?? {});

    const buildId = crypto.randomUUID();

    // app_edge_ssr_deployments lives in the runtime DB; resolve the app's
    // home region and route the INSERT there. app_build_jobs stays on the
    // control DB (platform-scope) — the build_jobs.deployment_id is a soft
    // pointer, not an FK, so cross-tier is fine.
    const region = await resolveAppHomeRegion(controlDb, appId);
    const runtimeDb = getRuntimeDbPool(config.runtimeDb, region);

    const depRow = await runtimeDb.query<{ id: string }>(
      `INSERT INTO app_edge_ssr_deployments (app_id, framework, status, deployed_by)
       VALUES ($1, $2, 'WAITING', $3)
       RETURNING id`,
      [appId, body.framework, userId],
    );
    const resolvedDeploymentId = depRow.rows[0].id;

    await controlDb.query(
      `INSERT INTO app_build_jobs
         (id, deployment_id, deploy_type, status, source_r2_key, log_r2_key)
       VALUES ($1, $2, 'edge_ssr', 'PENDING', $3, $4)`,
      [
        buildId,
        resolvedDeploymentId,
        `source/${resolvedDeploymentId}.zip`,
        `logs/${resolvedDeploymentId}.txt`,
      ],
    );

    const uploadUrl = await R2.presignSourceUpload(`source/${resolvedDeploymentId}.zip`);

    logFromRequest(request, {
      appId,
      category: 'admin',
      eventType: 'deployment.create',
      action: 'create',
      resourceType: 'deployment',
      resourceId: resolvedDeploymentId,
      eventData: { framework: body.framework, source: 'from-source' },
      success: true,
    });

    return reply.code(201).send({
      deployment_id: resolvedDeploymentId,
      build_id: buildId,
      upload_url: uploadUrl,
      max_source_bytes: 50 * 1024 * 1024,
    });
  });

  // POST /v1/:appId/edge-ssr/deployments/from-source/:deploymentId/start
  // Kicks off the build via BuildDriver after caller has uploaded source zip.
  fastify.post('/v1/:appId/edge-ssr/deployments/from-source/:deploymentId/start', async (request, reply) => {
    const { appId, deploymentId } = request.params as { appId: string; deploymentId: string };
    const userId = requireUserId(request);
    await AppResolver.resolveApp(controlDb, appId, userId);

    const body = startSchema.parse(request.body ?? {});

    const job = await controlDb.query(
      `SELECT id, deployment_id FROM app_build_jobs
        WHERE deployment_id = $1 AND deploy_type = 'edge_ssr' AND status = 'PENDING'
        ORDER BY created_at DESC LIMIT 1`,
      [deploymentId],
    );
    if ((job.rowCount ?? 0) === 0) {
      return reply.code(404).send(createAgentError({
        code: RESOURCE_NOT_FOUND,
        message: 'No PENDING build job found for that deployment',
        remediation: 'Verify the deployment_id is correct and was created via the from-source endpoint.',
        documentation_url: getDocUrl(RESOURCE_NOT_FOUND),
      }));
    }

    await controlDb.query(
      `UPDATE app_build_jobs
          SET build_command = $2, output_dir = $3, package_manager = $4
        WHERE id = $1`,
      [job.rows[0].id, body.buildCommand, body.outputDir, body.packageManager],
    );

    // Verify that the source zip was actually uploaded before spinning up the build container.
    const sourceKey = `source/${deploymentId}.zip`;
    const sourceMeta = await R2.head(sourceKey);
    if (!sourceMeta.exists) {
      return reply.code(409).send(createAgentError({
        code: STATE_PREREQUISITE_MISSING,
        message: `Source zip not found at ${sourceKey}. Upload the source zip to the presigned URL returned by the create call before starting the build.`,
        remediation: 'PUT the project source zip (Content-Type: application/zip) to the upload_url returned by the from-source create endpoint, then call /start again.',
        documentation_url: getDocUrl(STATE_PREREQUISITE_MISSING),
      }));
    }
    if (sourceMeta.contentLength > 50 * 1024 * 1024) {
      return reply.code(413).send(createAgentError({
        code: QUOTA_FILE_SIZE_EXCEEDED,
        message: `Source zip exceeds 50 MB (got ${sourceMeta.contentLength} bytes).`,
        remediation: 'Reduce source size by excluding node_modules and build outputs from the zip.',
        documentation_url: getDocUrl(QUOTA_FILE_SIZE_EXCEEDED),
      }));
    }

    // Load + decrypt app env vars from DB; client-supplied vars override stored ones.
    const appEnv = await loadAppEnvVars(controlDb, appId);
    const mergedEnv = { ...appEnv, ...body.userEnv };

    await BuildDriver.startBuild(controlDb, {
      buildId: job.rows[0].id,
      deploymentId,
      appId,
      deployType: 'edge_ssr',
      buildCommand: body.buildCommand,
      outputDir: body.outputDir,
      packageManager: body.packageManager,
      lockfileHash: body.lockfileHash,
      userEnv: mergedEnv,
    });

    logFromRequest(request, {
      appId,
      category: 'admin',
      eventType: 'deployment.start',
      action: 'update',
      resourceType: 'deployment',
      resourceId: deploymentId,
      eventData: { build_id: job.rows[0].id, source: 'from-source' },
      success: true,
    });

    return reply.code(202).send({
      build_id: job.rows[0].id,
      status: 'BUILDING',
      logs_url: `/v1/${appId}/edge-ssr/deployments/from-source/${deploymentId}/logs`,
      status_url: `/v1/${appId}/edge-ssr/deployments/${deploymentId}`,
    });
  });

  // GET /v1/:appId/edge-ssr/deployments/from-source/:deploymentId/logs
  // Server-Sent Events: live tail if build is in flight, replay from R2 otherwise.
  fastify.get('/v1/:appId/edge-ssr/deployments/from-source/:deploymentId/logs', async (request, reply) => {
    const { appId, deploymentId } = request.params as { appId: string; deploymentId: string };
    const userId = requireUserId(request);
    await AppResolver.resolveApp(controlDb, appId, userId);

    const job = await controlDb.query(
      `SELECT id, status, log_r2_key FROM app_build_jobs
        WHERE deployment_id = $1 AND deploy_type = 'edge_ssr'
        ORDER BY created_at DESC LIMIT 1`,
      [deploymentId],
    );
    if ((job.rowCount ?? 0) === 0) {
      return reply.code(404).send(createAgentError({
        code: RESOURCE_NOT_FOUND,
        message: 'No build job found for that deployment',
        remediation: 'Verify the deployment_id is correct.',
        documentation_url: getDocUrl(RESOURCE_NOT_FOUND),
      }));
    }

    reply.raw.setHeader('content-type', 'text/event-stream');
    reply.raw.setHeader('cache-control', 'no-cache');
    reply.raw.setHeader('connection', 'keep-alive');
    reply.hijack();

    const handle = BuildDriver.getHandle(job.rows[0].id);
    if (handle) {
      // Live tail: subscribe to the in-flight build handle.
      const decoder = new StringDecoder('utf8');
      handle.subscribe({
        write: (c: Buffer) => {
          const text = decoder.write(c).replace(/\r/g, '').replace(/\n/g, '\\n');
          reply.raw.write(`data: ${text}\n\n`);
        },
        end: () => {
          const tail = decoder.end();
          if (tail) reply.raw.write(`data: ${tail.replace(/\r/g, '').replace(/\n/g, '\\n')}\n\n`);
          reply.raw.write('event: done\ndata: end\n\n');
          reply.raw.end();
        },
      });
    } else {
      // Replay from R2 (build already completed).
      const offsetParam = (request.query as { offset?: string })?.offset;
      const offset = offsetParam ? parseInt(offsetParam, 10) : 0;
      try {
        const stream = offset > 0
          ? await R2.getObjectStreamRange(job.rows[0].log_r2_key, offset)
          : await R2.getObjectStream(job.rows[0].log_r2_key);
        const replayDecoder = new StringDecoder('utf8');
        stream.on('data', (c: Buffer) => {
          const text = replayDecoder.write(c).replace(/\r/g, '').replace(/\n/g, '\\n');
          reply.raw.write(`data: ${text}\n\n`);
        });
        stream.on('end', () => {
          const tail = replayDecoder.end();
          if (tail) reply.raw.write(`data: ${tail.replace(/\r/g, '').replace(/\n/g, '\\n')}\n\n`);
          reply.raw.write('event: done\ndata: end\n\n');
          reply.raw.end();
        });
        stream.on('error', () => {
          reply.raw.write('event: error\ndata: log read error\n\n');
          reply.raw.end();
        });
      } catch {
        reply.raw.write('event: error\ndata: no logs available\n\n');
        reply.raw.end();
      }
    }
  });
}
