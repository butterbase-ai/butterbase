import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiPost } from '../api-client.js';

interface SubmitSuggestionResponse {
  suggestion: {
    id: string;
    category: string;
    severity: string | null;
    description: string;
    affected_tool: string | null;
    proposed_solution: string | null;
    source: string;
    status: string;
    created_at: string;
  };
}

export function registerSubmitSuggestion(server: McpServer) {
  server.tool(
    'submit_suggestion',
    `Submit feedback, bug reports, or feature suggestions to the Butterbase platform team.

Use this tool when you encounter issues with Butterbase tools, want to suggest improvements,
or when a user asks you to report something to the Butterbase team.

Categories:
  - bug_report: Something isn't working as expected or documented.
      Example: "apply_schema fails silently when adding an enum column with a default value"
  - feature_request: A capability that doesn't exist yet but would be useful.
      Example: "Support for composite unique constraints across multiple columns"
  - improvement: An existing feature works but could be better.
      Example: "get_schema should include index definitions in its output"
  - documentation: The docs are missing, unclear, or incorrect.
      Example: "The deploy_function tool description doesn't mention the 50MB size limit"

Source:
  - agent: You (the AI agent) are reporting this on your own initiative
  - human_prompted: The human user asked you to report this

Returns: The created suggestion with a unique ID and status.

Example output:
  {
    suggestion: {
      id: "a1b2c3d4-...",
      category: "bug_report",
      severity: "medium",
      description: "apply_schema returns success but...",
      affected_tool: "apply_schema",
      status: "new",
      created_at: "2026-04-05T10:00:00Z"
    }
  }

Recent tool calls are automatically captured as context — you don't need to
manually describe what you called. Just describe the issue or suggestion clearly.

Idempotency: Each call creates a new suggestion. Avoid submitting duplicates.`,
    {
      category: z.enum(['bug_report', 'feature_request', 'improvement', 'documentation'])
        .describe('Type of feedback'),
      description: z.string().min(10)
        .describe('Clear description of the issue, suggestion, or request. Be specific.'),
      severity: z.enum(['low', 'medium', 'high', 'critical']).optional()
        .describe('How impactful is this? critical = blocks work, high = significant pain, medium = annoying, low = minor'),
      affected_tool: z.string().optional()
        .describe('Name of the Butterbase tool affected (e.g. apply_schema, deploy_function)'),
      proposed_solution: z.string().optional()
        .describe('Your suggested fix or approach, if you have one'),
      source: z.enum(['agent', 'human_prompted']).optional()
        .describe('Whether you are reporting this on your own or at the user\'s request (default: agent)'),
      app_id: z.string().optional()
        .describe('The app ID if this suggestion relates to a specific app'),
      agent_context: z.record(z.unknown()).optional()
        .describe('Any additional structured context you want to attach (error messages, parameters tried, etc.)'),
    },
    {
      title: 'Submit Suggestion',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    async (args) => {
      const result = await apiPost<SubmitSuggestionResponse>('/suggestions', args);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    }
  );
}
