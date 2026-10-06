import { SESClient, SendEmailCommand, SendRawEmailCommand } from '@aws-sdk/client-ses';
import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { config } from '../../config.js';
import { escapeHtml, renderEmailLayout, renderButton, renderAppEmailLayout, renderCodeBox, renderNotice } from './email-layout.js';
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

/**
 * Outcome of sendBillingEmail. It never throws (billing emails must not block
 * webhook processing), so callers that hold a dedup key check for 'failed'
 * and release the key so the next attempt can retry.
 *   - sent:     handed to SES
 *   - silenced: the recipient's snooze/unsubscribe suppressed it (not an error)
 *   - logged:   SES failed and the dev console fallback printed it instead
 *   - failed:   SES rejected or errored
 */
export type BillingEmailResult = 'sent' | 'silenced' | 'logged' | 'failed';

function notifActionUrl(token: string): string {
  const apiBase = process.env.PUBLIC_API_URL || 'https://api.butterbase.ai';
  return `${apiBase}/v1/notif/action/${token}`;
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

/** Attach SES_CONFIGURATION_SET (when configured) to a send request. */
function withConfigurationSet<T extends object>(input: T): T & { ConfigurationSetName?: string } {
  return config.ses.configurationSet
    ? { ...input, ConfigurationSetName: config.ses.configurationSet }
    : input;
}

// ---- Raw MIME (only for sends that need custom headers) ----
//
// SES v1 SendEmailCommand cannot set arbitrary headers, and List-Unsubscribe
// needs them. Rather than add @aws-sdk/client-sesv2 (a new dependency in two
// lockfiles) we build the small multipart/alternative message ourselves and
// send it with SendRawEmailCommand from the client we already have. Only
// emails that carry custom headers take this path.

function stripCrlf(v: string): string {
  return v.replace(/[\r\n]+/g, ' ');
}

/** RFC 2047 encode a header value when it has non-ASCII characters. */
function encodeHeaderValue(v: string): string {
  const clean = stripCrlf(v);
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(clean)) return clean;
  // Chunk by code point so no encoded-word splits a UTF-8 sequence; ~40 chars
  // keeps each encoded-word under the 75-char limit.
  const chars = Array.from(clean);
  const words: string[] = [];
  for (let i = 0; i < chars.length; i += 40) {
    words.push(`=?UTF-8?B?${Buffer.from(chars.slice(i, i + 40).join(''), 'utf8').toString('base64')}?=`);
  }
  return words.join('\r\n ');
}

/** `"Display Name" <addr>` with the display name encoded if needed. */
function encodeAddress(source: string): string {
  const m = source.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (!m) return stripCrlf(source);
  const name = m[1].trim();
  return name ? `${encodeHeaderValue(name.includes(',') ? `"${name}"` : name)} <${stripCrlf(m[2])}>` : `<${stripCrlf(m[2])}>`;
}

function base64Body(s: string): string {
  return (Buffer.from(s, 'utf8').toString('base64').match(/.{1,76}/g) ?? ['']).join('\r\n');
}

export function buildRawMimeMessage(msg: {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string | null;
  headers?: Record<string, string>;
}): string {
  const head = [
    `From: ${encodeAddress(msg.from)}`,
    `To: ${stripCrlf(msg.to)}`,
    `Subject: ${encodeHeaderValue(msg.subject)}`,
    'MIME-Version: 1.0',
    ...Object.entries(msg.headers ?? {}).map(([k, v]) => `${stripCrlf(k)}: ${stripCrlf(v)}`),
  ];
  const textPart = ['Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', base64Body(msg.text)];
  if (!msg.html) {
    return [...head, ...textPart, ''].join('\r\n');
  }
  const boundary = `bb_${randomBytes(12).toString('hex')}`;
  return [
    ...head,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    ...textPart,
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Body(msg.html),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

/**
 * Turn a stored app name into something fit to show an end user. The apps
 * table has only `name` (no separate display name or logo), and in practice
 * it is often a slug like `acme-notes`. Slug-shaped names (lowercase
 * alphanumerics joined by `-`/`_`) are title-cased (`Acme Notes`);
 * anything else (e.g. `My App`, `myApp`) is kept as the developer wrote it.
 * Control characters are stripped. Returns null when nothing usable remains.
 */
export function formatAppDisplayName(appName?: string | null): string | null {
  if (!appName) return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = appName.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  if (/^[a-z0-9]+(?:[-_]+[a-z0-9]+)*$/.test(cleaned)) {
    return cleaned
      .split(/[-_]+/)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }
  return cleaned;
}

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

type AuthCodeKind = 'verification' | 'magic_link' | 'password_reset';

interface AuthCodeCopy {
  /** Noun phrase used in the subject, e.g. "sign-in code". */
  codeLabel: string;
  heading: string;
  /** Sentence fragment, completed with " {introJoin} {App}." or "." */
  intro: string;
  introJoin: 'to' | 'for';
  expiry: string;
}

const AUTH_CODE_COPY: Record<AuthCodeKind, AuthCodeCopy> = {
  verification: {
    codeLabel: 'verification code',
    heading: 'Verify your email',
    intro: 'Use this code to verify your email address',
    introJoin: 'for',
    expiry: '24 hours',
  },
  magic_link: {
    codeLabel: 'sign-in code',
    heading: 'Your sign-in code',
    intro: 'Use this code to sign in',
    introJoin: 'to',
    expiry: '15 minutes',
  },
  password_reset: {
    codeLabel: 'password reset code',
    heading: 'Reset your password',
    intro: 'Use this code to reset your password',
    introJoin: 'for',
    expiry: '1 hour',
  },
};

export interface AuthCodeEmail {
  subject: string;
  text: string;
  html: string;
}

/**
 * Build subject / text / HTML for an end-user auth code email. The code is in
 * the subject ("Your Acme Notes sign-in code is 558817"): that is what
 * lets Gmail show its "Copy code" card and keeps successive codes from
 * threading into one conversation.
 */
export function buildAuthCodeEmail(kind: AuthCodeKind, code: string, appName?: string | null): AuthCodeEmail {
  const copy = AUTH_CODE_COPY[kind];
  const name = formatAppDisplayName(appName);
  const codeLabel = name ? `${name} ${copy.codeLabel}` : copy.codeLabel;
  const subject = `Your ${codeLabel} is ${code}`;
  const intro = name ? `${copy.intro} ${copy.introJoin} ${name}.` : `${copy.intro}.`;
  const expiryLine = `This code expires in ${copy.expiry}.`;
  const ignoreLine = "If you didn't request this, you can safely ignore this email.";

  const text = [
    `Your ${codeLabel} is: ${code}`,
    '',
    intro,
    '',
    expiryLine,
    '',
    ignoreLine,
  ].join('\n');

  const content = [
    `<h1 style="margin:0 0 12px;font-size:22px;font-weight:700;line-height:1.3;color:#0a0a0a;">${escapeHtml(copy.heading)}</h1>`,
    `<p style="margin:0;font-size:15px;line-height:1.6;color:#404040;">${escapeHtml(intro)}</p>`,
    renderCodeBox(code),
    `<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#404040;">${escapeHtml(expiryLine)}</p>`,
    `<p style="margin:0;font-size:13px;line-height:1.6;color:#737373;">${escapeHtml(ignoreLine)}</p>`,
  ].join('\n');

  const html = renderAppEmailLayout({
    appName: name,
    preheader: `${subject}. ${expiryLine}`,
    content,
  });

  return { subject, text, html };
}

async function sendAuthCodeEmail(
  kind: AuthCodeKind,
  email: string,
  code: string,
  appName: string | null | undefined,
  logLabel: string,
): Promise<void> {
  try {
    const { subject, text, html } = buildAuthCodeEmail(kind, code, appName);
    const command = new SendEmailCommand(withConfigurationSet({
      Source: buildSource(formatAppDisplayName(appName)),
      Destination: { ToAddresses: [email] },
      Message: {
        Subject: { Data: subject, Charset: 'UTF-8' },
        Body: {
          Html: { Data: html, Charset: 'UTF-8' },
          Text: { Data: text, Charset: 'UTF-8' },
        },
      },
    }));

    await sesClient.send(command);
    console.log(`[EMAIL] ${logLabel} sent to ${email}`);
  } catch (error) {
    // In development, fall back to console logging if AWS credentials not configured
    if (config.ses.devConsoleFallback) {
      console.log(`[EMAIL] ${logLabel} for ${email}: ${code}`);
    } else {
      throw error;
    }
  }
}

/**
 * Sends email-verification code
 */
export async function sendVerificationEmail(email: string, code: string, appName?: string | null): Promise<void> {
  await sendAuthCodeEmail('verification', email, code, appName, 'Verification code');
}

/**
 * Sends magic-link sign-in email with code
 */
export async function sendMagicLinkEmail(email: string, code: string, appName?: string | null): Promise<void> {
  await sendAuthCodeEmail('magic_link', email, code, appName, 'Magic-link sign-in code');
}

/**
 * Sends password reset email with code
 */
export async function sendPasswordResetEmail(email: string, code: string, appName?: string | null): Promise<void> {
  await sendAuthCodeEmail('password_reset', email, code, appName, 'Password reset code');
}

// ---- Billing email notifications ----

export type BillingEmailTemplate =
  | 'payment_failed'
  | 'plan_downgraded'
  | 'soft_locked'
  | 'account_suspended'
  | 'overage_warning'
  | 'soft_limit_warning'
  | 'hard_limit_warning'
  | 'hard_limit_exceeded'
  | 'deployment_failed'
  | 'provisioning_failed'
  | 'clone_failed'
  | 'clone_failed_ops'
  | 'clone_reaper_digest'
  | 'function_failed'
  | 'auth_hook_failed'
  | 'auto_refill_failed'
  | 'credits_low'
  | 'credits_exhausted'
  | 'org_balance_low_ops'
  | 'meetings_webhook_missed_ops'
  | 'weekly_digest';

const BILLING_EMAIL_SUBJECTS: Record<BillingEmailTemplate, string> = {
  payment_failed: 'Action Required: Payment Failed',
  plan_downgraded: 'Your Butterbase plan was downgraded',
  soft_locked: 'Account Limited: Free Plan Limits Exceeded',
  account_suspended: 'Account Suspended: Payment Required',
  overage_warning: 'Usage Alert: You Have Exceeded Your Plan Limits',
  soft_limit_warning: 'Heads up: You\'re approaching your plan limit',
  hard_limit_warning: 'Heads up: You\'re approaching your plan limit',
  hard_limit_exceeded: 'Action Required: Plan Limit Reached',
  deployment_failed: 'Deployment failed',
  provisioning_failed: 'App setup failed',
  clone_failed: 'Clone failed',
  clone_failed_ops: '[butterbase] Clone failed',
  clone_reaper_digest: '[butterbase] Clone reaper flipped stuck jobs to failed',
  function_failed: 'A function in your app is failing',
  auth_hook_failed: 'Your auth hook is failing',
  auto_refill_failed: 'Action Required: Auto-Refill Failed',
  credits_low: 'Your AI credits are running low',
  credits_exhausted: 'Your AI credits are exhausted',
  org_balance_low_ops: '[butterbase] Orgs low on credits',
  meetings_webhook_missed_ops: '[butterbase] Meeting bots missed by the webhook',
  weekly_digest: 'Your weekly Butterbase digest',
};

/**
 * Render a date for humans ("October 13, 2026"). Accepts a Date or an
 * ISO-8601 string; anything else is returned unchanged, so a caller that
 * already formatted the value ("May 31") is not mangled — `new Date('May 31')`
 * would happily invent a year. Always UTC: the server has no idea where the
 * recipient is, and a fixed zone keeps the date stable across hosts.
 */
export function formatEmailDate(value: string | Date | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  if (!(value instanceof Date) && !/^\d{4}-\d{2}-\d{2}/.test(value)) return value;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

/**
 * Human labels for the raw meter keys quota-enforcement passes in `data.meter`.
 * Lower-case so they read naturally mid-sentence; `capitalize` for subjects.
 */
const METER_LABELS: Record<string, string> = {
  ai_credits: 'AI credits',
  ai_tokens: 'AI tokens',
  api_calls: 'API calls',
  storage_bytes: 'storage',
  bandwidth_bytes: 'bandwidth',
  lambda_invocations: 'function invocations',
  mau: 'monthly active users',
  do_requests: 'Durable Object requests',
  do_cpu_ms: 'Durable Object CPU time',
  do_storage_gb_seconds: 'Durable Object storage',
  kv_ops: 'KV operations',
  kv_storage_bytes: 'KV storage',
  people_credits: 'People credits',
};

export function meterLabel(meter: string | undefined): string {
  if (!meter) return 'usage';
  return METER_LABELS[meter] ?? meter.replace(/_/g, ' ');
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Byte meters arrive as raw integers ("5368709120"); show them as "5 GB". */
function formatMeterValue(meter: string | undefined, value: string | undefined): string {
  if (value === undefined || value === '') return '';
  if (meter && /_bytes$/.test(meter) && /^\d+(\.\d+)?$/.test(value)) {
    const n = Number(value);
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${Number.isInteger(v) ? v : v.toFixed(2)} ${units[i]}`;
  }
  return value;
}

/** Meter keys named in a soft_locked violations string ("mau: 50/10, bandwidth: 2GB/1GB"). */
function violationMeters(violations: string | undefined): string[] {
  if (!violations) return [];
  return violations.split(',').map((v) => v.split(':')[0].trim()).filter(Boolean);
}

export function buildBillingEmailBody(template: BillingEmailTemplate, data: Record<string, string>): string {
  const dashboardUrl = process.env.DASHBOARD_URL || 'https://dashboard.butterbase.ai';

  switch (template) {
    case 'payment_failed':
      return [
        'We were unable to process your payment.',
        '',
        `Your account will remain active until ${formatEmailDate(data.gracePeriodEndsAt) || 'the end of the grace period'}.`,
        'Please update your payment method to avoid service interruption.',
        '',
        `Update payment method: ${dashboardUrl}/billing`,
        '',
        'If you believe this is an error, please contact support.',
      ].join('\n');

    // Grace period ran out on a past_due subscription: the subscription was
    // canceled and the account moved to the free plan. Distinct from
    // payment_failed, which is sent while the account is still active.
    case 'plan_downgraded':
      return [
        'We still could not collect payment for your Butterbase subscription, and the grace period'
          + (data.gracePeriodEndedAt ? ` ended on ${formatEmailDate(data.gracePeriodEndedAt)}.` : ' has ended.'),
        '',
        'Your subscription has been canceled and your account is now on the free Playground plan.',
        'Your apps and data are still there, but Playground plan limits now apply, and anything',
        'over those limits may be restricted.',
        '',
        `To restore your plan, update your payment method and resubscribe: ${dashboardUrl}/billing`,
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
        `Your ${meterLabel(data.meter)} usage has exceeded the limit included in your plan.`,
        '',
        `Current usage: ${formatMeterValue(data.meter, data.current)}`,
        `Plan limit: ${formatMeterValue(data.meter, data.limit)}`,
        '',
        'Your service is not interrupted — overage usage will be billed at the end of your billing period at your plan\'s overage rate.',
        '',
        `View your usage and billing details: ${dashboardUrl}/billing`,
      ].join('\n');

    case 'soft_limit_warning':
      return [
        `You\'re at ${data.percentage || '80'}% of your included ${meterLabel(data.meter)}.`,
        '',
        `Current usage: ${formatMeterValue(data.meter, data.current)}`,
        `Plan limit: ${formatMeterValue(data.meter, data.limit)}`,
        '',
        'Once you cross 100%, your service will continue without interruption — overage usage will be billed at your plan\'s overage rate at the end of the billing period.',
        '',
        `Review your usage: ${dashboardUrl}/billing`,
      ].join('\n');

    case 'hard_limit_warning':
      return [
        `You\'re at ${data.percentage || '80'}% of your ${meterLabel(data.meter)} plan limit.`,
        '',
        `Current usage: ${formatMeterValue(data.meter, data.current)}`,
        `Plan limit: ${formatMeterValue(data.meter, data.limit)}`,
        '',
        'Once you reach 100%, this resource will be blocked until you upgrade your plan or reduce usage.',
        '',
        `Upgrade now to avoid interruption: ${dashboardUrl}/billing/upgrade`,
      ].join('\n');

    case 'hard_limit_exceeded':
      return [
        `You\'ve reached your ${meterLabel(data.meter)} plan limit.`,
        '',
        `Current usage: ${formatMeterValue(data.meter, data.current)}`,
        `Plan limit: ${formatMeterValue(data.meter, data.limit)}`,
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

    case 'clone_failed': {
      const stageLine = data.stalledStage
        ? `Stalled at stage: ${data.stalledStage}`
        : '';
      if (data.mode === 'update') {
        return [
          `We couldn't finish updating "${data.appName || data.appId}" to the latest release of template ${data.sourceAppId}.`,
          '',
          `Job ID: ${data.jobId}`,
          stageLine,
          `Error: ${data.errorMessage || '(no message captured)'}`,
          '',
          'Your data was not touched — an update never drops or rewrites your rows. The app may be',
          'part-way between its old code and the new release. You can:',
          `  • Review the app and undo the update: ${dashboardUrl}/apps/${data.appId}`,
          `  • Contact support if this keeps happening.`,
        ].filter(Boolean).join('\n');
      }
      // A stranded promote writes onto a LIVE production app, not a fresh
      // destination — the clone/update copy below is wrong on every count
      // (there's no "partial app" to delete, and "try again" undersells that
      // production may be mid-write).
      if (data.mode === 'promote') {
        return [
          `We couldn't finish promoting your staging environment onto "${data.appName || data.appId}", your live production app.`,
          '',
          `Job ID: ${data.jobId}`,
          stageLine,
          `Error: ${data.errorMessage || '(no message captured)'}`,
          '',
          'This app may be part-way between its old state and the promoted staging state. Please review it now:',
          `  • Review the app: ${dashboardUrl}/apps/${data.appId}`,
          `  • Contact support if this keeps happening.`,
        ].filter(Boolean).join('\n');
      }
      // A stranded staging_reset touches an existing staging app's code AND
      // data (it re-seeds from production) — different enough from a fresh
      // clone that "delete the partial app" and "try cloning again" don't fit.
      if (data.mode === 'staging_reset') {
        return [
          `We couldn't finish resetting your staging environment "${data.appName || data.appId}" from production app ${data.sourceAppId}.`,
          '',
          `Job ID: ${data.jobId}`,
          stageLine,
          `Error: ${data.errorMessage || '(no message captured)'}`,
          '',
          "Your staging app's code and data may be part-way through being replaced from production. You can:",
          `  • Open the staging app and try the reset again: ${dashboardUrl}/apps/${data.appId}`,
          `  • Contact support if this keeps happening.`,
        ].filter(Boolean).join('\n');
      }
      // 'clone' and 'staging_create' share this copy: a staging_create job is,
      // mechanically, a clone onto a fresh app (see executeClone dispatch in
      // neon-task-worker.ts), so the same "destination was created, code may
      // be incomplete" framing is accurate for both.
      return [
        `We couldn't finish cloning "${data.appName || data.appId}" from template ${data.sourceAppId}.`,
        '',
        `Job ID: ${data.jobId}`,
        stageLine,
        `Error: ${data.errorMessage || '(no message captured)'}`,
        '',
        'The destination app was created but the code (frontend + functions) may not be fully in place. You can:',
        `  • Try cloning again: ${dashboardUrl}/templates`,
        `  • Delete the partial app: ${dashboardUrl}/apps/${data.appId}`,
        `  • Contact support if this keeps happening.`,
      ].filter(Boolean).join('\n');
    }

    // Ops-only twin of clone_failed. Sent to OPS_ALERT_EMAIL; carries the
    // identifiers an operator needs and none of the customer's CTAs.
    case 'clone_failed_ops':
      return [
        `A ${data.mode || 'clone'} job failed.`,
        '',
        `Job ID: ${data.jobId || '(unknown)'}`,
        `Mode: ${data.mode || 'clone'}`,
        `App: ${data.appName ? `${data.appName} (${data.appId})` : data.appId || '(unknown)'}`,
        `Source app: ${data.sourceAppId || '(unknown)'}`,
        `Organization: ${data.organizationId || '(unknown)'}`,
        `Owner: ${data.ownerEmail || '(no owner email on file)'}`,
        data.stalledStage ? `Stalled at stage: ${data.stalledStage}` : null,
        '',
        'Error:',
        truncateError(data.errorMessage || '(no message captured)'),
        '',
        data.ownerEmail
          ? 'The owner has been sent a clone_failed email (unless they have silenced it).'
          : 'No owner email on file, so nobody outside ops has been told.',
      ].filter((line): line is string => line !== null).join('\n');

    case 'clone_reaper_digest': {
      let details: Array<{ jobId: string; destAppId: string | null; stalledStage: string; ageMinutes: number }> = [];
      try {
        details = JSON.parse(data.detailsJson || '[]');
      } catch {
        // Fall through with empty list — the reapedCount is still informative.
      }
      const lines: string[] = [
        `The clone-jobs reaper marked ${data.reapedCount} stuck job(s) as failed this tick.`,
        '',
        'This usually means a control-api instance died mid-pipeline (deploy, OOM, or unhandled exception past the neon_tasks max_attempts).',
        '',
      ];
      for (const d of details) {
        lines.push(`• ${d.jobId} → ${d.destAppId ?? '(no dest)'} — stalled at ${d.stalledStage} (${d.ageMinutes}m)`);
      }
      lines.push('');
      lines.push('Users have been notified individually via clone_failed emails.');
      return lines.join('\n');
    }

    // Ops-only. Sent to OPS_ALERT_EMAIL by low-balance-notifier, never to a
    // customer — it names other organizations, so it must never be wired to a
    // user-facing recipient.
    case 'org_balance_low_ops': {
      interface LowOrg { id: string; name: string; planId: string; balanceUsd: number; cutOff: boolean }
      let orgs: LowOrg[] = [];
      try {
        orgs = JSON.parse(data.orgs_json || '[]');
      } catch {
        // Fall through with an empty list — the counts below still carry the
        // alert, and a malformed payload is no reason to drop it.
      }
      const cutOff = data.cut_off_count ?? '0';
      const lines: string[] = [
        `${data.org_count} organization(s) are below $${data.threshold_usd} in credits.`,
        `${cutOff} of them are already cut off — the credit floor is refusing their AI calls right now.`,
        '',
      ];
      for (const o of orgs) {
        const mark = o.cutOff ? '[CUT OFF]' : '[low]    ';
        lines.push(`${mark} ${o.name} (${o.planId}) — $${Number(o.balanceUsd).toFixed(4)} — ${o.id}`);
      }
      lines.push('');
      lines.push('Recharge with: tsx scripts/grant-credits.ts --org-id <id> --amount <usd>');
      return lines.join('\n');
    }

    // Ops-only. Sent by the cloud meetings sweeper when it bills finished
    // bots the provider webhook never delivered — the webhook endpoint is
    // probably disabled or failing.
    case 'meetings_webhook_missed_ops': {
      const ids = (data.bot_ids || '').split(',').map((s) => s.trim()).filter(Boolean);
      const lines: string[] = [
        `The meetings sweeper billed ${data.bot_count || '?'} bot(s) ($${data.usd || '?'}) that the provider webhook never delivered.`,
        '',
        'Billing is covered, but customer apps did not receive those events either.',
        'Check the meetings provider webhook endpoint is enabled and returning 2xx.',
      ];
      if (ids.length > 0) {
        lines.push('', 'Bots:');
        for (const id of ids) lines.push(`  ${id}`);
      }
      return lines.join('\n');
    }

    case 'weekly_digest': {
      const items = parseDigestItems(data.itemsJson);
      const deploys = parseDeployItems(data.deployItemsJson);
      const templateUpdates = parseTemplateUpdateItems(data.templateUpdatesJson);
      if (items.length === 0 && deploys.length === 0 && templateUpdates.length === 0) {
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
          lines.push(`    ${dashboardUrl}/apps/${it.appId}/functions/${it.functionName}`);
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
      if (templateUpdates.length > 0) {
        // Informational only — no "action needed" framing. These forks are
        // unmodified, so there's nothing broken and nothing to fix; this is
        // just letting the owner know a newer template release exists.
        lines.push(`Template updates available (${templateUpdates.length}):`);
        lines.push('');
        for (const t of templateUpdates) {
          const label = t.latest_label ? ` (latest: ${t.latest_label})` : '';
          lines.push(`• App ${t.dest_app_id} is ${t.behind_by} release${t.behind_by === 1 ? '' : 's'} behind its template${label}`);
          lines.push(`    ${dashboardUrl}/apps/${t.dest_app_id}`);
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
      const logsUrl = `${dashboardUrl}/apps/${data.appId}/functions/${data.functionName}`;
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
        `View function logs: ${dashboardUrl}/apps/${data.appId}/functions/${data.hookFunction}`,
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
        `If you have any questions, contact support from your dashboard: ${dashboardUrl}`,
        '',
        '— The Butterbase team',
      ].join('\n');

    case 'credits_low': {
      const total = data.total_usd ?? '0.00';
      const monthly = data.monthly_allowance_usd ?? '0.00';
      const topup = data.topup_usd ?? '0.00';
      const resetDate = formatEmailDate(data.reset_date);
      // `||`, not `??`: credits-email passes '' when DASHBOARD_URL is unset,
      // and an empty string would produce relative links.
      const creditsLowDashboardUrl = data.dashboard_url || dashboardUrl;
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
      const creditsExhaustedDashboardUrl = data.dashboard_url || dashboardUrl;
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
  const html = renderEmailLayout({
    preheader: `${suggestion.category}: ${snippet}`,
    audience: 'ops',
    content: renderNotice({
      heading: `New ${suggestion.category} suggestion`,
      intro: `<p style="margin:0;white-space:pre-wrap;">${escapeHtml(suggestion.description)}</p>`,
      facts: [
        ['Severity', suggestion.severity || 'n/a'],
        ['Source', suggestion.source],
        ['Affected tool', suggestion.affected_tool || ''],
        ['User', suggestion.user_email ? `${suggestion.user_email} (${suggestion.user_id})` : suggestion.user_id || ''],
        ['App', suggestion.app_name ? `${suggestion.app_name} (${suggestion.app_id})` : suggestion.app_id || ''],
      ],
      cta: { href: `${adminUrl}/suggestions/${encodeURIComponent(suggestion.id)}`, label: 'Open in admin' },
      detail: suggestion.proposed_solution ? { label: 'Proposed solution', text: suggestion.proposed_solution } : undefined,
    }),
  });

  try {
    const command = new SendEmailCommand(withConfigurationSet({
      Source: `${config.ses.fromName} <${config.ses.fromEmail}>`,
      Destination: { ToAddresses: [to] },
      Message: {
        Subject: { Data: subject },
        Body: { Text: { Data: body }, Html: { Data: html } },
      },
    }));

    await sesClient.send(command);
    console.log(`[EMAIL] Suggestion notification sent to ${to} (suggestion ${suggestion.id})`);
  } catch (error) {
    if (config.ses.devConsoleFallback) {
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
 * Per-mode copy for the 'clone_failed' template's HTML body. template_clone_jobs
 * now carries five modes (migration 116); each means something different to the
 * recipient, so each gets its own heading/verb/CTA. 'staging_create' shares
 * clone's copy on purpose — it is, mechanically, a clone onto a fresh app (see
 * executeClone's dispatch fallthrough in neon-task-worker.ts).
 */
function cloneFailedHtmlCopy(mode: string | undefined, data: Record<string, string>, dashboardUrl: string): {
  heading: string;
  buttonLabel: string;
  retryUrl: string;
  intro: string;
  dataNote: string;
  preheaderVerb: string;
} {
  const appId = escapeHtml(data.appId || '');
  const appName = escapeHtml(data.appName || data.appId || '');
  const sourceAppId = escapeHtml(data.sourceAppId || '');
  const appUrl = `${dashboardUrl}/apps/${appId}`;

  if (mode === 'update') {
    return {
      heading: 'Update didn&rsquo;t finish',
      buttonLabel: 'Open the app',
      retryUrl: appUrl,
      intro: `We couldn&rsquo;t finish updating &ldquo;${appName}&rdquo; to the latest release of template <span style="font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;">${sourceAppId}</span>.`,
      dataNote: `Your data was not touched &mdash; an update never drops or rewrites your rows. The app may be part-way between its old code and the new release; you can undo the update from <a href="${appUrl}" style="color:#525252;text-decoration:underline;">the app page</a>.`,
      preheaderVerb: 'updating',
    };
  }
  if (mode === 'promote') {
    return {
      heading: 'Promote to production didn&rsquo;t finish',
      buttonLabel: 'Review the app',
      retryUrl: appUrl,
      intro: `We couldn&rsquo;t finish promoting your staging environment onto &ldquo;${appName}&rdquo;, your <strong>live production app</strong>.`,
      dataNote: `This app may be part-way between its old state and the promoted staging state &mdash; please <a href="${appUrl}" style="color:#525252;text-decoration:underline;">review it now</a>.`,
      preheaderVerb: 'promoting to production',
    };
  }
  if (mode === 'staging_reset') {
    return {
      heading: 'Staging reset didn&rsquo;t finish',
      buttonLabel: 'Open the staging app',
      retryUrl: appUrl,
      intro: `We couldn&rsquo;t finish resetting your staging environment &ldquo;${appName}&rdquo; from production app <span style="font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;">${sourceAppId}</span>.`,
      dataNote: `Your staging app&rsquo;s code and data may be part-way through being replaced from production. It is safe to <a href="${appUrl}" style="color:#525252;text-decoration:underline;">open the staging app and try the reset again</a>.`,
      preheaderVerb: 'resetting your staging environment',
    };
  }
  // 'clone' and 'staging_create'
  return {
    heading: 'Clone didn&rsquo;t finish',
    buttonLabel: 'Try cloning again',
    retryUrl: `${dashboardUrl}/templates`,
    intro: `We couldn&rsquo;t finish cloning &ldquo;${appName}&rdquo; from template <span style="font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;">${sourceAppId}</span>.`,
    dataNote: `The destination app was created but the code (frontend + functions) may not be fully in place. You can retry the clone from the template gallery, or delete the partial app and start fresh &mdash; <a href="${appUrl}" style="color:#525252;text-decoration:underline;">manage the partial app</a>.`,
    preheaderVerb: 'cloning',
  };
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
    const templateUpdates = parseTemplateUpdateItems(data.templateUpdatesJson);
    const total = items.length + deploys.length;
    const unsubscribe = opts.actionTokens?.unsubscribeTemplate
      ? `<p style="margin:24px 0 0 0;font-size:12px;color:#a3a3a3;"><a href="${escapeHtml(notifActionUrl(opts.actionTokens.unsubscribeTemplate))}" style="color:#a3a3a3;text-decoration:underline;">Unsubscribe from the weekly digest</a></p>`
      : '';

    const templateUpdateRows = templateUpdates.map((t) => {
      const url = `${dashboardUrl}/apps/${escapeHtml(t.dest_app_id)}`;
      const labelLine = t.latest_label ? ` &middot; latest ${escapeHtml(t.latest_label)}` : '';
      return `<tr><td style="padding:16px 0;border-bottom:1px solid #f0f0f0;">
<div style="font-size:14px;font-weight:600;color:#0a0a0a;margin-bottom:2px;">
<a href="${url}" style="color:#0a0a0a;text-decoration:none;">${escapeHtml(t.dest_app_id)}</a>
</div>
<div style="font-size:13px;color:#737373;">
${escapeHtml(String(t.behind_by))} release${t.behind_by === 1 ? '' : 's'} behind its template${labelLine}
</div>
</td></tr>`;
    }).join('');
    // Informational only, not an alert — these forks are unmodified so there
    // is nothing broken to fix, just a newer release available to look at.
    const templateUpdateSection = templateUpdateRows ? `
<h2 style="margin:24px 0 0 0;font-size:13px;font-weight:600;color:#737373;text-transform:uppercase;letter-spacing:0.05em;">Template updates available</h2>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">${templateUpdateRows}</table>` : '';

    if (total === 0) {
      const content = templateUpdateSection
        ? `
<h1 style="margin:0 0 8px 0;font-size:20px;font-weight:600;color:#0a0a0a;">Quiet week 🌱</h1>
<p style="margin:0 0 24px 0;font-size:14px;color:#525252;line-height:1.5;">Nothing failed across your apps in the last 7 days.</p>
${templateUpdateSection}
<p style="margin:32px 0 0 0;">${renderButton({ href: dashboardUrl, label: 'Open dashboard' })}</p>`
        : `
<h1 style="margin:0 0 8px 0;font-size:20px;font-weight:600;color:#0a0a0a;">Quiet week 🌱</h1>
<p style="margin:0 0 24px 0;font-size:14px;color:#525252;line-height:1.5;">Nothing failed across your apps in the last 7 days.</p>
${renderButton({ href: dashboardUrl, label: 'Open dashboard' })}`;
      return renderEmailLayout({
        preheader: 'Nothing failed across your apps this week.',
        content: content + unsubscribe,
      });
    }

    const fnRows = items.map((it) => {
      const url = `${dashboardUrl}/apps/${escapeHtml(it.appId)}/functions/${escapeHtml(it.functionName)}`;
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
${section('Deployments', deployRows)}${templateUpdateSection}
<p style="margin:32px 0 0 0;">${renderButton({ href: dashboardUrl, label: 'Open dashboard' })}</p>`;
    return renderEmailLayout({
      preheader: `${total} thing${total === 1 ? '' : 's'} need attention. ${top}`,
      content: content + unsubscribe,
    });
  }

  if (template === 'clone_failed') {
    const errorMsg = truncateError(data.errorMessage || '(no message captured)');
    const copy = cloneFailedHtmlCopy(data.mode, data, dashboardUrl);
    const stageLine = data.stalledStage
      ? `<p style="margin:0 0 4px 0;font-size:13px;color:#737373;">Stalled at stage <span style="color:#0a0a0a;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;">${escapeHtml(data.stalledStage)}</span></p>`
      : '';
    const content = `
<h1 style="margin:0 0 4px 0;font-size:20px;font-weight:600;line-height:1.3;letter-spacing:-0.01em;color:#0a0a0a;">${copy.heading}</h1>
<p style="margin:0 0 24px 0;font-size:14px;color:#737373;">
${copy.intro}
</p>
${renderButton({ href: copy.retryUrl, label: copy.buttonLabel })}
<p style="margin:32px 0 8px 0;font-size:13px;font-weight:600;color:#0a0a0a;">What happened</p>
${stageLine}
<pre style="margin:0;padding:16px;background:#fafafa;border:1px solid #f0f0f0;border-radius:8px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:12px;line-height:1.5;color:#0a0a0a;white-space:pre-wrap;word-break:break-word;overflow-wrap:break-word;">${escapeHtml(errorMsg)}</pre>
<p style="margin:24px 0 0 0;font-size:13px;color:#737373;line-height:1.6;">
${copy.dataNote}
</p>
<p style="margin:16px 0 0 0;font-size:12px;color:#a3a3a3;line-height:1.5;">
Job ID <span style="font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;">${escapeHtml(data.jobId || '')}</span>
</p>`;
    return renderEmailLayout({
      preheader: `We couldn't finish ${copy.preheaderVerb} "${data.appName || data.appId || ''}".`,
      content,
    });
  }

  if (template === 'clone_reaper_digest') {
    let details: Array<{ jobId: string; destAppId: string | null; stalledStage: string; ageMinutes: number }> = [];
    try {
      details = JSON.parse(data.detailsJson || '[]');
    } catch {
      // fall through with empty list
    }
    const rows = details.map((d) => {
      const appLink = d.destAppId
        ? `<a href="${dashboardUrl}/apps/${escapeHtml(d.destAppId)}" style="color:#0a0a0a;text-decoration:none;">${escapeHtml(d.destAppId)}</a>`
        : '<span style="color:#a3a3a3;">(no dest app)</span>';
      return `<tr><td style="padding:14px 0;border-bottom:1px solid #f0f0f0;">
<div style="font-size:13px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;color:#0a0a0a;margin-bottom:4px;">${escapeHtml(d.jobId)}</div>
<div style="font-size:12px;color:#737373;">${appLink} &nbsp;·&nbsp; stalled at <span style="color:#0a0a0a;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;">${escapeHtml(d.stalledStage)}</span> &nbsp;·&nbsp; ${escapeHtml(String(d.ageMinutes))}m old</div>
</td></tr>`;
    }).join('');
    const content = `
<h1 style="margin:0 0 4px 0;font-size:20px;font-weight:600;line-height:1.3;letter-spacing:-0.01em;color:#0a0a0a;">${escapeHtml(data.reapedCount || '?')} stuck clone job${data.reapedCount === '1' ? '' : 's'} swept</h1>
<p style="margin:0 0 24px 0;font-size:14px;color:#737373;">
The clone-jobs reaper flipped these jobs to <span style="font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;color:#0a0a0a;">failed</span> after they stalled mid-pipeline. A multi-job reap usually points at a systemic issue (deploy race, worker crash, or region blip).
</p>
${rows ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">${rows}</table>` : ''}
<p style="margin:24px 0 0 0;font-size:13px;color:#737373;line-height:1.6;">
Users of each app have been notified individually via clone_failed emails.
</p>`;
    return renderEmailLayout({
      preheader: `${data.reapedCount} stuck clone job${data.reapedCount === '1' ? '' : 's'} flipped to failed.`,
      content,
      audience: 'ops',
    });
  }

  if (template === 'function_failed') {
    const streak = data.streakLen || '3';
    const fn = data.functionName || 'a function';
    const app = data.appName || data.appId || 'your app';
    const errorMsg = truncateError(data.errorMessage || '(no message captured)');
    const logsUrl = `${dashboardUrl}/apps/${data.appId}/functions/${data.functionName}`;

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

  const notice = buildNoticeHtml(template, data, dashboardUrl);
  if (notice) return notice;

  return null;
}

/**
 * HTML for the single-event templates (billing, limits, failures, ops). Same
 * data and message as the matching buildBillingEmailBody case. Every
 * interpolated value is escaped — app names, hook names and error messages
 * are user-controlled.
 */
function buildNoticeHtml(
  template: BillingEmailTemplate,
  data: Record<string, string>,
  dashboardUrl: string,
): string | null {
  const e = escapeHtml;
  const app = data.appName || data.appId || '';
  const label = meterLabel(data.meter);
  const current = formatMeterValue(data.meter, data.current);
  const limit = formatMeterValue(data.meter, data.limit);
  const usageFacts: Array<[string, string]> = [['Current usage', current], ['Plan limit', limit]];
  const owner = (preheader: string, content: string) => renderEmailLayout({ preheader, content });
  const ops = (preheader: string, content: string) => renderEmailLayout({ preheader, content, audience: 'ops' });

  switch (template) {
    case 'payment_failed': {
      const by = formatEmailDate(data.gracePeriodEndsAt);
      return owner(
        by ? `Update your payment method by ${by} to avoid interruption.` : 'Update your payment method to avoid interruption.',
        renderNotice({
          heading: 'Your payment failed',
          intro: `<p style="margin:0;">We were unable to process your payment. Your account will remain active until <strong>${e(by || 'the end of the grace period')}</strong>. Please update your payment method to avoid service interruption.</p>`,
          cta: { href: `${dashboardUrl}/billing`, label: 'Update payment method' },
          note: 'If you believe this is an error, please contact support.',
        }),
      );
    }
    case 'plan_downgraded': {
      const ended = formatEmailDate(data.gracePeriodEndedAt);
      return owner(
        'Your subscription was canceled and your account moved to the free Playground plan.',
        renderNotice({
          heading: 'Your plan was downgraded',
          intro: `<p style="margin:0 0 12px 0;">We still could not collect payment for your Butterbase subscription, and the grace period ${ended ? `ended on <strong>${e(ended)}</strong>` : 'has ended'}.</p>
<p style="margin:0;">Your subscription has been canceled and your account is now on the free <strong>Playground</strong> plan. Your apps and data are still there, but Playground limits now apply, and anything over those limits may be restricted.</p>`,
          cta: { href: `${dashboardUrl}/billing`, label: 'Restore your plan' },
          note: 'Update your payment method and resubscribe to restore your previous plan. If you believe this is an error, please contact support.',
        }),
      );
    }
    case 'soft_locked':
      return owner(
        'Your account is read-only until you upgrade or reduce usage.',
        renderNotice({
          heading: 'Your account is in read-only mode',
          intro: `<p style="margin:0;">You have exceeded your free plan limits. You can still read and delete data, but can't create or update until you upgrade or bring usage back under the limits.</p>`,
          facts: [['Over the limit', data.violations || 'See dashboard for details']],
          cta: { href: `${dashboardUrl}/billing/upgrade`, label: 'Upgrade your plan' },
        }),
      );
    case 'account_suspended':
      return owner(
        'Update your payment method to reactivate your account.',
        renderNotice({
          heading: 'Your account has been suspended',
          intro: `<p style="margin:0;">Your account was suspended because a payment failure was not resolved within the grace period.</p>`,
          facts: [['Reason', data.reason || 'Payment failure']],
          cta: { href: `${dashboardUrl}/billing`, label: 'Update payment method' },
          note: 'If you need assistance, please contact support.',
        }),
      );
    case 'overage_warning':
      return owner(
        `Your ${label} usage is over your plan limit. Service continues; overage is billed.`,
        renderNotice({
          heading: `${capitalize(label)} is over your plan limit`,
          intro: `<p style="margin:0;">Your service is not interrupted. Overage usage will be billed at the end of your billing period at your plan's overage rate.</p>`,
          facts: usageFacts,
          cta: { href: `${dashboardUrl}/billing`, label: 'View usage' },
        }),
      );
    case 'soft_limit_warning':
      return owner(
        `You're at ${data.percentage || '80'}% of your included ${label}.`,
        renderNotice({
          heading: `You're at ${data.percentage || '80'}% of your included ${label}`,
          intro: `<p style="margin:0;">Once you cross 100%, your service continues without interruption. Overage usage is billed at your plan's overage rate at the end of the billing period.</p>`,
          facts: usageFacts,
          cta: { href: `${dashboardUrl}/billing`, label: 'Review usage' },
        }),
      );
    case 'hard_limit_warning':
      return owner(
        `You're at ${data.percentage || '80'}% of your ${label} limit. It will be blocked at 100%.`,
        renderNotice({
          heading: `You're at ${data.percentage || '80'}% of your ${label} limit`,
          intro: `<p style="margin:0;">Once you reach 100%, this resource will be <strong>blocked</strong> until you upgrade your plan or reduce usage.</p>`,
          facts: usageFacts,
          cta: { href: `${dashboardUrl}/billing/upgrade`, label: 'Upgrade now' },
        }),
      );
    case 'hard_limit_exceeded':
      return owner(
        `Your ${label} limit is reached and further use is blocked.`,
        renderNotice({
          heading: `You've reached your ${label} limit`,
          intro: `<p style="margin:0;">Further use of this resource is blocked until you upgrade your plan or reduce usage. Other resources on your account are unaffected.</p>`,
          facts: usageFacts,
          cta: { href: `${dashboardUrl}/billing/upgrade`, label: 'Upgrade your plan' },
        }),
      );
    case 'deployment_failed':
      return owner(
        `A deployment for ${app} failed.`,
        renderNotice({
          heading: 'Deployment failed',
          intro: `<p style="margin:0;">A deployment for your app <strong>${e(app)}</strong> failed.</p>`,
          facts: [['Deployment ID', data.deploymentId || '']],
          cta: { href: `${dashboardUrl}/apps/${encodeURIComponent(data.appId || '')}/deployments/${encodeURIComponent(data.deploymentId || '')}`, label: 'View deployment' },
          detail: { label: 'Error', text: truncateError(data.errorMessage || 'See dashboard for details') },
        }),
      );
    case 'provisioning_failed':
      return owner(
        `Setup for ${app} failed.`,
        renderNotice({
          heading: 'App setup failed',
          intro: `<p style="margin:0;">Setup for your app <strong>${e(app)}</strong> failed.</p>`,
          cta: { href: `${dashboardUrl}/apps/${encodeURIComponent(data.appId || '')}`, label: 'View app' },
          detail: { label: 'Reason', text: truncateError(data.provisioningError || 'Unknown error') },
          note: 'You may need to delete and recreate this app, or contact support if the problem persists.',
        }),
      );
    case 'auth_hook_failed':
      return owner(
        `Your auth hook "${data.hookFunction}" in ${app} failed during a "${data.event}" event.`,
        renderNotice({
          heading: 'Your auth hook is failing',
          intro: `<p style="margin:0;">Your auth hook <strong>${e(data.hookFunction || '')}</strong> in <strong>${e(app)}</strong> failed during a <strong>${e(data.event || '')}</strong> event. Sign-ins still succeed, but any post-auth side effects you wired into the hook (creating profile rows, syncing to external systems, etc.) did not run for the affected users.</p>`,
          cta: { href: `${dashboardUrl}/apps/${encodeURIComponent(data.appId || '')}/functions/${encodeURIComponent(data.hookFunction || '')}`, label: 'View function logs' },
          detail: { label: 'Error', text: truncateError(data.errorMessage || '(no message)') },
          note: 'You will receive at most one email per hook function per day for this app.',
        }),
      );
    case 'auto_refill_failed':
      return owner(
        'Auto-refill is now off. Update your payment method to keep using AI features.',
        renderNotice({
          heading: 'Auto-refill failed',
          intro: `<p style="margin:0;">We tried to auto-refill your Butterbase AI credits and the charge did not go through. Auto-refill has been <strong>disabled</strong> on your account. Update your payment method or top up manually, then re-enable auto-refill.</p>`,
          facts: [['Amount attempted', `$${data.amount_usd || '?'}`], ['Reason', data.failure_reason || 'Your payment method was declined']],
          cta: { href: `${dashboardUrl}/billing`, label: 'Open billing settings' },
          note: `Questions? Contact support from <a href="${e(dashboardUrl)}" style="color:#525252;text-decoration:underline;">your dashboard</a>.`,
        }),
      );
    case 'credits_low': {
      const base = data.dashboard_url || dashboardUrl;
      const reset = formatEmailDate(data.reset_date);
      return owner(
        `$${data.total_usd ?? '0.00'} of AI credits left. AI requests fail at $0.`,
        renderNotice({
          heading: 'Your AI credits are running low',
          intro: `<p style="margin:0;">AI requests will start failing once you reach $0. Buy credits or turn on auto-refill to keep going.</p>`,
          facts: [
            ['Available', `$${data.total_usd ?? '0.00'}`],
            ['Monthly allowance', `$${data.monthly_allowance_usd ?? '0.00'}${reset ? ` (resets ${reset})` : ''}`],
            ['Top-up balance', `$${data.topup_usd ?? '0.00'}`],
          ],
          cta: { href: `${base}/billing?topup=open`, label: 'Buy credits' },
          note: `Or <a href="${e(`${base}/billing?autoRefill=focus`)}" style="color:#525252;text-decoration:underline;">enable auto-refill</a> so this doesn't happen again.`,
        }),
      );
    }
    case 'credits_exhausted': {
      const base = data.dashboard_url || dashboardUrl;
      return owner(
        'Your AI credit balance is $0. AI requests from your apps are failing.',
        renderNotice({
          heading: 'Your AI credits are used up',
          intro: `<p style="margin:0;">Your AI credit balance has reached $0. AI requests from your apps will fail until you add more credits.</p>`,
          cta: { href: `${base}/billing?topup=open`, label: 'Buy credits' },
          note: `<a href="${e(`${base}/billing?autoRefill=focus`)}" style="color:#525252;text-decoration:underline;">Enable auto-refill</a> to prevent this in the future. We'll charge your card automatically when your balance gets low.`,
        }),
      );
    }
    case 'clone_failed_ops':
      return ops(
        `${data.mode || 'clone'} job ${data.jobId} failed for ${data.appId}.`,
        renderNotice({
          heading: `Clone job failed${data.mode && data.mode !== 'clone' ? ` (${data.mode})` : ''}`,
          intro: `<p style="margin:0;">${data.ownerEmail ? 'The owner has been sent a clone_failed email (unless they have silenced it).' : 'No owner email on file, so nobody outside ops has been told.'}</p>`,
          facts: [
            ['Job ID', data.jobId || '(unknown)'],
            ['Mode', data.mode || 'clone'],
            ['App', data.appName ? `${data.appName} (${data.appId})` : data.appId || '(unknown)'],
            ['Source app', data.sourceAppId || '(unknown)'],
            ['Organization', data.organizationId || '(unknown)'],
            ['Owner', data.ownerEmail || '(no owner email on file)'],
            ['Stalled at', data.stalledStage || ''],
          ],
          detail: { label: 'Error', text: truncateError(data.errorMessage || '(no message captured)') },
        }),
      );
    case 'org_balance_low_ops': {
      interface LowOrg { id: string; name: string; planId: string; balanceUsd: number; cutOff: boolean }
      let orgs: LowOrg[] = [];
      try {
        orgs = JSON.parse(data.orgs_json || '[]');
      } catch {
        // Counts below still carry the alert.
      }
      const rows = orgs.map((o) => `<tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-size:13px;">
<span style="display:inline-block;min-width:64px;font-weight:600;color:${o.cutOff ? '#b91c1c' : '#737373'};">${o.cutOff ? 'CUT OFF' : 'low'}</span>
${e(o.name)} <span style="color:#737373;">(${e(o.planId)})</span> &middot; $${e(Number(o.balanceUsd).toFixed(4))}
<div style="font-size:11px;color:#a3a3a3;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;">${e(o.id)}</div>
</td></tr>`).join('');
      return ops(
        `${data.org_count} org(s) below $${data.threshold_usd}; ${data.cut_off_count ?? '0'} cut off.`,
        renderNotice({
          heading: `${data.org_count} organization${data.org_count === '1' ? '' : 's'} low on credits`,
          intro: `<p style="margin:0;">Below $${e(data.threshold_usd)} in credits. <strong>${e(data.cut_off_count ?? '0')}</strong> already cut off: the credit floor is refusing their AI calls right now.</p>`,
          note: 'Recharge with: <span style="font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;">tsx scripts/grant-credits.ts --org-id &lt;id&gt; --amount &lt;usd&gt;</span>',
        }) + (rows ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:16px;border-collapse:collapse;">${rows}</table>` : ''),
      );
    }
    case 'meetings_webhook_missed_ops': {
      const ids = (data.bot_ids || '').split(',').map((s) => s.trim()).filter(Boolean);
      return ops(
        `${data.bot_count || '?'} meeting bot(s) billed by the sweeper.`,
        renderNotice({
          heading: `Webhook missed ${data.bot_count || '?'} meeting bot${data.bot_count === '1' ? '' : 's'}`,
          intro: `<p style="margin:0;">The meetings sweeper billed them ($${e(data.usd || '?')}), but the provider webhook never delivered — so customer apps did not get those events either. Check the meetings provider webhook endpoint is enabled and returning 2xx.</p>`,
          ...(ids.length > 0
            ? { detail: { label: 'Bots', text: ids.join('\n') } }
            : {}),
        }),
      );
    }
    default:
      return null;
  }
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
  if (template === 'clone_failed') {
    const app = data.appName || data.appId || 'your app';
    // Same template, five very different events — see notifyCloneFailed's `mode`.
    if (data.mode === 'update') return `Update failed: "${app}"`;
    if (data.mode === 'promote') return `Promote to production failed: "${app}"`;
    if (data.mode === 'staging_reset') return `Staging reset failed: "${app}"`;
    return `Clone failed: "${app}"`;
  }
  if (template === 'clone_failed_ops') {
    const mode = data.mode && data.mode !== 'clone' ? ` (${data.mode})` : '';
    return `[butterbase] Clone failed: ${data.appId || 'unknown app'}${mode} job ${data.jobId || '?'}`;
  }
  if (template === 'clone_reaper_digest') {
    const n = data.reapedCount || '?';
    return `[butterbase] Reaped ${n} stuck clone job${n === '1' ? '' : 's'}`;
  }
  if (template === 'weekly_digest') {
    const total = digestTotalCount(data);
    if (total === 0) {
      // Template updates are informational, not "needs attention" — but a
      // generic subject over a body that lists them undersold the email.
      const updates = parseTemplateUpdateItems(data.templateUpdatesJson).length;
      if (updates === 1) return 'Your weekly digest: 1 template update available';
      if (updates > 1) return `Your weekly digest: ${updates} template updates available`;
      return 'Your weekly Butterbase digest';
    }
    if (total === 1) return 'Your weekly digest: 1 thing needs attention';
    return `Your weekly digest: ${total} things need attention`;
  }
  // Everything below: put the distinguishing detail (app, meter, amount, date)
  // in the subject. Gmail threads on identical subjects from the same sender,
  // so a fixed subject collapses unrelated alerts into one conversation.
  const app = data.appName || data.appId;
  switch (template) {
    case 'payment_failed': {
      const by = formatEmailDate(data.gracePeriodEndsAt);
      return by ? `Action required: payment failed, update by ${by}` : 'Action required: your payment failed';
    }
    case 'plan_downgraded':
      return 'Your Butterbase plan was downgraded to Playground';
    case 'soft_locked': {
      const meters = violationMeters(data.violations).map(meterLabel);
      return meters.length
        ? `Account limited: over the free plan limit for ${meters.join(', ')}`
        : BILLING_EMAIL_SUBJECTS.soft_locked;
    }
    case 'overage_warning':
      return `${capitalize(meterLabel(data.meter))} is over your plan limit (overage will be billed)`;
    case 'soft_limit_warning':
      return `Heads up: ${meterLabel(data.meter)} at ${data.percentage || '80'}% of your plan limit`;
    case 'hard_limit_warning':
      return `Heads up: ${meterLabel(data.meter)} at ${data.percentage || '80'}% of your plan limit (blocked at 100%)`;
    case 'hard_limit_exceeded':
      return `Action required: ${meterLabel(data.meter)} plan limit reached`;
    case 'deployment_failed':
      return app ? `[${app}] Deployment failed` : BILLING_EMAIL_SUBJECTS.deployment_failed;
    case 'provisioning_failed':
      return app ? `[${app}] App setup failed` : BILLING_EMAIL_SUBJECTS.provisioning_failed;
    case 'auth_hook_failed':
      return app
        ? `[${app}] Auth hook${data.hookFunction ? ` "${data.hookFunction}"` : ''} is failing`
        : BILLING_EMAIL_SUBJECTS.auth_hook_failed;
    case 'auto_refill_failed':
      return data.amount_usd
        ? `Action required: $${data.amount_usd} auto-refill failed`
        : BILLING_EMAIL_SUBJECTS.auto_refill_failed;
    case 'credits_low':
      return data.total_usd
        ? `Your AI credits are running low ($${data.total_usd} left)`
        : BILLING_EMAIL_SUBJECTS.credits_low;
    case 'meetings_webhook_missed_ops': {
      const n = data.bot_count || '?';
      return `[butterbase] Webhook missed ${n} meeting bot${n === '1' ? '' : 's'} ($${data.usd || '?'})`;
    }
    case 'org_balance_low_ops': {
      const n = data.org_count || '?';
      const cut = data.cut_off_count && data.cut_off_count !== '0' ? `, ${data.cut_off_count} cut off` : '';
      return `[butterbase] ${n} org${n === '1' ? '' : 's'} low on credits${cut}`;
    }
    default:
      return BILLING_EMAIL_SUBJECTS[template];
  }
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

export interface DigestTemplateUpdateItem {
  dest_app_id: string;
  source_app_id: string;
  behind_by: number;
  latest_label: string | null;
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

function parseTemplateUpdateItems(json: string | undefined): DigestTemplateUpdateItem[] {
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
 * Send a billing-related email notification. Never throws; see
 * BillingEmailResult. Falls back to console logging when
 * config.ses.devConsoleFallback is on.
 */
const OPS_BILLING_TEMPLATES: ReadonlySet<BillingEmailTemplate> = new Set<BillingEmailTemplate>([
  'clone_failed_ops',
  'clone_reaper_digest',
  'org_balance_low_ops',
  'meetings_webhook_missed_ops',
]);

export async function sendBillingEmail(
  to: string,
  template: BillingEmailTemplate,
  data: Record<string, string> = {},
  opts: BillingEmailOptions = {},
): Promise<BillingEmailResult> {
  // Silence gate. Opt-in: callers that pass userId + controlPool get the
  // user's snoozes and unsubscribes applied. Existing callers that don't
  // pass these (most billing paths) keep current always-send behavior.
  if (opts.controlPool && opts.userId) {
    const silenced = await isSilenced(opts.controlPool, opts.userId, template, opts.scope);
    if (silenced) {
      console.log(`[EMAIL] Skipped ${template} for ${to} (user has active silence)`);
      return 'silenced';
    }
  }

  // Owner-facing copy shows a readable app name ("acme-notes" →
  // "Acme Notes"), matching the auth emails. Ops alerts keep the raw
  // slug so it can be grepped.
  if (data.appName && !OPS_BILLING_TEMPLATES.has(template)) {
    data = { ...data, appName: formatAppDisplayName(data.appName) ?? data.appName };
  }

  const subject = buildBillingEmailSubject(template, data);
  const body = buildBillingEmailBody(template, data);
  const html = buildBillingEmailHtml(template, data, { actionTokens: opts.actionTokens });
  const source = `${config.ses.fromName} <${config.ses.fromEmail}>`;

  // RFC 8058 one-click unsubscribe, when the caller minted a token for it.
  // POST to the same URL performs the unsubscribe with no confirmation page.
  const unsubscribeToken = opts.actionTokens?.unsubscribeTemplate;

  try {
    if (unsubscribeToken) {
      const raw = buildRawMimeMessage({
        from: source,
        to,
        subject,
        text: body,
        html,
        headers: {
          'List-Unsubscribe': `<${notifActionUrl(unsubscribeToken)}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      });
      await sesClient.send(new SendRawEmailCommand(withConfigurationSet({
        Source: source,
        Destinations: [to],
        RawMessage: { Data: Buffer.from(raw, 'utf8') },
      })));
    } else {
      await sesClient.send(new SendEmailCommand(withConfigurationSet({
        Source: source,
        Destination: { ToAddresses: [to] },
        Message: {
          Subject: { Data: subject, Charset: 'UTF-8' },
          // Dual-body when an HTML variant exists — clients that prefer text
          // (Apple Mail "Load Remote Content" off, etc.) still get the text
          // version. SES handles multipart/alternative selection.
          Body: html
            ? { Text: { Data: body, Charset: 'UTF-8' }, Html: { Data: html, Charset: 'UTF-8' } }
            : { Text: { Data: body, Charset: 'UTF-8' } },
        },
      })));
    }
    console.log(`[EMAIL] Billing email (${template}) sent to ${to}`);
    return 'sent';
  } catch (error) {
    if (config.ses.devConsoleFallback) {
      console.log(`[EMAIL] Billing email (${template}) for ${to}:\n${body}`);
      return 'logged';
    }
    console.error(`Failed to send billing email (${template}) to ${to}:`, error);
    // Don't throw — billing emails should not block webhook processing.
    return 'failed';
  }
}

/**
 * Send an org-invite email to the invitee.
 * Fire-and-forget: errors are logged, never thrown.
 */
export async function sendInviteEmail(input: {
  toEmail: string;
  orgName: string;
  inviterEmail: string;
  inviteUrl: string;
  expiresAt: Date;
}): Promise<void> {
  const inviterDisplay = input.inviterEmail || 'A Butterbase organization owner';
  const subject = `${inviterDisplay} invited you to ${input.orgName} on Butterbase`;
  const expiresStr = formatEmailDate(input.expiresAt);
  const content = `
<h1 style="margin:0 0 8px 0;font-size:20px;font-weight:600;color:#0a0a0a;">You have an invite</h1>
<p style="margin:0 0 24px 0;font-size:14px;color:#525252;line-height:1.5;">
  <strong>${escapeHtml(inviterDisplay)}</strong> invited you to join
  <strong>${escapeHtml(input.orgName)}</strong> on Butterbase.
</p>
${renderButton({ href: input.inviteUrl, label: 'Accept invite' })}
<p style="margin:24px 0 0 0;font-size:13px;color:#737373;">This invite expires on ${escapeHtml(expiresStr)}.</p>`;
  const html = renderEmailLayout({
    preheader: `${inviterDisplay} invited you to join ${input.orgName} on Butterbase.`,
    content,
    // The invitee may not have a Butterbase account, let alone own an app.
    audience: 'invitee',
  });
  const text = `${inviterDisplay} invited you to ${input.orgName} on Butterbase.\n\nAccept: ${input.inviteUrl}\n\nExpires: ${expiresStr}`;

  try {
    await sesClient.send(new SendEmailCommand(withConfigurationSet({
      Source: `${config.ses.fromName} <${config.ses.fromEmail}>`,
      Destination: { ToAddresses: [input.toEmail] },
      Message: {
        Subject: { Data: subject },
        Body: { Html: { Data: html }, Text: { Data: text } },
      },
    })));
    console.log(`[EMAIL] Invite email sent to ${input.toEmail}`);
  } catch (error) {
    if (config.ses.devConsoleFallback) {
      console.log(`[Invite email (dev)] to=${input.toEmail} url=${input.inviteUrl}`);
    } else {
      console.warn('[sendInviteEmail] failed', error);
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
  // Name the suggestion so updates to different suggestions don't thread together.
  const shortSnippet = suggestion.description.length > 40
    ? `${suggestion.description.slice(0, 40).trimEnd()}…`
    : suggestion.description;
  const subject = `Your suggestion "${shortSnippet}" is now ${label}`;
  const html = renderEmailLayout({
    preheader: `Status updated to ${label}.`,
    content: renderNotice({
      heading: `Your suggestion is now ${label}`,
      intro: `<p style="margin:0;">Thank you for helping improve Butterbase. We've updated the status of your suggestion.</p>`,
      facts: [['Status', label]],
      detail: { label: 'Your suggestion', text: snippet },
    }),
  });
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
    const command = new SendEmailCommand(withConfigurationSet({
      Source: `${config.ses.fromName} <${config.ses.fromEmail}>`,
      Destination: { ToAddresses: [to] },
      Message: {
        Subject: { Data: subject },
        Body: { Text: { Data: body }, Html: { Data: html } },
      },
    }));

    await sesClient.send(command);
    console.log(`[EMAIL] Suggestion status update sent to ${to} (suggestion ${suggestion.id}, status: ${suggestion.status})`);
  } catch (error) {
    if (config.ses.devConsoleFallback) {
      console.log(`[EMAIL] Suggestion status update for ${to} (${suggestion.id}):\n${body}`);
    } else {
      console.error(`Failed to send suggestion status update to ${to}:`, error);
    }
  }
}
