# TODO — Deferred work

Things explicitly carved out of current scope. Don't pick these up without re-scoping with the user.

## Social broadcast posting (Phase 1+) — deferred follow-ups

Captured during the 2026-06-15 social-broadcast brainstorm. Phase 1 is broadcast-only, text + optional link URL, against Twitter / LinkedIn / Reddit via Composio.

- **Per-record social outreach.** From a Company or Person detail page, post targeted content (reply on their LinkedIn, tweet at them, share an article mentioning them). Posts should append to the record's activity feed. Build on the Phase 1 posting service (`send-social-post`) as the action backend.

- **Copilot-proposed social posts.** Extend `agent-chat` with a `confirm_action` that proposes posts based on CRM context (deal wins, prospect engagement, meeting follow-ups). Reuses the Phase 1 posting service.

- **Full media support.** Multi-image and video uploads: up to 4 images per Twitter post, LinkedIn images + video, Reddit gallery posts. Builds on Phase 1's text-only + single-URL foundation. Each channel has its own upload flow (Twitter chunked upload, `LINKEDIN_REGISTER_IMAGE_UPLOAD`, Reddit gallery API).

## Known issues from initial build

- **Twitter requires Bring-Your-Own X Developer credentials.** Composio removed managed credentials for the Twitter toolkit on 2026-02-12 ([changelog](https://github.com/ComposioHQ/composio/blob/next/docs/content/changelog/02-12-26-twitter-managed-credentials-removal.mdx)). That's why `manage_integrations` action=configure toolkit=twitter returns INTERNAL_ERROR. To enable Twitter:
  1. Create an X Developer account at https://console.x.com/, create a new App, generate an OAuth 2.0 Client ID + Client Secret + Bearer Token.
  2. In the X Developer App's "User authentication settings", set the callback URL to `https://backend.composio.dev/api/v1/auth-apps/add` and app type to "Web App (Confidential Client)".
  3. In the Composio dashboard, create a custom auth config for Twitter: toggle "use your own developer credentials", paste in the Client ID / Secret / Bearer Token, save.
  4. Then `manage_integrations.configure toolkit=twitter` should succeed (or skip — the connection can be initiated directly from the Composio dashboard).
  Until then the composer will still let users tick Twitter; sends will fail at publish time with `channels_not_connected`.
