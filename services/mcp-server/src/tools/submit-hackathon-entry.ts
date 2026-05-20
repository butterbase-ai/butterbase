import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiPost } from '../api-client.js';

interface SubmissionResponse {
  submission: {
    id: string;
    hackathon_slug: string;
    version: number;
    created_at: string;
    updated_at: string;
    data: Record<string, unknown>;
    app_id: string | null;
  };
  participant_created: boolean;
}

interface FieldDef {
  key: string;
  label: string;
  type: string;
  required: boolean;
  display: 'primary' | 'detail' | 'private';
  description?: string;
  options?: string[];
  is_url?: boolean;
}

interface OpenHackathon {
  slug: string;
  name: string;
  starts_at: string;
  ends_at: string;
  submission_deadline: string;
}

interface ResolveResponse {
  matched: {
    slug: string;
    name: string;
    submission_deadline: string;
    ends_at: string;
    field_schema: { fields: FieldDef[] };
  } | null;
  match_reason: 'submission_code' | 'already_bound' | 'single_open' | null;
  open_hackathons: OpenHackathon[];
}

function placeholderForField(f: FieldDef): string {
  const req = f.required ? 'required' : 'optional';
  const desc = f.description ? `: ${f.description}` : '';
  if (f.options && f.options.length) {
    return `<one of: ${f.options.join(' | ')} (${req})${desc}>`;
  }
  if (f.is_url || f.type === 'url') {
    return `<url, ${req}${desc}>`;
  }
  return `<${f.type}, ${req}${desc}>`;
}

function buildNextCallTemplate(
  matched: NonNullable<ResolveResponse['matched']>,
  submission_code?: string,
  app_id?: string,
  hackathon_slug?: string,
): Record<string, unknown> {
  const dataTemplate: Record<string, string> = {};
  for (const f of matched.field_schema.fields) {
    dataTemplate[f.key] = placeholderForField(f);
  }
  const args: Record<string, unknown> = {
    action: 'submit',
    hackathon_slug: hackathon_slug ?? matched.slug,
    app_id: app_id ?? '<your butterbase app_id, e.g. app_abc123 — strongly recommended for scoring>',
    data: dataTemplate,
  };
  if (submission_code) args.submission_code = submission_code;
  return {
    tool: 'prep_and_submit_hackathon_entry',
    arguments: args,
    instructions: 'Replace each placeholder in "data" with the user-confirmed value, then call this tool with the result. Show every field label/description to the user and get explicit confirmation before submitting.',
  };
}

export function registerSubmitHackathonEntry(server: McpServer) {
  server.tool(
    'prep_and_submit_hackathon_entry',
    `Prep and submit your project to a Butterbase hackathon. Two-step flow.

The tool resolves which hackathon you mean from your submission_code (or, if
you've already submitted before, your existing binding). You do NOT pass a
slug — that's figured out for you. If resolution is ambiguous (no code, not
yet bound, and multiple hackathons are open), the tool returns the list of
open hackathons; ask the user which one they mean and re-run with a code.

  STEP 1 — action: "prep"
    Resolves the hackathon and returns its field_schema if exactly one is
    identified. Pass submission_code when you have it. Otherwise the tool
    will fall back to "user already bound" or "only one hackathon open".
    Use the schema to:
      • Show the user every field's "label" and "description" (never the internal "key").
      • Propose a value for each field and wait for the user's explicit
        confirmation before STEP 2.
    Do NOT auto-fill values from guesses, prior context, or app metadata without
    showing the user every field value first.

    If resolution returns multiple open hackathons with no match, present
    "open_hackathons" to the user and ask them to provide the submission_code.

  STEP 2 — action: "submit"
    Submits the confirmed "data" object. Pass hackathon_slug = matched.slug from
    the prep response so submit always targets the same hackathon prep resolved
    (matters when multiple are open). Re-running updates the existing submission
    and bumps version. Closes after the hackathon's submission_deadline.

App scoring:
  Always pass app_id on submit when you can. Hackathon scoring awards up to 50
  points for a demo URL on butterbase.dev and up to 50 additional points for
  Butterbase features measured on that specific app (database, functions,
  deployed frontend, auth users, storage, OAuth, realtime, integrations, etc.).
  Without app_id only the demo URL is scored, so entries without it almost
  always rank lower. Including app_id also ties the submission to a real app,
  which is much better for human judges.

Submission code:
  On the FIRST submission you must include the submission_code provided by
  the hackathon organizers. The same code is used to identify the hackathon
  during prep, so pass it on prep too. After the first successful submission
  the code is no longer required (the user is bound by user_id).

Recommended flow:
  1. Get the submission_code from the user (skip if they've already submitted before).
  2. Call with action: "prep", submission_code to resolve + retrieve the schema.
     • If matched is null and open_hackathons has multiple entries, ask the user
       which one and re-run with a code.
  3. Show the user each field's label / description, propose values, and wait
     for confirmation.
  4. Call with action: "submit", hackathon_slug = matched.slug from prep,
     data: {...confirmed values}, app_id, and submission_code (if provided in
     step 1).

Returns:
  prep   → { matched: { slug, name, submission_deadline, ends_at, field_schema } | null,
             match_reason, open_hackathons,
             next_call?: { tool, arguments, instructions } }
           When matched is non-null, next_call contains a fully-formed example
           submit invocation with placeholders for each field. Use it as the
           literal shape for STEP 2: replace each placeholder in arguments.data
           with the user-confirmed value, then call this tool with those args.
  submit → { submission: { id, hackathon_slug, version, data, app_id, ... }, participant_created }`,
    {
      action: z.enum(['prep', 'submit'])
        .describe('"prep" resolves the hackathon and returns its schema. "submit" sends the confirmed data.'),
      hackathon_slug: z.string().optional()
        .describe('Slug of the hackathon. Optional. Pass on submit using the slug returned by prep (matched.slug) so submit targets the exact hackathon prep resolved. Ignored on prep.'),
      submission_code: z.string().optional()
        .describe('Per-hackathon code from the organizer. Used to identify which open hackathon the user means and to bind them on first submission. Required for prep when multiple hackathons are open and the user is not yet bound. Required on the FIRST submission. Ignored on submit after the user is already a participant.'),
      app_id: z.string().optional()
        .describe('Butterbase app id for the project being submitted (e.g. app_abc123). Strongly recommended on submit: scoring awards up to 50 extra points for Butterbase usage on this app. Ignored on prep.'),
      data: z.union([z.record(z.unknown()), z.string()]).optional()
        .describe('Submission fields per the hackathon field_schema, as an object keyed by field "key". Required on submit; ignored on prep. Example: {"project_name":"My App","demo_url":"https://my-app.butterbase.app","description":"What it does"}. A JSON-encoded string is also accepted and will be parsed.'),
    },
    {
      title: 'Prep and Submit Hackathon Entry',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    async (args) => {
      if (args.action === 'prep') {
        const result = await apiPost<ResolveResponse>('/hackathons/resolve', {
          submission_code: args.submission_code,
        });
        const enriched = result.matched
          ? { ...result, next_call: buildNextCallTemplate(result.matched, args.submission_code) }
          : result;
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(enriched, null, 2) }],
        };
      }

      let data: Record<string, unknown> | undefined;
      if (typeof args.data === 'string') {
        try {
          const parsed = JSON.parse(args.data);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            data = parsed as Record<string, unknown>;
          }
        } catch {
          // fall through to missing-data handling
        }
      } else if (args.data) {
        data = args.data;
      }

      if (!data) {
        // Self-healing: re-resolve so we can hand back the schema + an exact
        // next_call template the caller just has to fill in. Avoids retry loops
        // when the model can't infer the shape from the static tool schema.
        const resolved = await apiPost<ResolveResponse>('/hackathons/resolve', {
          submission_code: args.submission_code,
        }).catch(() => null);
        const matched = resolved?.matched ?? null;
        const errorPayload = {
          error: 'data_required',
          message: 'data is required when action is "submit". Pass an object keyed by each field_schema field "key" (the user-confirmed values).',
          field_schema: matched?.field_schema ?? null,
          next_call: matched
            ? buildNextCallTemplate(matched, args.submission_code, args.app_id, args.hackathon_slug)
            : null,
          hint: matched
            ? 'Use next_call as the exact shape for your retry. Replace each placeholder string in data with the user-confirmed value.'
            : 'Run action: "prep" first to resolve the hackathon and retrieve the field_schema.',
        };
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(errorPayload, null, 2) }],
        };
      }

      const submitArgs: Record<string, unknown> = { data };
      if (args.hackathon_slug) submitArgs.hackathon_slug = args.hackathon_slug;
      if (args.submission_code) submitArgs.submission_code = args.submission_code;
      if (args.app_id) submitArgs.app_id = args.app_id;
      const result = await apiPost<SubmissionResponse>('/hackathons/submissions', submitArgs);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}
