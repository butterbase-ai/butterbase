import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { callMcpTool, getToolCatalog } from '../mcp-client.js';

describe('MCP Client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getToolCatalog()', () => {
    it('returns an array with exactly one tool: manage_app', () => {
      const catalog = getToolCatalog();
      expect(catalog).toHaveLength(1);
      expect(catalog[0].name).toBe('manage_app');
      expect(catalog[0].description).toBeDefined();
      expect(catalog[0].parameters).toBeDefined();
    });

    it('manage_app tool has parameters object with action and params fields', () => {
      const catalog = getToolCatalog();
      const manageTool = catalog[0];
      expect(manageTool.parameters).toHaveProperty('type', 'object');
      expect(manageTool.parameters).toHaveProperty('properties');
      expect(manageTool.parameters.properties).toHaveProperty('action');
      expect(manageTool.parameters.properties).toHaveProperty('params');
      expect(manageTool.parameters).toHaveProperty('required');
    });
  });

  describe('callMcpTool()', () => {
    it('calls MCP endpoint with correct JSON-RPC format and Bearer token header', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: { apps: [] } }),
      });
      global.fetch = mockFetch;

      const jwt = 'test-jwt-token';
      const result = await callMcpTool('manage_app', { action: 'list' }, jwt);

      expect(result).toEqual({ ok: true, result: { apps: [] } });
      expect(mockFetch).toHaveBeenCalledOnce();

      const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/mcp');
      expect(options.method).toBe('POST');
      expect(options.headers).toHaveProperty('authorization', `Bearer ${jwt}`);
      expect(options.headers).toHaveProperty('content-type', 'application/json');

      const body = JSON.parse(options.body as string);
      expect(body.jsonrpc).toBe('2.0');
      expect(body.method).toBe('tools/call');
      expect(body.params).toEqual({ name: 'manage_app', arguments: { action: 'list' } });
    });

    it('returns { ok: false, error } on HTTP 500 without throwing', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 500,
      });
      global.fetch = mockFetch;

      const result = await callMcpTool('manage_app', { action: 'list' }, 'test-jwt');

      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toContain('500');
      // Should not throw
    });

    it('handles JSON.parse errors gracefully', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => {
          throw new Error('Invalid JSON');
        },
      });
      global.fetch = mockFetch;

      const result = await callMcpTool('manage_app', { action: 'list' }, 'test-jwt');

      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();
      // Should not throw
    });

    it('returns { ok: false, error } for MCP error response', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          error: { message: 'Tool not found' },
        }),
      });
      global.fetch = mockFetch;

      const result = await callMcpTool('unknown_tool', { action: 'list' }, 'test-jwt');

      expect(result.ok).toBe(false);
      expect(result.error).toBe('Tool not found');
    });

    it('handles network errors gracefully', async () => {
      const mockFetch = vi.fn().mockRejectedValueOnce(new Error('Network error'));
      global.fetch = mockFetch;

      const result = await callMcpTool('manage_app', { action: 'list' }, 'test-jwt');

      expect(result.ok).toBe(false);
      expect(result.error).toContain('Network error');
      // Should not throw
    });
  });
});
