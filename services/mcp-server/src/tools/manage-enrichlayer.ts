import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiGet, apiPost, apiPut, apiDelete } from '../api-client.js';

export function registerManageEnrichlayer(server: McpServer) {
  server.tool(
    'manage_enrichlayer',
    `Use the app's EnrichLayer integration: search person/company, fetch profiles, queue email lookups, manage credits and BYOK keys.

Actions:
  - search_person       { app_id, query }
                         Search for a person. Returns enriched person data and credit usage.
  - search_company      { app_id, query }
                         Search for a company. Returns enriched company data and credit usage.
  - get_profile         { app_id, linkedin_profile_url, live_fetch? }
                         Fetch a full profile from a LinkedIn URL. live_fetch: "force" for live (not cached).
                         Returns cached flag and credit usage.
  - queue_email_lookup  { app_id, linkedin_profile_url }
                         Queue an async email lookup job. Returns lookup_id to poll with get_email_lookup.
  - get_email_lookup    { app_id, id }
                         Poll the status of an email lookup. Returns status, email (when complete), credits used.
  - get_credit_balance  { app_id }
                         Read the platform's EnrichLayer credit balance.
  - set_byok_key        { app_id, api_key }
                         Set this app's Bring-Your-Own-Key (BYOK) for EnrichLayer. Encrypts at rest.
  - clear_byok_key      { app_id }
                         Clear this app's BYOK, reverting to the platform key.

This tool wraps the app's /v1/:app_id/enrichlayer/* routes (search, profile, email lookup, BYOK, credits).`,
    {
      app_id: z.string().describe('The app ID'),
      action: z.enum([
        'search_person', 'search_company', 'get_profile', 'queue_email_lookup',
        'get_email_lookup', 'get_credit_balance', 'set_byok_key', 'clear_byok_key',
      ]).describe('The action to perform'),
      // search_person / search_company
      query: z.string().optional().describe('Search query (required for search_person, search_company)'),
      // get_profile
      linkedin_profile_url: z.string().optional().describe('LinkedIn profile URL (required for get_profile, queue_email_lookup, get_email_lookup)'),
      live_fetch: z.enum(['force']).optional().describe('For get_profile: "force" to skip cache and fetch live'),
      // get_email_lookup
      id: z.string().optional().describe('Lookup ID (required for get_email_lookup)'),
      // set_byok_key
      api_key: z.string().optional().describe('EnrichLayer API key (required for set_byok_key)'),
    },
    {
      title: 'Manage EnrichLayer',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    async (args) => {
      try {
        const { app_id, action } = args;
        let result: unknown;
        switch (action) {
          case 'search_person': {
            if (!args.query) {
              return { content: [{ type: 'text' as const, text: 'Error: "query" is required for "search_person".' }], isError: true as const };
            }
            result = await apiPost(`/v1/${app_id}/enrichlayer/search/person`, {
              query: args.query,
            });
            break;
          }
          case 'search_company': {
            if (!args.query) {
              return { content: [{ type: 'text' as const, text: 'Error: "query" is required for "search_company".' }], isError: true as const };
            }
            result = await apiPost(`/v1/${app_id}/enrichlayer/search/company`, {
              query: args.query,
            });
            break;
          }
          case 'get_profile': {
            if (!args.linkedin_profile_url) {
              return { content: [{ type: 'text' as const, text: 'Error: "linkedin_profile_url" is required for "get_profile".' }], isError: true as const };
            }
            result = await apiPost(`/v1/${app_id}/enrichlayer/profile`, {
              linkedinProfileUrl: args.linkedin_profile_url,
              liveFetch: args.live_fetch,
            });
            break;
          }
          case 'queue_email_lookup': {
            if (!args.linkedin_profile_url) {
              return { content: [{ type: 'text' as const, text: 'Error: "linkedin_profile_url" is required for "queue_email_lookup".' }], isError: true as const };
            }
            result = await apiPost(`/v1/${app_id}/enrichlayer/profile/email`, {
              linkedinProfileUrl: args.linkedin_profile_url,
            });
            break;
          }
          case 'get_email_lookup': {
            if (!args.id) {
              return { content: [{ type: 'text' as const, text: 'Error: "id" is required for "get_email_lookup".' }], isError: true as const };
            }
            result = await apiGet(`/v1/${app_id}/enrichlayer/email-lookup/${encodeURIComponent(args.id)}`);
            break;
          }
          case 'get_credit_balance': {
            result = await apiGet(`/v1/${app_id}/enrichlayer/credit-balance`);
            break;
          }
          case 'set_byok_key': {
            if (!args.api_key) {
              return { content: [{ type: 'text' as const, text: 'Error: "api_key" is required for "set_byok_key".' }], isError: true as const };
            }
            result = await apiPut(`/v1/${app_id}/enrichlayer/byok`, {
              apiKey: args.api_key,
            });
            break;
          }
          case 'clear_byok_key': {
            result = await apiDelete(`/v1/${app_id}/enrichlayer/byok`);
            break;
          }
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true as const };
      }
    },
  );
}
