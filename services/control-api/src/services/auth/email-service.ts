import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import type { Pool } from 'pg';
import { config } from '../../config.js';
import { escapeHtml, renderEmailLayout, renderButton } from './email-layout.js';
import { isSilenced } from '../notification-prefs.service.js';

/**
 * Optional per-recipient extensions to a billing email:
 *   - userId enables the silence gate (snoozes + per-template unsubscribe).
 *     If omitted, the gate is skipped and the email always sends.
 *   - actionTokens, when supplied, embed inline "Snooze 24h" / "Mute" /
 *     "Unsubscribe" buttons in the HTML body. Tokens are created by the
 *     caller via createActionToken so the caller controls payload + TTL.
 *   - scope narrows the silence check (a function-scoped snooze only
 *     silences emails about that function).
 */
export interface BillingEmailOptions {
  controlPool?: Pool;
  userId?: string;
  scope?: { appId?: string; functionId?: string };
  actionTokens?: {
    snoozeFunction24h?: string;
    muteFunction?: string;
    unsubscribeTemplate?: string;
  };
}

function createSesClient(): SESClient {
  const region = config.ses.region;
  if (config.ses.accessKeyId && config.ses.secretAccessKey) {
    return new SESClient({
      region,
      credentials: {
        accessKeyId: config.ses.accessKeyId,
        secretAccessKey: config.ses.secretAccessKey,
      },
    });
  }
  return new SESClient({ region });
}

const sesClient = createSesClient();

/**
 * Build the SES `Source` header. When an app name is provided, use it as the
 * display name so end users see the app's branding rather than "Butterbase".
 * Sanitizes characters that would break RFC 5322 address parsing.
 */
function buildSource(appName?: string | null): string {
  const fromEmail = config.ses.fromEmail;
  const rawName = (appName && appName.trim()) || config.ses.fromName;
  // Strip CR/LF and the structural address chars, then quote the display name.
  const safeName = rawName.replace(/[\r\n"<>,;\\]/g, '').trim() || config.ses.fromName;
  return `"${safeName}" <${fromEmail}>`;
}

export async function sendVerificationEmail(email: string, code: string, appName?: string | null): Promise<void> {
  try {
    const command = new SendEmailCommand({
      Source: buildSource(appName),
      Destination: { ToAddresses: [email] },
      Message: {
        Subject: { Data: 'Verify your email' },
        Body: {
          Text: {
            Data: `Your verification code is: ${code}\n\nThis code expires in 24 hours.\n\nIf you didn't request this, please ignore this email.`
          }
        }
      }
    });

    await sesClient.send(command);
    console.log(`[EMAIL] Verification email sent to ${email}`);
  } catch (error) {
    // In development, fall back to console logging if AWS credentials not configured
    if (config.nodeEnv === 'development') {
      console.log(`[EMAIL] Verification code for ${email}: ${code}`);
    } else {
      throw error;
    }
  }
}

/**
 * Sends magic-link sign-in email with code
 */
export async function sendMagicLinkEmail(email: string, code: string, appName?: string | null): Promise<void> {
  try {
    const command = new SendEmailCommand({
      Source: buildSource(appName),
      Destination: { ToAddresses: [email] },
      Message: {
        Subject: { Data: 'Your sign-in code' },
        Body: {
          Text: {
            Data: `Your sign-in code is: ${code}\n\nThis code expires in 15 minutes.\n\nIf you didn't request this, please ignore this email.`
          }
        }
      }
    });

    await sesClient.send(command);
    console.log(`[EMAIL] Magic-link sign-in code sent to ${email}`);
  } catch (error) {
    if (config.nodeEnv === 'development') {
      console.log(`[EMAIL] Magic-link sign-in code for ${email}: ${code}`);
    } else {
      throw error;
    }
  }
}

/**
 * Sends password reset email with code
 */
export async function sendPasswordResetEmail(email: string, code: string, appName?: string | null): Promise<void> {
  try {
    const command = new SendEmailCommand({
      Source: buildSource(appName),
      Destination: { ToAddresses: [email] },
      Message: {
        Subject: { Data: 'Reset your password' },
        Body: {
          Text: {
            Data: `Your password reset code is: ${code}\n\nThis code expires in 1 hour.\n\nIf you didn't request this, please ignore this email.`
          }
        }
      }
    });

    await sesClient.send(command);
    console.log(`[EMAIL] Password reset email sent to ${email}`);
  } catch (error) {
    // In development, fall back to console logging if AWS credentials not configured
    if (config.nodeEnv === 'development') {
      console.log(`[EMAIL] Password reset code for ${email}: ${code}`);
    } else {
      throw error;
    }
  }
}

// ---- Billing email notifications ----

export type BillingEmailTemplate =
  | 'payment_failed'
  | 'soft_locked'
  | 'account_suspended'
  | 'overage_warning'
  | 'soft_limit_warning'
  | 'hard_limit_warning'
  | 'hard_limit_exceeded'
  | 'deployment_failed'
  | 'provisioning_failed'
  | 'function_failed'
  | 'auth_hook_failed'
  | 'auto_refill_failed'
  | 'credits_low'
  | 'credits_exhausted'
  | 'weekly_digest';

const BILLING_EMAIL_SUBJECTS: Record<BillingEmailTemplate, string> = {
  payment_failed: 'Action Required: Payment Failed',
  soft_locked: 'Account Limited: Free Plan Limits Exceeded',
  account_suspended: 'Account Suspended: Payment Required',
  overage_warning: 'Usage Alert: You Have Exceeded Your Plan Limits',
  soft_limit_warning: 'Heads up: You\'re approaching your plan limit',
  hard_limit_warning: 'Heads up: You\'re approaching your plan limit',
  hard_limit_exceeded: 'Action Required: Plan Limit Reached',
  deployment_failed: 'Deployment failed',
  provisioning_failed: 'App setup failed',
  function_failed: 'A function in your app is failing',
  auth_hook_failed: 'Your auth hook is failing',
  auto_refill_failed: 'Action Required: Auto-Refill Failed',
  credits_low: 'Your AI credits are running low',
  credits_exhausted: 'Your AI credits are exhausted',
  weekly_digest: 'Your weekly Butterbase digest',
};

export function buildBillingEmailBody(template: BillingEmailTemplate, data: Record<string, string>): string {
  const dashboardUrl = process.env.DASHBOARD_URL || 'https://dashboard.butterbase.ai';

  switch (template) {
    case 'payment_failed':
      return [
        'We were unable to process your payment.',
        '',
        `Your account will remain active until ${data.gracePeriodEndsAt || 'the end of the grace period'}.`,
        'Please update your payment method to avoid service interruption.',
        '',
        `Update payment method: ${dashboardUrl}/billing`,
        '',
        'If you believe this is an error, please contact support.',
      ].join('\n');

    case 'soft_locked':
      return [
        'Your account has been placed in read-only mode because you have exceeded your free plan limits.',
        '',
        `Violations: ${data.violations || 'See dashboard for details'}`,
        '',
        'To restore full access, either:',
        `  - Upgrade your plan: ${dashboardUrl}/billing/upgrade`,
        '  - Reduce your usage below the free plan limits',
        '',
        'While in read-only mode, you can still read and delete data, but cannot create or update.',
      ].join('\n');

    case 'account_suspended':
      return [
        'Your account has been suspended due to a payment failure that was not resolved within the grace period.',
        '',
        `Reason: ${data.reason || 'Payment failure'}`,
        '',
        `To reactivate your account, please update your payment method: ${dashboardUrl}/billing`,
        '',
        'If you need assistance, please contact support.',
      ].join('\n');

    case 'overage_warning':
      return [
        `Your ${data.meter || 'usage'} has exceeded the limit included in your plan.`,
        '',
        `Current usage: ${data.current}`,
        `Plan limit: ${data.limit}`,
        '',
        'Your service is not interrupted — overage usage will be billed at the end of your billing period at your plan\'s overage rate.',
        '',
        `View your usage and billing details: ${dashboardUrl}/billing`,
      ].join('\n');

    case 'soft_limit_warning':
      return [
        `You\'re at ${data.percentage || '80'}% of your included ${data.meter || 'usage'}.`,
        '',
        `Current usage: ${data.current}`,
        `Plan limit: ${data.limit}`,
        '',
        'Once you cross 100%, your service will continue without interruption — overage usage will be billed at your plan\'s overage rate at the end of the billing period.',
        '',
        `Review your usage: ${dashboardUrl}/billing`,
      ].join('\n');

    case 'hard_limit_warning':
      return [
        `You\'re at ${data.percentage || '80'}% of your ${data.meter || 'usage'} plan limit.`,
        '',
        `Current usage: ${data.current}`,
        `Plan limit: ${data.limit}`,
        '',
        'Once you reach 100%, this resource will be blocked until you upgrade your plan or reduce usage.',
        '',
        `Upgrade now to avoid interruption: ${dashboardUrl}/billing/upgrade`,
      ].join('\n');

    case 'hard_limit_exceeded':
      return [
        `You\'ve reached your ${data.meter || 'usage'} plan limit.`,
        '',
        `Current usage: ${data.current}`,
        `Plan limit: ${data.limit}`,
        '',
        'Further use of this resource is blocked until you upgrade your plan or reduce usage. Other resources on your account are unaffected.',
        '',
        `Upgrade your plan: ${dashboardUrl}/billing/upgrade`,
      ].join('\n');

    case 'deployment_failed':
      return [
        `A deployment for your app "${data.appName || data.appId}" failed.`,
        '',
        `Deployment ID: ${data.deploymentId}`,
        `Error: ${data.errorMessage || 'See dashboard for details'}`,
        '',
        `View deployment details: ${dashboardUrl}/apps/${data.appId}/deployments/${data.deploymentId}`,
      ].join('\n');

    case 'provisioning_failed':
      return [
        `Setup for your app "${data.appName || data.appId}" failed.`,
        '',
        `Reason: ${data.provisioningError || 'Unknown error'}`,
        '',
        'You may need to delete and recreate this app, or contact support if the problem persists.',
        '',
        `View app: ${dashboardUrl}/apps/${data.appId}`,
      ].join('\n');

    case 'weekly_digest': {
      const items = parseDigestItems(data.itemsJson);
      const deploys = parseDeployItems(data.deployItemsJson);
      if (items.length === 0 && deploys.length === 0) {
        return [
          'Nothing failed across your apps this week. Quiet weeks count.',
          '',
          `Open dashboard: ${dashboardUrl}`,
        ].join('\n');
      }
      const lines: string[] = [];
      if (items.length > 0) {
        lines.push(`Functions (${items.length}):`);
        lines.push('');
        for (const it of items) {
          lines.push(`• [${it.appName}] "${it.functionName}" — ${it.failureCount} failure${it.failureCount === 1 ? '' : 's'}`);
          if (it.lastError) lines.push(`    ${truncateError(it.lastError).split('\n')[0]}`);
          lines.push(`    ${dashboardUrl}/apps/${it.appId}/functions/${it.functionName}/logs`);
          lines.push('');
        }
      }
      if (deploys.length > 0) {
        lines.push(`Deployments (${deploys.length}):`);
        lines.push('');
        for (const d of deploys) {
          lines.push(`• [${d.appName}] ${d.kind} — ${d.failureCount} failed deploy${d.failureCount === 1 ? '' : 's'}`);
          if (d.lastError) lines.push(`    ${truncateError(d.lastError).split('\n')[0]}`);
          lines.push(`    ${dashboardUrl}/apps/${d.appId}`);
          lines.push('');
        }
      }
      lines.push(`Open dashboard: ${dashboardUrl}`);
      return lines.join('\n');
    }

    case 'function_failed': {
      const streak = data.streakLen || '3';
      const fn = data.functionName || 'a function';
      const app = data.appName || data.appId || 'your app';
      const logsUrl = `${dashboardUrl}/apps/${data.appId}/functions/${data.functionName}/logs`;
      return [
        `"${fn}" in ${app} has failed ${streak} times in a row.`,
        '',
        `Open logs: ${logsUrl}`,
        '',
        'Most recent error:',
        truncateError(data.errorMessage || '(no message captured)'),
        '',
        `We'll only email again after a successful run, then another 3 consecutive failures.`,
      ].join('\n');
    }

    case 'auth_hook_failed':
      return [
        `Your auth hook "${data.hookFunction}" in app "${data.appName || data.appId}" failed during a "${data.event}" event.`,
        '',
        `Error: ${data.errorMessage || '(no message)'}`,
        '',
        'When the auth hook fails, sign-ins still succeed but any post-auth side effects you wired into the hook (creating profile rows, syncing to external systems, etc.) did not run for the affected users.',
        '',
        '(You will receive at most one email per hook function per day for this app.)',
        '',
        `View function logs: ${dashboardUrl}/apps/${data.appId}/functions/${data.hookFunction}/logs`,
      ].join('\n');

    case 'auto_refill_failed':
      return [
        'Hi there,',
        '',
        'We tried to auto-refill your Butterbase AI credits and the charge did not go through.',
        '',
        `Amount attempted: $${data.amount_usd || '?'}`,
        `Reason: ${data.failure_reason || 'your payment method was declined'}`,
        '',
        'Auto-refill has been disabled on your account. To keep using AI features, please:',
        '',
        '1. Visit your billing settings: ' + dashboardUrl + '/billing',
        '2. Update your payment method or top up manually',
        '3. Re-enable auto-refill once your payment method is current',
        '',
        'If you have any questions, reply to this email.',
        '',
        '— The Butterbase team',
      ].join('\n');

    case 'credits_low': {
      const total = data.total_usd ?? '0.00';
      const monthly = data.monthly_allowance_usd ?? '0.00';
      const topup = data.topup_usd ?? '0.00';
      const resetDate = data.reset_date ?? '';
      const creditsLowDashboardUrl = data.dashboard_url ?? dashboardUrl;
      return [
        'Your AI credit balance is running low.',
        '',
        `Available: $${total} ($${monthly} monthly${resetDate ? ` — resets ${resetDate}` : ''} + $${topup} top-up)`,
        '',
        'AI requests will start failing once you reach $0. You can:',
        '',
        `  - Buy credits: ${creditsLowDashboardUrl}/billing?topup=open`,
        `  - Enable auto-refill: ${creditsLowDashboardUrl}/billing?autoRefill=focus`,
      ].join('\n');
    }

    case 'credits_exhausted': {
      const creditsExhaustedDashboardUrl = data.dashboard_url ?? dashboardUrl;
      return [
        'Your AI credit balance has reached $0. AI requests from your apps will fail until you add more credits.',
        '',
        `Buy credits: ${creditsExhaustedDashboardUrl}/billing?topup=open`,
        `Enable auto-refill: ${creditsExhaustedDashboardUrl}/billing?autoRefill=focus`,
        '',
        'Enabling auto-refill prevents this in the future — we\'ll charge your card automatically when your balance gets low.',
      ].join('\n');
    }
  }
}

/**
 * Send a notification email when a new suggestion is submitted.
 * Fire-and-forget: errors are logged, never thrown.
 */
export async function sendSuggestionNotification(
  to: string,
  suggestion: {
    id: string;
    category: string;
    severity: string | null;
    description: string;
    affected_tool: string | null;
    proposed_solution: string | null;
    source: string;
    user_id: string | null;
    user_email: string | null;
    app_id: string | null;
    app_name: string | null;
  }
): Promise<void> {
  const adminUrl = process.env.ADMIN_URL || 'https://admin.butterbase.ai';
  const snippet = suggestion.description.length > 60
    ? `${suggestion.description.slice(0, 60)}…`
    : suggestion.description;
  const subject = `[Suggestion] ${suggestion.category}${suggestion.severity ? ` (${suggestion.severity})` : ''}: ${snippet}`;
  const body = [
    'New suggestion submitted.',
    '',
    `Category: ${suggestion.category}`,
    `Severity: ${suggestion.severity || 'n/a'}`,
    `Source: ${suggestion.source}`,
    suggestion.affected_tool ? `Affected tool: ${suggestion.affected_tool}` : null,
    suggestion.user_email ? `User: ${suggestion.user_email} (${suggestion.user_id})` : suggestion.user_id ? `User: ${suggestion.user_id}` : null,
    suggestion.app_name ? `App: ${suggestion.app_name} (${suggestion.app_id})` : suggestion.app_id ? `App: ${suggestion.app_id}` : null,
    '',
    'Description:',
    suggestion.description,
    suggestion.proposed_solution ? '' : null,
    suggestion.proposed_solution ? 'Proposed solution:' : null,
    suggestion.proposed_solution,
    '',
    `View: ${adminUrl}/suggestions/${suggestion.id}`,
  ].filter((line): line is string => line !== null).join('\n');

  try {
    const command = new SendEmailCommand({
      Source: `${config.ses.fromName} <${config.ses.fromEmail}>`,
      Destination: { ToAddresses: [to] },
      Message: {
        Subject: { Data: subject },
        Body: { Text: { Data: body } },
      },
    });

    await sesClient.send(command);
    console.log(`[EMAIL] Suggestion notification sent to ${to} (suggestion ${suggestion.id})`);
  } catch (error) {
    if (config.nodeEnv === 'development') {
      console.log(`[EMAIL] Suggestion notification for ${to}:\n${body}`);
    } else {
      console.error(`Failed to send suggestion notification to ${to}:`, error);
    }
  }
}

const ERROR_SNIPPET_MAX = 500;
function truncateError(msg: string): string {
  if (msg.length <= ERROR_SNIPPET_MAX) return msg;
  return msg.slice(0, ERROR_SNIPPET_MAX) + '…';
}

/**
 * Optional HTML body for a billing email. Returns null for templates that
 * have not been promoted to HTML yet — SES will send text-only in that case.
 * Add a new template by adding a case here and a matching text case in
 * buildBillingEmailBody. Keep them in lockstep — same data, same message.
 */
export function buildBillingEmailHtml(
  template: BillingEmailTemplate,
  data: Record<string, string> = {},
  opts: { actionTokens?: BillingEmailOptions['actionTokens'] } = {},
): string | null {
  const dashboardUrl = process.env.DASHBOARD_URL || 'https://dashboard.butterbase.ai';

  if (template === 'weekly_digest') {
    const items = parseDigestItems(data.itemsJson);
    const deploys = parseDeployItems(data.deployItemsJson);
    const total = items.length + deploys.length;

    if (total === 0) {
      const content = `
<h1 style="margin:0 0 8px 0;font-size:20px;font-weight:600;color:#0a0a0a;">Quiet week 🌱</h1>
<p style="margin:0 0 24px 0;font-size:14px;color:#525252;line-height:1.5;">Nothing failed across your apps in the last 7 days.</p>
${renderButton({ href: dashboardUrl, label: 'Open dashboard' })}`;
      return renderEmailLayout({
        preheader: 'Nothing failed across your apps this week.',
        content,
      });
    }

    const fnRows = items.map((it) => {
      const url = `${dashboardUrl}/apps/${escapeHtml(it.appId)}/functions/${escapeHtml(it.functionName)}/logs`;
      const errLine = it.lastError ? escapeHtml(truncateError(it.lastError).split('\n')[0]) : '';
      return `<tr><td style="padding:16px 0;border-bottom:1px solid #f0f0f0;">
<div style="font-size:14px;font-weight:600;color:#0a0a0a;margin-bottom:2px;">
<a href="${url}" style="color:#0a0a0a;text-decoration:none;">&ldquo;${escapeHtml(it.functionName)}&rdquo;</a>
<span style="color:#737373;font-weight:400;"> in ${escapeHtml(it.appName)}</span>
</div>
<div style="font-size:13px;color:#737373;margin-bottom:${errLine ? '6px' : '0'};">
${escapeHtml(String(it.failureCount))} failure${it.failureCount === 1 ? '' : 's'}
</div>
${errLine ? `<div style="font-size:12px;color:#737373;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;background:#fafafa;padding:8px 10px;border-radius:6px;border:1px solid #f0f0f0;word-break:break-word;">${errLine}</div>` : ''}
</td></tr>`;
    }).join('');

    const deployRows = deploys.map((d) => {
      const url = `${dashboardUrl}/apps/${escapeHtml(d.appId)}`;
      const errLine = d.lastError ? escapeHtml(truncateError(d.lastError).split('\n')[0]) : '';
      const kindLabel = d.kind === 'edge-ssr' ? 'Edge SSR' : 'Frontend';
      return `<tr><td style="padding:16px 0;border-bottom:1px solid #f0f0f0;">
<div style="font-size:14px;font-weight:600;color:#0a0a0a;margin-bottom:2px;">
<a href="${url}" style="color:#0a0a0a;text-decoration:none;">${escapeHtml(kindLabel)} deploy</a>
<span style="color:#737373;font-weight:400;"> in ${escapeHtml(d.appName)}</span>
</div>
<div style="font-size:13px;color:#737373;margin-bottom:${errLine ? '6px' : '0'};">
${escapeHtml(String(d.failureCount))} failed deploy${d.failureCount === 1 ? '' : 's'}
</div>
${errLine ? `<div style="font-size:12px;color:#737373;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;background:#fafafa;padding:8px 10px;border-radius:6px;border:1px solid #f0f0f0;word-break:break-word;">${errLine}</div>` : ''}
</td></tr>`;
    }).join('');

    const section = (label: string, rows: string) => rows ? `
<h2 style="margin:24px 0 0 0;font-size:13px;font-weight:600;color:#737373;text-transform:uppercase;letter-spacing:0.05em;">${escapeHtml(label)}</h2>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">${rows}</table>` : '';

    const heading = total === 1
      ? '1 thing needs attention'
      : `${total} things need attention`;
    const top = items[0]
      ? `Top: "${items[0].functionName}" (${items[0].failureCount}×).`
      : deploys[0]
        ? `Top: ${deploys[0].kind} deploy in ${deploys[0].appName} (${deploys[0].failureCount}×).`
        : '';

    const content = `
<h1 style="margin:0 0 4px 0;font-size:20px;font-weight:600;color:#0a0a0a;">${escapeHtml(heading)}</h1>
<p style="margin:0 0 8px 0;font-size:14px;color:#737373;">From the last 7 days, ranked by failure count.</p>
${section('Functions', fnRows)}
${section('Deployments', deployRows)}
<p style="margin:32px 0 0 0;">${renderButton({ href: dashboardUrl, label: 'Open dashboard' })}</p>`;
    return renderEmailLayout({
      preheader: `${total} thing${total === 1 ? '' : 's'} need attention. ${top}`,
      content,
    });
  }

  if (template === 'function_failed') {
    const streak = data.streakLen || '3';
    const fn = data.functionName || 'a function';
    const app = data.appName || data.appId || 'your app';
    const errorMsg = truncateError(data.errorMessage || '(no message captured)');
    const logsUrl = `${dashboardUrl}/apps/${data.appId}/functions/${data.functionName}/logs`;

    const reArmNote = `We&rsquo;ll only email again after a successful run, then another 3 consecutive failures.`;

    // Inline action links — rendered only when tokens are supplied. Keeps
    // the buttons absent in test/dev callers that bypass the failure-notifier.
    const tokens = opts.actionTokens;
    const apiBase = process.env.PUBLIC_API_URL || 'https://api.butterbase.ai';
    const actionLinks: string[] = [];
    if (tokens?.snoozeFunction24h) {
      actionLinks.push(`<a href="${escapeHtml(`${apiBase}/v1/notif/action/${tokens.snoozeFunction24h}`)}" style="color:#525252;text-decoration:underline;">Snooze 24h</a>`);
    }
    if (tokens?.muteFunction) {
      actionLinks.push(`<a href="${escapeHtml(`${apiBase}/v1/notif/action/${tokens.muteFunction}`)}" style="color:#525252;text-decoration:underline;">Mute this function</a>`);
    }
    if (tokens?.unsubscribeTemplate) {
      actionLinks.push(`<a href="${escapeHtml(`${apiBase}/v1/notif/action/${tokens.unsubscribeTemplate}`)}" style="color:#525252;text-decoration:underline;">Unsubscribe from all function-failure emails</a>`);
    }
    const actionsBlock = actionLinks.length
      ? `<p style="margin:24px 0 0 0;font-size:13px;color:#737373;line-height:1.7;">${actionLinks.join(' &nbsp;·&nbsp; ')}</p>`
      : '';

    const content = `
<h1 style="margin:0 0 4px 0;font-size:20px;font-weight:600;line-height:1.3;letter-spacing:-0.01em;color:#0a0a0a;">
&ldquo;${escapeHtml(fn)}&rdquo; failed ${escapeHtml(streak)} times in a row
</h1>
<p style="margin:0 0 24px 0;font-size:14px;color:#737373;">in ${escapeHtml(app)}</p>
${renderButton({ href: logsUrl, label: 'Open function logs' })}
<p style="margin:32px 0 8px 0;font-size:13px;font-weight:600;color:#0a0a0a;">Most recent error</p>
<pre style="margin:0;padding:16px;background:#fafafa;border:1px solid #f0f0f0;border-radius:8px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:12px;line-height:1.5;color:#0a0a0a;white-space:pre-wrap;word-break:break-word;overflow-wrap:break-word;">${escapeHtml(errorMsg)}</pre>
<p style="margin:24px 0 0 0;font-size:13px;color:#737373;line-height:1.5;">${reArmNote}</p>${actionsBlock}`;

    return renderEmailLayout({
      preheader: `"${fn}" failed ${streak} times in a row in ${app}. Open logs to investigate.`,
      content,
    });
  }

  return null;
}

/**
 * Subject line for a billing email. Most templates use the static map;
 * function_failed builds the subject from the data so the inbox preview
 * shows app, function, and count without the user opening the email.
 */
export function buildBillingEmailSubject(
  template: BillingEmailTemplate,
  data: Record<string, string> = {},
): string {
  if (template === 'function_failed') {
    const app = data.appName || data.appId || 'your app';
    const fn = data.functionName || 'a function';
    const streak = data.streakLen || '3';
    return `[${app}] "${fn}" failed ${streak} times in a row`;
  }
  if (template === 'weekly_digest') {
    const total = digestTotalCount(data);
    if (total === 0) return 'Your weekly Butterbase digest';
    if (total === 1) return 'Your weekly digest: 1 thing needs attention';
    return `Your weekly digest: ${total} things need attention`;
  }
  return BILLING_EMAIL_SUBJECTS[template];
}

export interface DigestItem {
  appId: string;
  appName: string;
  functionName: string;
  failureCount: number;
  lastError: string;
}

export interface DigestDeployItem {
  appId: string;
  appName: string;
  failureCount: number;
  lastError: string;
  kind: 'frontend' | 'edge-ssr';
}

function parseDigestItems(json: string | undefined): DigestItem[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.slice(0, 20) : [];
  } catch {
    return [];
  }
}

function parseDeployItems(json: string | undefined): DigestDeployItem[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.slice(0, 20) : [];
  } catch {
    return [];
  }
}

/**
 * Total surface count for the digest subject line. Used so the subject
 * reflects the union ("3 things need attention") rather than just one
 * dimension.
 */
function digestTotalCount(data: Record<string, string>): number {
  return parseDigestItems(data.itemsJson).length + parseDeployItems(data.deployItemsJson).length;
}

/**
 * Send a billing-related email notification.
 * Falls back to console logging in development.
 */
export async function sendBillingEmail(
  to: string,
  template: BillingEmailTemplate,
  data: Record<string, string> = {},
  opts: BillingEmailOptions = {},
): Promise<void> {
  // Silence gate. Opt-in: callers that pass userId + controlPool get the
  // user's snoozes and unsubscribes applied. Existing callers that don't
  // pass these (most billing paths) keep current always-send behavior.
  if (opts.controlPool && opts.userId) {
    const silenced = await isSilenced(opts.controlPool, opts.userId, template, opts.scope);
    if (silenced) {
      console.log(`[EMAIL] Skipped ${template} for ${to} (user has active silence)`);
      return;
    }
  }

  const subject = buildBillingEmailSubject(template, data);
  const body = buildBillingEmailBody(template, data);
  const html = buildBillingEmailHtml(template, data, { actionTokens: opts.actionTokens });

  try {
    const command = new SendEmailCommand({
      Source: `${config.ses.fromName} <${config.ses.fromEmail}>`,
      Destination: { ToAddresses: [to] },
      Message: {
        Subject: { Data: subject },
        // Dual-body when an HTML variant exists — clients that prefer text
        // (Apple Mail "Load Remote Content" off, etc.) still get the text
        // version. SES handles multipart/alternative selection.
        Body: html
          ? { Text: { Data: body }, Html: { Data: html } }
          : { Text: { Data: body } },
      },
    });

    await sesClient.send(command);
    console.log(`[EMAIL] Billing email (${template}) sent to ${to}`);
  } catch (error) {
    if (config.nodeEnv === 'development') {
      console.log(`[EMAIL] Billing email (${template}) for ${to}:\n${body}`);
    } else {
      console.error(`Failed to send billing email (${template}) to ${to}:`, error);
      // Don't throw — billing emails should not block webhook processing
    }
  }
}

const STATUS_LABELS: Record<string, string> = {
  new: 'New',
  acknowledged: 'Acknowledged',
  in_progress: 'In Progress',
  implemented: 'Implemented',
  wont_fix: "Won't Fix",
};

/**
 * Notify a suggestion submitter that an admin has changed the suggestion's status.
 * Fire-and-forget: errors are logged, never thrown.
 */
export async function sendSuggestionStatusUpdateEmail(
  to: string,
  suggestion: {
    id: string;
    description: string;
    status: string;
  }
): Promise<void> {
  const label = STATUS_LABELS[suggestion.status] ?? suggestion.status;
  const snippet = suggestion.description.length > 60
    ? `${suggestion.description.slice(0, 60)}…`
    : suggestion.description;
  const subject = `Your suggestion has been updated: ${label}`;
  const body = [
    `Your suggestion status has been updated to: ${label}`,
    '',
    'Suggestion:',
    snippet,
    '',
    `Status: ${label}`,
    '',
    'Thank you for helping improve Butterbase.',
    '',
    `— The Butterbase Team`,
  ].join('\n');

  try {
    const command = new SendEmailCommand({
      Source: `${config.ses.fromName} <${config.ses.fromEmail}>`,
      Destination: { ToAddresses: [to] },
      Message: {
        Subject: { Data: subject },
        Body: { Text: { Data: body } },
      },
    });

    await sesClient.send(command);
    console.log(`[EMAIL] Suggestion status update sent to ${to} (suggestion ${suggestion.id}, status: ${suggestion.status})`);
  } catch (error) {
    if (config.nodeEnv === 'development') {
      console.log(`[EMAIL] Suggestion status update for ${to} (${suggestion.id}):\n${body}`);
    } else {
      console.error(`Failed to send suggestion status update to ${to}:`, error);
    }
  }
}
