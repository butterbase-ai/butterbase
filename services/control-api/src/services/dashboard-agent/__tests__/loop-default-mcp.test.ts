/**
 * Regression tests for U40 ("deploy_frontend fails 'Failed to parse URL from
 * undefined'"): `defaultMcp()` (loop.ts) used to hand internal loop-callers
 * (deploy.ts, repo-sync.ts, schema-context.ts, deploy-function.ts) the raw,
 * UNPARSED MCP `tools/call` JSON-RPC result — `{content:[{type:'text',
 * text}], isError?}` — instead of the flat payload those callers read fields
 * off directly (e.g. `create.upload_url`). `deploy.ts` then called
 * `fetch(undefined, ...)`, which throws Node's opaque
 * `TypeError [ERR_INVALID_URL]: Failed to parse URL from undefined`.
 *
 * These tests exercise `parseMcpToolResult`, the exported unwrap function
 * `defaultMcp()` now applies to every result before handing it back.
 *
 * Mocks mirror loop.test.ts's minimal set — only enough for `../loop.js` to
 * import cleanly; nothing here calls `runAgentTurn`.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../store.js', () => ({
  appendMessage: vi.fn(),
  listMessages: vi.fn(),
  getRecentToolArgs: vi.fn(),
  upsertSnapshotLabel: vi.fn(),
  getConversation: vi.fn(),
  updateConversationTitle: vi.fn(),
}));

vi.mock('../mcp-client.js', () => ({
  callMcpTool: vi.fn(),
}));

vi.mock('../approvals-store.js', () => ({
  createApproval: vi.fn(),
  checkTrust: vi.fn(),
}));

import { parseMcpToolResult } from '../loop.js';

describe('parseMcpToolResult (defaultMcp unwrap)', () => {
  it('parses the text content item of a realistic JSON-RPC envelope into the flat payload', () => {
    const envelope = {
      content: [{ type: 'text', text: '{"upload_url":"https://s3.example/put","deployment_id":"dep_1"}' }],
    };

    const result = parseMcpToolResult('manage_frontend', envelope);

    expect(result).toEqual({ upload_url: 'https://s3.example/put', deployment_id: 'dep_1' });
  });

  it('throws with the tool text when the envelope carries isError', () => {
    const envelope = {
      content: [{ type: 'text', text: 'Error: "deployment_id" is required for the "start_from_source" action.' }],
      isError: true,
    };

    expect(() => parseMcpToolResult('manage_frontend', envelope)).toThrow(
      /"deployment_id" is required for the "start_from_source" action/,
    );
  });

  it('throws a generic message when isError is set but no text content is present', () => {
    const envelope = { content: [], isError: true };

    expect(() => parseMcpToolResult('manage_frontend', envelope)).toThrow(/manage_frontend.*error/i);
  });

  it('returns non-envelope results unchanged (already-flat mocks stay compatible)', () => {
    const flat = { deployment_id: 'dep_2', upload_url: 'https://s3.example/put' };

    expect(parseMcpToolResult('manage_frontend', flat)).toBe(flat);
  });

  it('returns plain-text content as-is when it is not JSON', () => {
    const envelope = { content: [{ type: 'text', text: 'not json' }] };

    expect(parseMcpToolResult('manage_frontend', envelope)).toBe('not json');
  });
});
