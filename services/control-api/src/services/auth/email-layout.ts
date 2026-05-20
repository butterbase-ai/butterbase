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

interface LayoutOptions {
  /** Plain-text preview shown in inbox list before the body. ~90 chars max. */
  preheader: string;
  /** Inner HTML for the card body. Caller is responsible for escaping. */
  content: string;
}

/**
 * Wrap pre-rendered card content in the standard Butterbase email shell.
 * Returns a complete HTML document suitable for SES `Html.Data`.
 */
export function renderEmailLayout({ preheader, content }: LayoutOptions): string {
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
You're receiving this because you own a Butterbase app. <a href="${escapeHtml(settingsUrl)}" style="color:#737373;text-decoration:underline;">Manage notifications</a>
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
