import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiGet } from '../api-client.js';

interface PartnerListItem {
  slug: string;
  display_name: string;
  description: string | null;
  docs_url: string | null;
  proxy_url_template: string;
  contact_message: string;
  status: 'available' | 'exhausted';
}

interface PartnerListResponse {
  partners: PartnerListItem[];
}

export function registerListPartnerApis(server: McpServer) {
  server.tool(
    'list_partner_apis',
    `List third-party partner APIs (Seedance, Z.AI / 智谱, Qingyun, etc.) configured
for a specific Butterbase hackathon. Multiple hackathons can be open at once,
so the caller MUST name which one with hackathon_slug.

Each entry returns:
  - slug: identifier used in the proxy URL.
  - display_name + description.
  - proxy_url_template: full URL with "{path}" placeholder. Substitute "{path}"
    with the path you'd hit on the partner directly (e.g. "/v1/chat/completions"),
    set Authorization to your bb_sk_ project key, and send the request body
    unchanged. Butterbase handles the partner-side auth.
  - status: "available" (keys still work) or "exhausted" (pool is dead — show
    contact_message to the user).
  - contact_message: what to tell the user when status === "exhausted".

Call this tool once per session before suggesting partner-API integrations,
and again after a 503 PARTNER_QUOTA_EXHAUSTED response.

Error handling:
  - 503 PARTNER_QUOTA_EXHAUSTED: pool is dead — surface contact_message to the user.
  - 503 HACKATHON_NOT_IN_WINDOW: the named hackathon is outside its submission window.
    Terminal — do NOT retry; pick a different hackathon_slug.
  - 404 HACKATHON_NOT_FOUND: the slug doesn't match any hackathon. Check spelling.
  - 403 NOT_HACKATHON_PARTICIPANT: user isn't a participant of the named hackathon.`,
    {
      app_id: z.string().describe('Butterbase app id (e.g. "app_abc123")'),
      hackathon_slug: z.string().describe('Slug of the hackathon whose partner pools to list. Required — multiple hackathons can be open simultaneously.'),
    },
    {
      title: 'List Partner APIs',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    async ({ app_id, hackathon_slug }) => {
      const data = await apiGet<PartnerListResponse>(
        `/v1/${app_id}/partners/${encodeURIComponent(hackathon_slug)}`,
      );
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(data.partners, null, 2),
        }],
      };
    },
  );
}
