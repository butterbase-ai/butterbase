// Public, token-gated endpoint that backs the inline action buttons in
// outbound notification emails ("Snooze 24h", "Mute this function",
// "Unsubscribe").
//
// GET never acts. Link scanners (Outlook Safe Links, corporate proxies)
// pre-fetch every URL in a message; when GET consumed the token, a scanner
// could snooze/mute/unsubscribe a user who never clicked. GET now renders a
// confirmation page whose button POSTs back to the same URL, and only POST
// consumes the single-use token and applies the action.
//
// POST is also the RFC 8058 one-click target: emails carry
//   List-Unsubscribe: <https://api…/v1/notif/action/{token}>
//   List-Unsubscribe-Post: List-Unsubscribe=One-Click
// and mailbox providers POST `List-Unsubscribe=One-Click` there directly, with
// no confirmation page.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  consumeActionToken,
  peekActionToken,
  snoozeFunctionFor24h,
  muteFunction,
  unsubscribeFromTemplate,
  disableDigest,
  type ConsumedToken,
} from '../services/notification-prefs.service.js';
import { escapeHtml } from '../services/auth/email-layout.js';

const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;

function renderResultPage(opts: {
  title: string;
  message: string;
  appUrl?: string;
  /** When set, the primary button is a form POSTing to this URL instead of a dashboard link. */
  confirm?: { action: string; label: string };
}): string {
  const appUrl = opts.appUrl || (process.env.DASHBOARD_URL || 'https://dashboard.butterbase.ai');
  const button = opts.confirm
    ? `<form method="post" action="${escapeHtml(opts.confirm.action)}" style="margin:0;">
<input type="hidden" name="confirm" value="1">
<button type="submit" style="display:inline-block;padding:12px 20px;font-size:14px;font-weight:600;color:#ffffff;background:#0a0a0a;border:0;border-radius:8px;cursor:pointer;font-family:inherit;">${escapeHtml(opts.confirm.label)}</button>
</form>
<p style="margin:16px 0 0 0;font-size:13px;"><a href="${escapeHtml(appUrl)}" style="color:#737373;text-decoration:underline;">Cancel</a></p>`
    : `<a href="${escapeHtml(appUrl)}" style="display:inline-block;padding:12px 20px;font-size:14px;font-weight:600;color:#ffffff;background:#0a0a0a;text-decoration:none;border-radius:8px;">Open dashboard</a>`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(opts.title)} — Butterbase</title></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0a0a0a;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f4f5;min-height:100vh;">
<tr><td align="center" style="padding:64px 16px;vertical-align:middle;">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;width:100%;background:#ffffff;border-radius:12px;">
<tr><td style="padding:40px 32px;text-align:center;">
<h1 style="margin:0 0 12px 0;font-size:20px;font-weight:600;color:#0a0a0a;">${escapeHtml(opts.title)}</h1>
<p style="margin:0 0 24px 0;font-size:14px;color:#525252;line-height:1.5;">${escapeHtml(opts.message)}</p>
${button}
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

const paramsSchema = z.object({ token: z.string().regex(TOKEN_RE) });

// The global helmet CSP is API-only (`default-src 'none'`), which blocks the
// inline `style=` attributes renderResultPage relies on. This page needs
// inline styles and a same-origin form POST (the confirm button) and nothing
// else — no scripts, no framing.
const RESULT_PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

function confirmCopy(token: ConsumedToken): { title: string; message: string; label: string } {
  switch (token.action) {
    case 'snooze_function_24h':
      return {
        title: 'Snooze this function for 24 hours?',
        message: `You won't get emails about this function until tomorrow. It resumes automatically after that.`,
        label: 'Snooze for 24 hours',
      };
    case 'mute_function':
      return {
        title: 'Mute this function?',
        message: `You won't get any more emails about this function. You can re-enable it from notification settings.`,
        label: 'Mute function',
      };
    case 'unsubscribe_template':
    default:
      return token.payload.template === 'weekly_digest'
        ? {
          title: 'Unsubscribe from the weekly digest?',
          message: `You won't receive the weekly digest anymore. Failure alerts will be emailed as they happen instead.`,
          label: 'Unsubscribe',
        }
        : {
          title: 'Unsubscribe from these emails?',
          message: `You won't receive these notifications anymore. You can re-subscribe from notification settings.`,
          label: 'Unsubscribe',
        };
  }
}

export async function notificationActionsRoutes(app: FastifyInstance) {
  // RFC 8058 one-click POSTs arrive as form bodies (urlencoded or multipart),
  // and so does the confirm button. We never read the body — the token in the
  // path is the whole request — but Fastify 415s a POST whose content type
  // has no parser. Register no-op parsers in this plugin's scope when the
  // parent hasn't already registered one (duplicates throw).
  for (const type of ['application/x-www-form-urlencoded', 'multipart/form-data']) {
    if (!app.hasContentTypeParser(type)) {
      app.addContentTypeParser(type, { parseAs: 'string' }, (_req, _body, done) => done(null, {}));
    }
  }

  const routeOpts = {
    config: { public: true },
    // onSend runs after helmet's onRequest hook, so this replaces its header
    // for this route only.
    onSend: async (_request: FastifyRequest, reply: FastifyReply, payload: unknown) => {
      reply.header('content-security-policy', RESULT_PAGE_CSP);
      return payload;
    },
  };

  const invalidLink = () => renderResultPage({
    title: 'Invalid link',
    message: 'This action link is malformed. Open the dashboard to manage your notifications instead.',
  });
  // Single response for unknown/expired/already-used so attackers can't probe
  // which is which. UX-wise this is honest: "the link didn't work, go to settings."
  const expiredLink = () => renderResultPage({
    title: 'Link expired',
    message: 'This link has expired or already been used. Open notification settings to manage delivery directly.',
  });

  // GET: show what the link will do. Read-only — never consumes the token.
  app.get('/v1/notif/action/:token', routeOpts, async (request, reply) => {
    const parsed = paramsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).type('text/html').send(invalidLink());
    }
    const token = await peekActionToken(app.controlDb, parsed.data.token);
    if (!token) {
      return reply.code(410).type('text/html').send(expiredLink());
    }
    const copy = confirmCopy(token);
    return reply.code(200).type('text/html').send(renderResultPage({
      title: copy.title,
      message: copy.message,
      // Relative: posts back to this exact path on whatever host served it.
      confirm: { action: parsed.data.token, label: copy.label },
    }));
  });

  // POST: consume the token and apply. Target of the confirm button and of
  // mailbox-provider one-click unsubscribes.
  app.post('/v1/notif/action/:token', routeOpts, async (request, reply) => {
    const parsed = paramsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).type('text/html').send(invalidLink());
    }

    const consumed = await consumeActionToken(app.controlDb, parsed.data.token);
    if (!consumed) {
      return reply.code(410).type('text/html').send(expiredLink());
    }

    try {
      switch (consumed.action) {
        case 'snooze_function_24h': {
          const fid = String(consumed.payload.functionId ?? '');
          if (!fid) throw new Error('missing functionId in token payload');
          await snoozeFunctionFor24h(app.controlDb, consumed.userId, fid);
          return reply.code(200).type('text/html').send(renderResultPage({
            title: 'Snoozed for 24 hours',
            message: `You won't get more emails about this function until tomorrow. It'll auto-resume after that — no action needed.`,
          }));
        }
        case 'mute_function': {
          const fid = String(consumed.payload.functionId ?? '');
          if (!fid) throw new Error('missing functionId in token payload');
          await muteFunction(app.controlDb, consumed.userId, fid);
          return reply.code(200).type('text/html').send(renderResultPage({
            title: 'Function muted',
            message: `You won't get any more emails about this function. You can re-enable it from notification settings whenever you like.`,
          }));
        }
        case 'unsubscribe_template': {
          const tpl = String(consumed.payload.template ?? '');
          if (!tpl) throw new Error('missing template in token payload');
          if (tpl === 'weekly_digest') {
            await disableDigest(app.controlDb, consumed.userId);
            return reply.code(200).type('text/html').send(renderResultPage({
              title: 'Unsubscribed from the weekly digest',
              message: `You won't receive the weekly digest anymore. Failure alerts will be emailed as they happen. You can turn the digest back on from notification settings.`,
            }));
          }
          await unsubscribeFromTemplate(app.controlDb, consumed.userId, tpl);
          return reply.code(200).type('text/html').send(renderResultPage({
            title: 'Unsubscribed',
            message: `You won't receive these notifications anymore. You can re-subscribe from notification settings.`,
          }));
        }
      }
    } catch (err) {
      request.log.error({ err, action: consumed.action }, 'notification-actions: apply failed');
      return reply.code(500).type('text/html').send(renderResultPage({
        title: 'Something went wrong',
        message: `We couldn't apply that change. Open notification settings to do it directly.`,
      }));
    }
  });
}
