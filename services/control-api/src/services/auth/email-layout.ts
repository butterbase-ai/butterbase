// Minimal HTML email layout helpers.
//
// Design rules — do not break without thinking:
//   1. Inline styles only. Email clients (Gmail in particular) strip <style>
//      blocks. Every visual property lives on the element.
//   2. Table-based layout. Outlook + several mobile clients still render
//      flexbox/grid unreliably.
//   3. ONE remote asset only: the wordmark logo. Hosted on the dashboard
//      origin (DASHBOARD_URL). Many clients (Gmail) block remote images by
//      default on first contact; the alt="Butterbase" text serves as the
//      fallback and the header bg keeps the brand recognizable even when
//      the image is blocked.
//   4. No template engine. Tagged template literals + escapeHtml are enough
//      until we have >5 HTML templates. At that point, revisit.
//   5. All user-controlled data MUST flow through escapeHtml before
//      interpolation. App names, function names, error messages are
//      user-supplied and can contain `<`, `>`, `&`, `"`, `'`.

const AMP = /&/g;
const LT = /</g;
const GT = />/g;
const DQ = /"/g;
const SQ = /'/g;

export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(AMP, '&amp;')
    .replace(LT, '&lt;')
    .replace(GT, '&gt;')
    .replace(DQ, '&quot;')
    .replace(SQ, '&#39;');
}

/**
 * Who the email is for. Decides the footer, which is the only part of the
 * shell that makes a claim about the recipient:
 *   - owner:   a Butterbase customer (owns an app/org) — notification settings link
 *   - invitee: someone invited to an org who may not have an account yet
 *   - ops:     internal Butterbase operators
 */
export type EmailAudience = 'owner' | 'invitee' | 'ops';

interface LayoutOptions {
  /** Plain-text preview shown in inbox list before the body. ~90 chars max. */
  preheader: string;
  /** Inner HTML for the card body. Caller is responsible for escaping. */
  content: string;
  /** Defaults to 'owner', the audience every pre-existing caller was written for. */
  audience?: EmailAudience;
}

function layoutFooter(audience: EmailAudience, settingsUrl: string): string {
  switch (audience) {
    case 'invitee':
      return `You're receiving this because someone invited this address to an organization on Butterbase. If you weren't expecting it, you can ignore this email.`;
    case 'ops':
      return `Internal Butterbase ops alert. Sent to OPS_ALERT_EMAIL.`;
    case 'owner':
    default:
      return `You're receiving this because you own a Butterbase app. <a href="${escapeHtml(settingsUrl)}" style="color:#737373;text-decoration:underline;">Manage notifications</a>`;
  }
}

/**
 * Wrap pre-rendered card content in the standard Butterbase email shell.
 * Returns a complete HTML document suitable for SES `Html.Data`.
 */
export function renderEmailLayout({ preheader, content, audience = 'owner' }: LayoutOptions): string {
  const dashboardUrl = process.env.DASHBOARD_URL || 'https://dashboard.butterbase.ai';
  const logoUrl = `${dashboardUrl}/logo-white.png`;
  const settingsUrl = `${dashboardUrl}/settings/notifications`;
  const escapedPreheader = escapeHtml(preheader);
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Butterbase</title></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0a0a0a;">
<div style="display:none;font-size:0;line-height:0;max-height:0;max-width:0;overflow:hidden;opacity:0;color:transparent;">${escapedPreheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f4f5;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;">
<tr><td style="padding:20px 32px;background:#0a0a0a;line-height:0;">
<img src="${escapeHtml(logoUrl)}" alt="Butterbase" height="24" style="height:24px;width:auto;display:inline-block;border:0;outline:none;text-decoration:none;color:#ffffff;font-weight:600;font-size:14px;letter-spacing:-0.01em;line-height:24px;">
</td></tr>
<tr><td style="padding:32px;">${content}</td></tr>
<tr><td style="padding:20px 32px;background:#fafafa;border-top:1px solid #f0f0f0;font-size:12px;color:#737373;line-height:1.5;">
${layoutFooter(audience, settingsUrl)}
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

interface ButtonOptions {
  href: string;
  label: string;
}

/**
 * Bulletproof-ish dark CTA button. Renders as a styled <a> in modern clients
 * and falls back to underlined link text in plain-text clients.
 */
export function renderButton({ href, label }: ButtonOptions): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0;"><tr><td style="border-radius:8px;background:#0a0a0a;">
<a href="${escapeHtml(href)}" style="display:inline-block;padding:12px 20px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">${escapeHtml(label)}</a>
</td></tr></table>`;
}

const MONO = `ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace`;

export interface NoticeOptions {
  /** Raw text; escaped here. */
  heading: string;
  /** Pre-rendered HTML paragraph(s). Caller escapes interpolated values. */
  intro: string;
  /** Label/value rows shown as a small table. Raw values; escaped here. */
  facts?: Array<[string, string]>;
  /** Primary call to action. */
  cta?: ButtonOptions;
  /** Raw text shown in a monospace block (error messages, etc.). Escaped here. */
  detail?: { label: string; text: string };
  /** Pre-rendered HTML shown under the CTA in muted type. Caller escapes. */
  note?: string;
}

/**
 * Card content for a one-event notification: heading, intro, optional facts
 * table, CTA, monospace detail block and footnote. Shared by the billing,
 * limit and failure templates so they read as one family.
 */
export function renderNotice({ heading, intro, facts, cta, detail, note }: NoticeOptions): string {
  const factRows = (facts ?? []).filter(([, v]) => v !== '').map(([k, v]) => `<tr>
<td style="padding:6px 16px 6px 0;font-size:13px;color:#737373;white-space:nowrap;vertical-align:top;">${escapeHtml(k)}</td>
<td style="padding:6px 0;font-size:13px;color:#0a0a0a;word-break:break-word;">${escapeHtml(v)}</td>
</tr>`).join('');
  return `
<h1 style="margin:0 0 8px 0;font-size:20px;font-weight:600;line-height:1.3;letter-spacing:-0.01em;color:#0a0a0a;">${escapeHtml(heading)}</h1>
<div style="margin:0 0 24px 0;font-size:14px;color:#525252;line-height:1.6;">${intro}</div>
${factRows ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px 0;border-collapse:collapse;">${factRows}</table>` : ''}
${cta ? renderButton(cta) : ''}
${detail ? `<p style="margin:32px 0 8px 0;font-size:13px;font-weight:600;color:#0a0a0a;">${escapeHtml(detail.label)}</p>
<pre style="margin:0;padding:16px;background:#fafafa;border:1px solid #f0f0f0;border-radius:8px;font-family:${MONO};font-size:12px;line-height:1.5;color:#0a0a0a;white-space:pre-wrap;word-break:break-word;overflow-wrap:break-word;">${escapeHtml(detail.text)}</pre>` : ''}
${note ? `<p style="margin:24px 0 0 0;font-size:13px;color:#737373;line-height:1.6;">${note}</p>` : ''}`;
}

interface AppLayoutOptions {
  /**
   * Human-readable app name shown as the header and in the footer. Optional:
   * when absent, the header is omitted and the footer is generic. Raw value;
   * this function escapes it.
   */
  appName?: string | null;
  /** Plain-text preview shown in inbox list before the body. ~90 chars max. Raw value. */
  preheader: string;
  /** Inner HTML for the card body. Caller is responsible for escaping. */
  content: string;
}

/**
 * Email shell for messages sent to an app's END USERS (sign-in codes,
 * verification, password reset). Unlike `renderEmailLayout`, it carries no
 * Butterbase logo and no "you own a Butterbase app" footer: the recipient is
 * a user of the developer's app, not a Butterbase customer. Branding is the
 * app's name as text (the platform stores no per-app logo), plus a small
 * "Sent via Butterbase" line in the footer.
 */
export function renderAppEmailLayout({ appName, preheader, content }: AppLayoutOptions): string {
  const name = appName && appName.trim() ? appName.trim() : null;
  const escapedName = name ? escapeHtml(name) : '';
  const header = name
    ? `<tr><td style="padding:24px 32px;border-bottom:1px solid #f0f0f0;font-size:18px;font-weight:700;color:#0a0a0a;letter-spacing:-0.01em;line-height:1.3;">${escapedName}</td></tr>`
    : '';
  const footerLine = name
    ? `This is an automated message from ${escapedName}. Please don't reply to this email.`
    : `This is an automated message. Please don't reply to this email.`;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapedName}</title></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0a0a0a;">
<div style="display:none;font-size:0;line-height:0;max-height:0;max-width:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f4f5;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;">
${header}
<tr><td style="padding:32px;">${content}</td></tr>
<tr><td style="padding:20px 32px;background:#fafafa;border-top:1px solid #f0f0f0;font-size:12px;color:#737373;line-height:1.5;">
${footerLine}
<div style="margin-top:8px;font-size:11px;color:#a3a3a3;">Sent via Butterbase</div>
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

/**
 * One-time code rendered large, monospaced and letter-spaced inside a light
 * rounded box. Easy to read and to select/copy on mobile.
 */
// user-select:all makes one tap/click select the whole code (no JS in email,
// so a real copy button is impossible; Gmail adds its own Copy-code card).
export function renderCodeBox(code: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;"><tr>
<td style="background:#f4f4f5;border:1px solid #e4e4e7;border-radius:10px;padding:16px 28px;font-family:'SFMono-Regular',Menlo,Consolas,'Liberation Mono','Courier New',monospace;font-size:32px;font-weight:700;letter-spacing:8px;color:#0a0a0a;line-height:1.2;"><span style="-webkit-user-select:all;user-select:all;">${escapeHtml(code)}</span></td>
</tr></table>`;
}
