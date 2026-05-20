// Public, token-gated endpoint that backs the inline action buttons in
// outbound notification emails ("Snooze 24h", "Mute this function",
// "Unsubscribe").
//
// Why GET, not POST: email clients only fire links via GET. Tokens are
// single-use (consume_action_token enforces this), so a security scanner
// pre-fetching the URL once burns the token but cannot redo the action.
// Outlook/Gmail link-prefetch behavior is the main reason single-use +
// confirmation copy matters here.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  consumeActionToken,
  snoozeFunctionFor24h,
  muteFunction,
  unsubscribeFromTemplate,
} from '../services/notification-prefs.service.js';
import { escapeHtml } from '../services/auth/email-layout.js';

const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;

function renderResultPage(opts: {
  title: string;
  message: string;
  appUrl?: string;
}): string {
  const appUrl = opts.appUrl || (process.env.DASHBOARD_URL || 'https://dashboard.butterbase.ai');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(opts.title)} — Butterbase</title></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0a0a0a;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f4f5;min-height:100vh;">
<tr><td align="center" style="padding:64px 16px;vertical-align:middle;">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;width:100%;background:#ffffff;border-radius:12px;">
<tr><td style="padding:40px 32px;text-align:center;">
<h1 style="margin:0 0 12px 0;font-size:20px;font-weight:600;color:#0a0a0a;">${escapeHtml(opts.title)}</h1>
<p style="margin:0 0 24px 0;font-size:14px;color:#525252;line-height:1.5;">${escapeHtml(opts.message)}</p>
<a href="${escapeHtml(appUrl)}" style="display:inline-block;padding:12px 20px;font-size:14px;font-weight:600;color:#ffffff;background:#0a0a0a;text-decoration:none;border-radius:8px;">Open dashboard</a>
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

const paramsSchema = z.object({ token: z.string().regex(TOKEN_RE) });

export async function notificationActionsRoutes(app: FastifyInstance) {
  app.get(
    '/v1/notif/action/:token',
    { config: { public: true } },
    async (request, reply) => {
      const parsed = paramsSchema.safeParse(request.params);
      if (!parsed.success) {
        return reply.code(400).type('text/html').send(renderResultPage({
          title: 'Invalid link',
          message: 'This action link is malformed. Open the dashboard to manage your notifications instead.',
        }));
      }

      const consumed = await consumeActionToken(app.controlDb, parsed.data.token);
      if (!consumed) {
        // Single response for unknown/expired/already-used so attackers
        // can't probe which is which. UX-wise this is honest: "the link
        // didn't work, go to settings."
        return reply.code(410).type('text/html').send(renderResultPage({
          title: 'Link expired',
          message: 'This link has expired or already been used. Open notification settings to manage delivery directly.',
        }));
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
    },
  );
}
