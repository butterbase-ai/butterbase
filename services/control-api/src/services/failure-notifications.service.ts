// services/control-api/src/services/failure-notifications.service.ts
//
// Single entry point for sending app/deployment failure emails to users.
// Handles Redis dedup and silently skips users without an email on file
// (OAuth-only signups). Reuses sendBillingEmail for the actual SES call.
//
// Phase 2 multi-region: apps is a runtime table; platform_users is control-tier.
// getOwnerEmailAndAppName now accepts both pools and splits the former cross-tier
// JOIN into two separate queries (apps on runtimePool, platform_users on controlPool).

import type { Pool } from 'pg';
import { getRedisClient } from './redis.js';
import { sendBillingEmail } from './auth/email-service.js';
import { createActionToken } from './notification-prefs.service.js';

const NOTIF_TTL_SECONDS = 35 * 24 * 60 * 60; // 35 days, mirrors quota notifs

export const FUNCTION_FAILURE_STREAK_THRESHOLD = 3;

interface OwnerInfo {
  email: string;
  appName: string;
  userId: string;
}

/**
 * Phase 2 multi-region: split cross-tier JOIN into two queries.
 * apps lives in the runtime DB; platform_users lives in the control DB.
 */
async function getOwnerEmailAndAppName(
  controlPool: Pool,
  runtimePool: Pool,
  appId: string,
): Promise<OwnerInfo | null> {
  // 1. Fetch app name + owner_id from runtime DB
  const appRow = await runtimePool.query(
    `SELECT owner_id, name AS app_name FROM apps WHERE id = $1`,
    [appId],
  );
  if (appRow.rows.length === 0) return null;
  const { owner_id, app_name } = appRow.rows[0];

  // 2. Fetch owner email from control DB
  const userRow = await controlPool.query(
    `SELECT email FROM platform_users WHERE id = $1`,
    [owner_id],
  );
  if (userRow.rows.length === 0) return null;
  const { email } = userRow.rows[0];
  if (!email) return null;
  return { email, appName: app_name ?? appId, userId: owner_id };
}

/**
 * Deployment failed — synchronous, called from deployment.service.ts.
 * Dedup key: failure_notif:deploy:{deploymentId} — once per deployment attempt.
 */
export async function notifyDeploymentFailed(
  controlPool: Pool,
  runtimePool: Pool,
  args: { appId: string; deploymentId: string; errorMessage: string },
  log?: { warn: (payload: Record<string, unknown>, message: string) => void }
): Promise<void> {
  const key = `failure_notif:deploy:${args.deploymentId}`;
  try {
    const wasSet = await getRedisClient().set(key, '1', 'EX', NOTIF_TTL_SECONDS, 'NX');
    if (!wasSet) return;

    const owner = await getOwnerEmailAndAppName(controlPool, runtimePool, args.appId);
    if (!owner) {
      log?.warn({ appId: args.appId, deploymentId: args.deploymentId }, 'failure-notifications: skipped (no owner email)');
      // Roll back the dedup key so a future email can still fire if the user adds an email.
      await getRedisClient().del(key).catch(() => {});
      return;
    }

    await sendBillingEmail(owner.email, 'deployment_failed', {
      appId: args.appId,
      appName: owner.appName,
      deploymentId: args.deploymentId,
      errorMessage: args.errorMessage,
    }, {
      controlPool,
      userId: owner.userId,
      scope: { appId: args.appId },
    }).catch((err) => {
      log?.warn({ err, appId: args.appId, deploymentId: args.deploymentId }, 'failure-notifications: send failed');
    });
  } catch {
    // Notifications must never block their callers
  }
}

/**
 * App provisioning failed — synchronous, called from provisioner.ts and neon-task-worker.ts.
 * Dedup key: failure_notif:provision:{appId}:{UTC date} — once per app per day.
 */
export async function notifyProvisioningFailed(
  controlPool: Pool,
  runtimePool: Pool,
  args: { appId: string; provisioningError: string },
  log?: { warn: (payload: Record<string, unknown>, message: string) => void }
): Promise<void> {
  const date = new Date().toISOString().slice(0, 10);
  const key = `failure_notif:provision:${args.appId}:${date}`;
  try {
    const wasSet = await getRedisClient().set(key, '1', 'EX', NOTIF_TTL_SECONDS, 'NX');
    if (!wasSet) return;

    const owner = await getOwnerEmailAndAppName(controlPool, runtimePool, args.appId);
    if (!owner) {
      log?.warn({ appId: args.appId }, 'failure-notifications: provisioning skipped (no owner email)');
      await getRedisClient().del(key).catch(() => {});
      return;
    }

    await sendBillingEmail(owner.email, 'provisioning_failed', {
      appId: args.appId,
      appName: owner.appName,
      provisioningError: args.provisioningError,
    }).catch((err) => {
      log?.warn({ err, appId: args.appId }, 'failure-notifications: provisioning send failed');
    });
  } catch {
    // Swallow
  }
}

/**
 * Function failure — called from the failure-notifier scanner once per
 * consecutive-failure streak (>= FUNCTION_FAILURE_STREAK_THRESHOLD). Dedup
 * is enforced by the scanner (keyed on the last-success timestamp so the
 * key rotates after a successful run); this function just sends the email.
 * The owner-email check is done here so the scanner stays focused on its loop.
 */
export async function notifyFunctionFailed(
  controlPool: Pool,
  runtimePool: Pool,
  args: {
    appId: string;
    functionId: string;
    functionName: string;
    errorMessage: string;
    streakLen: number;
  },
  log?: { warn: (payload: Record<string, unknown>, message: string) => void }
): Promise<void> {
  try {
    const owner = await getOwnerEmailAndAppName(controlPool, runtimePool, args.appId);
    if (!owner) {
      log?.warn({ appId: args.appId, functionId: args.functionId }, 'failure-notifications: function skipped (no owner email)');
      return;
    }

    // Mint one-shot action tokens for the inline buttons. Failures here
    // are non-fatal — we still send the email without the buttons rather
    // than blocking delivery.
    let actionTokens: { snoozeFunction24h?: string; muteFunction?: string; unsubscribeTemplate?: string } | undefined;
    try {
      const [snooze, mute, unsub] = await Promise.all([
        createActionToken(controlPool, {
          userId: owner.userId,
          action: 'snooze_function_24h',
          payload: { functionId: args.functionId },
        }),
        createActionToken(controlPool, {
          userId: owner.userId,
          action: 'mute_function',
          payload: { functionId: args.functionId },
        }),
        createActionToken(controlPool, {
          userId: owner.userId,
          action: 'unsubscribe_template',
          payload: { template: 'function_failed' },
        }),
      ]);
      actionTokens = { snoozeFunction24h: snooze, muteFunction: mute, unsubscribeTemplate: unsub };
    } catch (err) {
      log?.warn({ err, appId: args.appId, functionId: args.functionId }, 'failure-notifications: token mint failed (sending without action buttons)');
    }

    await sendBillingEmail(owner.email, 'function_failed', {
      appId: args.appId,
      appName: owner.appName,
      functionName: args.functionName,
      errorMessage: args.errorMessage,
      streakLen: String(args.streakLen),
    }, {
      controlPool,
      userId: owner.userId,
      scope: { appId: args.appId, functionId: args.functionId },
      actionTokens,
    }).catch((err) => {
      log?.warn({ err, appId: args.appId, functionId: args.functionId }, 'failure-notifications: function send failed');
    });
  } catch {
    // Swallow
  }
}

/**
 * Auth hook invocation failed — called from auth-hook-service when the hook
 * fetch errors or returns a non-2xx response. Dedup key:
 * failure_notif:auth_hook:{appId}:{hookFunction}:{UTC date} — once per
 * (app, hook function, day).
 */
export async function notifyAuthHookFailed(
  controlPool: Pool,
  runtimePool: Pool,
  args: {
    appId: string;
    hookFunction: string;
    event: string;
    errorMessage: string;
  },
  log?: { warn: (payload: Record<string, unknown>, message: string) => void }
): Promise<void> {
  const date = new Date().toISOString().slice(0, 10);
  const key = `failure_notif:auth_hook:${args.appId}:${args.hookFunction}:${date}`;
  try {
    const wasSet = await getRedisClient().set(key, '1', 'EX', NOTIF_TTL_SECONDS, 'NX');
    if (!wasSet) return;

    const owner = await getOwnerEmailAndAppName(controlPool, runtimePool, args.appId);
    if (!owner) {
      log?.warn({ appId: args.appId, hookFunction: args.hookFunction }, 'failure-notifications: auth hook skipped (no owner email)');
      await getRedisClient().del(key).catch(() => {});
      return;
    }

    await sendBillingEmail(owner.email, 'auth_hook_failed', {
      appId: args.appId,
      appName: owner.appName,
      hookFunction: args.hookFunction,
      event: args.event,
      errorMessage: args.errorMessage,
    }).catch((err) => {
      log?.warn({ err, appId: args.appId, hookFunction: args.hookFunction }, 'failure-notifications: auth hook send failed');
    });
  } catch {
    // Swallow
  }
}
