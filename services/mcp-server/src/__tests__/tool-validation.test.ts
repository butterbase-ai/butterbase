import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import pg from 'pg';
import { createRegisteredToolValidator, getRegisteredToolValidator } from '../tool-validation.js';
import { createRegisteredToolServer } from '../tool-registry.js';

describe('registered executable validation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('uses the SDK schema and parsed defaults without invoking callbacks', async () => {
    const server = new McpServer({ name: 'validation', version: '1' });
    const handler = vi.fn(async () => ({ content: [] }));
    const tool = server.registerTool('fixture', { inputSchema: { limit: z.number().default(7) } }, handler);
    const validator = createRegisteredToolValidator(server);
    expect(await validator.validate('fixture', {})).toEqual({ toolName: 'fixture', args: { limit: 7 } });
    tool.update({ paramsSchema: { limit: z.number().default(11) } });
    expect(await validator.validate('fixture', {})).toEqual({ toolName: 'fixture', args: { limit: 11 } });
    expect(handler).not.toHaveBeenCalled();
    tool.disable();
    await expect(validator.validate('fixture', {})).rejects.toMatchObject({ code: 'tool_unavailable' });
    tool.enable();
    tool.update({ name: 'renamed' });
    await expect(validator.validate('fixture', {})).rejects.toMatchObject({ code: 'tool_unavailable' });
    expect((await validator.validate('renamed', {})).toolName).toBe('renamed');
  });

  it('fails closed on unknown names, missing schemas, malformed arguments and SDK shape drift', async () => {
    const server = new McpServer({ name: 'validation', version: '1' });
    const handler = vi.fn(async () => ({ content: [] }));
    server.registerTool('fixture', { inputSchema: { outbox_id: z.string().uuid() } }, handler);
    server.registerTool('schema_less', {}, handler);
    const validator = createRegisteredToolValidator(server);
    for (const name of ['unknown', '__proto__', 'constructor']) {
      await expect(validator.validate(name, {})).rejects.toMatchObject({ code: 'tool_unavailable' });
    }
    await expect(validator.validate('schema_less', {})).rejects.toMatchObject({ code: 'tool_schema_unavailable' });
    for (const args of [{}, null, [], 'private-input', { outbox_id: 'private-input' }]) {
      const error = await validator.validate('fixture', args).catch(error => error);
      expect(error.code).toBe('tool_arguments_invalid');
      expect(JSON.stringify(error)).not.toContain('private-input');
      expect(error.message).toBe('Tool arguments are invalid');
    }
    await expect(createRegisteredToolValidator({} as McpServer).validate('fixture', {}))
      .rejects.toMatchObject({ code: 'tool_registry_unavailable' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns safe errors when a schema parser throws sensitive details', async () => {
    const server = new McpServer({ name: 'validation', version: '1' });
    server.registerTool('fixture', { inputSchema: { value: z.string().transform(() => { throw new Error('private-input'); }) } }, async () => ({ content: [] }));
    await expect(createRegisteredToolValidator(server).validate('fixture', { value: 'anything' }))
      .rejects.toMatchObject({ code: 'tool_arguments_invalid', message: 'Tool arguments are invalid' });
  });

  it('does not return a partial registry when overlay registration fails', async () => {
    const failure = new Error('overlay registration failed');
    await expect(createRegisteredToolServer({ registerOverlays: server => {
      server.registerTool('partial_overlay', { inputSchema: {} }, async () => ({ content: [] }));
      throw failure;
    } })).rejects.toBe(failure);
  });

  it('finalizes overlays before strict validation and shares that contract with real execution', async () => {
    const handler = vi.fn(async () => ({ content: [] }));
    const server = await createRegisteredToolServer({ registerOverlays: async server => {
      server.registerTool('empty_overlay', { inputSchema: {} }, handler);
      server.registerTool('overlay_fixture', { inputSchema: { outbox_id: z.string().uuid(), limit: z.number().default(3) } }, handler);
    } });
    const validator = createRegisteredToolValidator(server);
    await expect(validator.validate('empty_overlay', { hallucinated: true })).rejects.toMatchObject({ code: 'tool_arguments_invalid' });
    const args = { outbox_id: '0e3e19dd-f10d-4eec-90c3-413664c6107a', hallucinated: true };
    await expect(validator.validate('overlay_fixture', args)).rejects.toMatchObject({ code: 'tool_arguments_invalid' });
    await expect(validator.validate('overlay_fixture', {})).rejects.toMatchObject({ code: 'tool_arguments_invalid' });
    const client = new Client({ name: 'validation-contract', version: '1' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      const listed = await client.listTools();
      expect(listed.tools.find(tool => tool.name === 'empty_overlay')?.inputSchema.additionalProperties).toBe(false);
      const result = await client.callTool({ name: 'overlay_fixture', arguments: args });
      expect(result.isError).toBe(true);
      const emptyResult = await client.callTool({ name: 'empty_overlay', arguments: { hallucinated: true } });
      expect(emptyResult.isError).toBe(true);
      expect(handler).not.toHaveBeenCalled();
      expect(await validator.validate('overlay_fixture', { outbox_id: args.outbox_id }))
        .toEqual({ toolName: 'overlay_fixture', args: { outbox_id: args.outbox_id, limit: 3 } });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('constructs the real registry and singleton without HTTP, listeners or timers', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('HTTP forbidden'));
    vi.stubGlobal('fetch', fetch);
    const interval = vi.spyOn(globalThis, 'setInterval');
    const timeout = vi.spyOn(globalThis, 'setTimeout');
    const connect = vi.spyOn(pg.Client.prototype, 'connect').mockImplementation(() => { throw new Error('DB forbidden'); });
    const server = await createRegisteredToolServer();
    const validator = createRegisteredToolValidator(server);
    expect(await validator.validate('invoke_function', { app_id: 'synthetic-app', function_name: 'synthetic-function' }))
      .toEqual({ toolName: 'invoke_function', args: { app_id: 'synthetic-app', function_name: 'synthetic-function', method: 'POST' } });
    await expect(validator.validate('invoke_function', { app_id: 'synthetic-app', function_name: 'f', unknown: 1 }))
      .rejects.toMatchObject({ code: 'tool_arguments_invalid' });
    await expect(validator.validate('manage_app', { action: 'not_real' }))
      .rejects.toMatchObject({ code: 'tool_arguments_invalid' });
    const [first, second] = await Promise.all([getRegisteredToolValidator(), getRegisteredToolValidator()]);
    expect(first).toBe(second);
    expect(fetch).not.toHaveBeenCalled();
    expect(interval).not.toHaveBeenCalled();
    expect(timeout).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });
});
