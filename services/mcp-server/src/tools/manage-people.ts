import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiGet, apiPost, apiPut, apiDelete } from '../api-client.js';

export function registerManagePeople(server: McpServer) {
  server.tool(
    'manage_people',
    `Use the app's People integration: search person/company, fetch profiles, queue email lookups, manage credits and BYOK keys.

Actions:
  - search_person       { app_id, current_role_title?, past_role_title?, current_company_name?, current_company_industry?, country?, region?, city?, education_school_name?, education_degree_name?, education_field_of_study?, page_size?, next_token?, enrich_profiles? }
                         Structured-filter search for a person. Boolean syntax works inside any field, e.g.
                           current_role_title: '(VP OR "Vice President") AND NOT assistant'
                           education_school_name: '(Harvard OR Stanford OR MIT OR Princeton OR Yale)'
                         Returns enriched person data and credit usage.
  - search_company      { app_id, industry?, country?, employee_count_max?, page_size?, next_token?, enrich_profiles? }
                         Structured-filter search for a company. Returns enriched company data and credit usage.
  - get_profile         { app_id, linkedin_profile_url, live_fetch? }
                         Fetch a full profile from a LinkedIn URL. live_fetch: "force" for live (not cached).
                         Returns cached flag and credit usage.
  - queue_email_lookup  { app_id, linkedin_profile_url }
                         Queue an async email lookup job. Returns lookup_id to poll with get_email_lookup.
  - get_email_lookup    { app_id, id }
                         Poll the status of an email lookup. Returns status, email (when complete), credits used.
  // BYOK actions are disabled — the platform manages the People key. If
  // your MCP client previously called set_byok_key/clear_byok_key they will
  // now return an error.
  // - set_byok_key   (disabled)
  // - clear_byok_key (disabled)

This tool wraps the app's /v1/:app_id/people/* routes (search, profile, email lookup, BYOK).`,
    {
      app_id: z.string().describe('The app ID'),
      action: z.enum([
        'search_person', 'search_company', 'get_profile', 'queue_email_lookup',
        'get_email_lookup', 'set_byok_key', 'clear_byok_key',
      ]).describe('The action to perform'),
      // search_person fields (snake_case → camelCase body)
      current_role_title: z.string().optional().describe('Current role/job title filter (for search_person)'),
      past_role_title: z.string().optional().describe('Past role/job title filter (for search_person)'),
      current_company_name: z.string().optional().describe('Current company name filter (for search_person)'),
      current_company_industry: z.string().optional().describe('Current company industry filter (for search_person)'),
      region: z.string().optional().describe('Region/state filter (for search_person)'),
      city: z.string().optional().describe('City filter (for search_person)'),
      education_school_name: z.string().optional().describe('Education school name filter, supports boolean (e.g. "(Harvard OR Stanford OR MIT)") — for search_person'),
      education_degree_name: z.string().optional().describe('Education degree filter (e.g. "MBA", "PhD") — for search_person'),
      education_field_of_study: z.string().optional().describe('Education field of study filter (e.g. "Computer Science") — for search_person'),
      // search_company fields
      industry: z.string().optional().describe('Industry filter (for search_company)'),
      employee_count_max: z.number().optional().describe('Maximum employee count filter (for search_company)'),
      // shared search fields
      country: z.string().optional().describe('Country filter (for search_person and search_company)'),
      page_size: z.number().optional().describe('Number of results per page (for search_person and search_company)'),
      next_token: z.string().optional().describe('Pagination token from a previous search response (for search_person and search_company)'),
      enrich_profiles: z.boolean().optional().describe('Whether to enrich results with full profile data (for search_person and search_company)'),
      // get_profile
      linkedin_profile_url: z.string().optional().describe('LinkedIn profile URL (required for get_profile and queue_email_lookup)'),
      live_fetch: z.enum(['force']).optional().describe('For get_profile: "force" to skip cache and fetch live'),
      // get_email_lookup
      id: z.string().optional().describe('Lookup ID (required for get_email_lookup)'),
      // set_byok_key
      api_key: z.string().optional().describe('People API key (required for set_byok_key)'),
    },
    {
      title: 'Manage People',
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
            result = await apiPost(`/v1/${app_id}/people/search/person`, {
              ...(args.current_role_title !== undefined && { currentRoleTitle: args.current_role_title }),
              ...(args.past_role_title !== undefined && { pastRoleTitle: args.past_role_title }),
              ...(args.current_company_name !== undefined && { currentCompanyName: args.current_company_name }),
              ...(args.current_company_industry !== undefined && { currentCompanyIndustry: args.current_company_industry }),
              ...(args.country !== undefined && { country: args.country }),
              ...(args.region !== undefined && { region: args.region }),
              ...(args.city !== undefined && { city: args.city }),
              ...(args.education_school_name !== undefined && { educationSchoolName: args.education_school_name }),
              ...(args.education_degree_name !== undefined && { educationDegreeName: args.education_degree_name }),
              ...(args.education_field_of_study !== undefined && { educationFieldOfStudy: args.education_field_of_study }),
              ...(args.page_size !== undefined && { pageSize: args.page_size }),
              ...(args.next_token !== undefined && { nextToken: args.next_token }),
              ...(args.enrich_profiles !== undefined && { enrichProfiles: args.enrich_profiles }),
            });
            break;
          }
          case 'search_company': {
            result = await apiPost(`/v1/${app_id}/people/search/company`, {
              ...(args.industry !== undefined && { industry: args.industry }),
              ...(args.country !== undefined && { country: args.country }),
              ...(args.employee_count_max !== undefined && { employeeCountMax: args.employee_count_max }),
              ...(args.page_size !== undefined && { pageSize: args.page_size }),
              ...(args.next_token !== undefined && { nextToken: args.next_token }),
              ...(args.enrich_profiles !== undefined && { enrichProfiles: args.enrich_profiles }),
            });
            break;
          }
          case 'get_profile': {
            if (!args.linkedin_profile_url) {
              return { content: [{ type: 'text' as const, text: 'Error: "linkedin_profile_url" is required for "get_profile".' }], isError: true as const };
            }
            result = await apiPost(`/v1/${app_id}/people/profile`, {
              linkedinProfileUrl: args.linkedin_profile_url,
              liveFetch: args.live_fetch,
            });
            break;
          }
          case 'queue_email_lookup': {
            if (!args.linkedin_profile_url) {
              return { content: [{ type: 'text' as const, text: 'Error: "linkedin_profile_url" is required for "queue_email_lookup".' }], isError: true as const };
            }
            result = await apiPost(`/v1/${app_id}/people/profile/email`, {
              linkedinProfileUrl: args.linkedin_profile_url,
            });
            break;
          }
          case 'get_email_lookup': {
            if (!args.id) {
              return { content: [{ type: 'text' as const, text: 'Error: "id" is required for "get_email_lookup".' }], isError: true as const };
            }
            result = await apiGet(`/v1/${app_id}/people/email-lookup/${encodeURIComponent(args.id)}`);
            break;
          }
          case 'set_byok_key':
          case 'clear_byok_key': {
            // BYOK disabled per product decision — the platform always uses
            // its own People key. Re-enable by uncommenting the route
            // handlers in services/control-api/src/routes/people.ts and
            // the implementations below.
            //
            // case 'set_byok_key': {
            //   if (!args.api_key) {
            //     return { content: [{ type: 'text' as const, text: 'Error: "api_key" is required for "set_byok_key".' }], isError: true as const };
            //   }
            //   result = await apiPut(`/v1/${app_id}/people/byok`, { apiKey: args.api_key });
            //   break;
            // }
            // case 'clear_byok_key': {
            //   result = await apiDelete(`/v1/${app_id}/people/byok`);
            //   break;
            // }
            return { content: [{ type: 'text' as const, text: 'BYOK is not supported — the platform manages the People key.' }], isError: true as const };
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
