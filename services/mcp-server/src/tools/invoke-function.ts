import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getBaseUrl, getHeaders } from '../api-client.js';

export function registerInvokeFunction(server: McpServer) {
  server.tool(
    'invoke_function',
    `Invoke a deployed function and return its full HTTP response.

Example — POST with body:
  Input: {
    app_id: "app_abc123",
    function_name: "submit-inquiry",
    body: { email: "user@example.com", message: "hello" }
  }
  Output: {
    status: 200,
    headers: { "content-type": "application/json" },
    body: { id: "uuid-1234" },
    duration_ms: 47
  }

Example — GET (no body):
  Input: {
    app_id: "app_abc123",
    function_name: "public-catalog",
    method: "GET"
  }

Parameters:
  - method defaults to POST. The function's trigger config determines which methods are valid.
  - body is sent as JSON. Omit for GET/HEAD requests.
  - headers are merged with the default auth headers.

Use this to:
  - Test a function immediately after deployment
  - Debug function logic with different inputs
  - Verify function response format and status codes

Common errors:
  - RESOURCE_NOT_FOUND: Function doesn't exist, use manage_function (action: "list") to verify
  - Function timeout: Increase timeoutMs in deploy_function
  - Runtime error: Check manage_function (action: "get_logs") for stack trace

Idempotency: Depends on function implementation (may have side effects).`,
    {
      app_id: z.string().describe('The app ID'),
      function_name: z.string().describe('The function name to invoke'),
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional().default('POST').describe('HTTP method (default: POST)'),
      body: z.any().optional().describe('Request body (sent as JSON)'),
      headers: z.record(z.string()).optional().describe('Additional request headers'),
    },
    {
      title: 'Invoke Function',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    async (args) => {
      const { app_id, function_name, method, body, headers: customHeaders } = args;

      const url = `${getBaseUrl()}/v1/${app_id}/fn/${function_name}`;
      const defaultHeaders = getHeaders() as Record<string, string>;
      const mergedHeaders: Record<string, string> = { ...defaultHeaders, ...customHeaders };

      const hasBody = method !== 'GET' && body !== undefined;
      if (!hasBody) {
        delete mergedHeaders['Content-Type'];
      }

      const start = Date.now();
      const res = await fetch(url, {
        method,
        headers: mergedHeaders,
        body: hasBody ? JSON.stringify(body) : undefined,
      });
      const duration_ms = Date.now() - start;

      const contentType = res.headers.get('content-type') || '';
      const responseHeaders: Record<string, string> = {};
      for (const [key, value] of res.headers.entries()) {
        responseHeaders[key] = value;
      }

      let responseBody: unknown;
      if (contentType.includes('application/json')) {
        try {
          responseBody = await res.json();
        } catch {
          responseBody = await res.text();
        }
      } else {
        responseBody = await res.text();
      }

      const result = {
        status: res.status,
        headers: responseHeaders,
        body: responseBody,
        duration_ms,
      };

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );
}
