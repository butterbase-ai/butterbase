import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiGet, apiPost, apiPut, apiDelete } from '../api-client.js';

export function registerManageKv(server: McpServer) {
  server.tool(
    'manage_kv',
    `Manage app KV store: config rules (expose/unexpose namespaces) and data-plane operations (get/set/del/incr etc).

Actions — Config:
  - "list_rules":  List all KV namespace exposure rules for the app
  - "expose":      Expose a key pattern (namespace) to the SDK/functions
  - "unexpose":    Remove an exposure rule by pattern
  - "stats":       Get KV usage stats (key count, memory, etc.)
  - "scan":        Scan keys matching a pattern (cursor-based)
  - "flush":       Delete ALL keys in the KV store (requires confirm: true)

Actions — Data plane:
  - "get":    Get the value of a key
  - "set":    Set a key to a value (optionally with TTL)
  - "del":    Delete one or more keys
  - "incr":   Increment a key's integer value by 1
  - "decr":   Decrement a key's integer value by 1
  - "setnx":  Set a key only if it does not already exist
  - "setex":  Set a key with an explicit TTL in seconds
  - "cas":    Compare-and-swap: set value only if current value matches expected
  - "exists": Check if a key exists
  - "ttl":    Get remaining TTL of a key in seconds
  - "expire": Set a TTL on an existing key
  - "mget":   Get values of multiple keys at once
  - "mset":   Set multiple key-value pairs at once

Parameters by action:
  list_rules:  { app_id, action: "list_rules" }
  expose:      { app_id, action: "expose", pattern }
  unexpose:    { app_id, action: "unexpose", pattern }
  stats:       { app_id, action: "stats" }
  scan:        { app_id, action: "scan", pattern?, cursor?, count? }
  flush:       { app_id, action: "flush", confirm: true }
  get:         { app_id, action: "get", key }
  set:         { app_id, action: "set", key, value, ttl? }
  del:         { app_id, action: "del", key }
  incr:        { app_id, action: "incr", key }
  decr:        { app_id, action: "decr", key }
  setnx:       { app_id, action: "setnx", key, value }
  setex:       { app_id, action: "setex", key, value, ttl }
  cas:         { app_id, action: "cas", key, value, expected }
  exists:      { app_id, action: "exists", key }
  ttl:         { app_id, action: "ttl", key }
  expire:      { app_id, action: "expire", key, ttl }
  mget:        { app_id, action: "mget", keys }
  mset:        { app_id, action: "mset", entries }

Warning: "flush" deletes ALL keys and cannot be undone. Always pass confirm: true explicitly.`,
    {
      app_id: z.string().describe('The app ID (e.g. app_abc123def456)'),
      action: z.enum([
        'list_rules', 'expose', 'unexpose', 'stats', 'scan', 'flush',
        'get', 'set', 'del', 'incr', 'decr', 'setnx', 'setex', 'cas',
        'exists', 'ttl', 'expire', 'mget', 'mset',
      ]).describe('The action to perform'),
      pattern: z.string().optional().describe('Key pattern for expose/unexpose/scan (e.g. "user:*")'),
      key: z.string().optional().describe('The KV key for single-key data-plane actions'),
      value: z.string().optional().describe('The value to set (for set, setnx, setex, cas)'),
      expected: z.string().optional().describe('The expected current value for CAS (compare-and-swap)'),
      ttl: z.number().int().positive().optional().describe('TTL in seconds (for set, setex, expire)'),
      cursor: z.string().optional().describe('Pagination cursor for scan (omit for first page)'),
      count: z.number().int().positive().optional().describe('Max keys to return per scan page'),
      confirm: z.boolean().optional().describe('Must be true to execute flush'),
      keys: z.array(z.string()).optional().describe('Array of keys for mget'),
      entries: z.record(z.string()).optional().describe('Object of key→value pairs for mset'),
    },
    {
      title: 'Manage KV',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    async (args) => {
      const { app_id, action } = args;
      const base = `/v1/internal/kv/proxy/${app_id}/kv`;
      const need = (cond: unknown, msg: string) =>
        cond
          ? null
          : { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true as const };

      switch (action) {
        case 'list_rules': {
          const result = await apiGet(`${base}/rules`);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'expose': {
          const err = need(args.pattern, '"pattern" is required for expose.');
          if (err) return err;
          const result = await apiPost(`${base}/rules`, { pattern: args.pattern });
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'unexpose': {
          const err = need(args.pattern, '"pattern" is required for unexpose.');
          if (err) return err;
          const result = await apiDelete(`${base}/rules/${encodeURIComponent(args.pattern!)}`);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'stats': {
          const result = await apiGet(`${base}/stats`);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'scan': {
          const params = new URLSearchParams();
          if (args.pattern) params.set('pattern', args.pattern);
          if (args.cursor) params.set('cursor', args.cursor);
          if (args.count) params.set('count', String(args.count));
          const qs = params.toString() ? `?${params.toString()}` : '';
          const result = await apiGet(`${base}/scan${qs}`);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'flush': {
          const err = need(args.confirm === true, '"confirm: true" is required for flush.');
          if (err) return err;
          const result = await apiPost(`${base}/flush`, {});
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'get': {
          const err = need(args.key, '"key" is required for get.');
          if (err) return err;
          const result = await apiGet(`${base}/data/${encodeURIComponent(args.key!)}`);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'set': {
          const err = need(args.key, '"key" is required for set.') ?? need(args.value !== undefined, '"value" is required for set.');
          if (err) return err;
          const body: Record<string, unknown> = { value: args.value };
          if (args.ttl !== undefined) body.ttl = args.ttl;
          const result = await apiPut(`${base}/data/${encodeURIComponent(args.key!)}`, body);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'del': {
          const err = need(args.key, '"key" is required for del.');
          if (err) return err;
          const result = await apiDelete(`${base}/data/${encodeURIComponent(args.key!)}`);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'incr': {
          const err = need(args.key, '"key" is required for incr.');
          if (err) return err;
          const result = await apiPost(`${base}/data/${encodeURIComponent(args.key!)}/incr`, {});
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'decr': {
          const err = need(args.key, '"key" is required for decr.');
          if (err) return err;
          const result = await apiPost(`${base}/data/${encodeURIComponent(args.key!)}/decr`, {});
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'setnx': {
          const err = need(args.key, '"key" is required for setnx.') ?? need(args.value !== undefined, '"value" is required for setnx.');
          if (err) return err;
          const result = await apiPost(`${base}/data/${encodeURIComponent(args.key!)}/setnx`, { value: args.value });
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'setex': {
          const err =
            need(args.key, '"key" is required for setex.') ??
            need(args.value !== undefined, '"value" is required for setex.') ??
            need(args.ttl, '"ttl" is required for setex.');
          if (err) return err;
          const result = await apiPut(`${base}/data/${encodeURIComponent(args.key!)}`, { value: args.value, ttl: args.ttl });
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'cas': {
          const err =
            need(args.key, '"key" is required for cas.') ??
            need(args.value !== undefined, '"value" is required for cas.') ??
            need(args.expected !== undefined, '"expected" is required for cas.');
          if (err) return err;
          const result = await apiPost(`${base}/data/${encodeURIComponent(args.key!)}/cas`, { value: args.value, expected: args.expected });
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'exists': {
          const err = need(args.key, '"key" is required for exists.');
          if (err) return err;
          const result = await apiGet(`${base}/data/${encodeURIComponent(args.key!)}/exists`);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'ttl': {
          const err = need(args.key, '"key" is required for ttl.');
          if (err) return err;
          const result = await apiGet(`${base}/data/${encodeURIComponent(args.key!)}/ttl`);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'expire': {
          const err = need(args.key, '"key" is required for expire.') ?? need(args.ttl, '"ttl" is required for expire.');
          if (err) return err;
          const result = await apiPost(`${base}/data/${encodeURIComponent(args.key!)}/expire`, { ttl: args.ttl });
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'mget': {
          const err = need(args.keys?.length, '"keys" array is required for mget.');
          if (err) return err;
          const result = await apiPost(`${base}/data/mget`, { keys: args.keys });
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'mset': {
          const err = need(args.entries && Object.keys(args.entries).length > 0, '"entries" object is required for mset.');
          if (err) return err;
          const result = await apiPost(`${base}/data/mset`, { entries: args.entries });
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
      }
    }
  );
}
