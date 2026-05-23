import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiGet, apiPost, apiPut, apiDelete } from '../api-client.js';

export function registerManageKv(server: McpServer) {
  server.tool(
    'manage_kv',
    `Manage app KV store: config rules (expose/unexpose namespaces) and data-plane operations (get/set/del/incr etc).

Actions — Config:
  - "list_rules":  List all KV namespace exposure rules for the app
  - "expose":      Expose a key pattern with read/write role access control
  - "unexpose":    Remove an exposure rule by pattern
  - "stats":       Get KV usage stats (key count, memory, etc.)
  - "scan":        Scan keys by prefix (cursor-based, params: prefix, limit, cursor)
  - "flush":       Delete ALL keys in the KV store (requires confirm: true; include_config?: true also wipes rules)

Actions — Data plane:
  - "get":    Get the value of a key (opts: raw?, touch?)
  - "set":    Set a key to a value (opts: ttl?, ephemeral?, raw?)
  - "del":    Delete one key
  - "incr":   Increment a key's integer value (opts: by?)
  - "decr":   Decrement a key's integer value (opts: by?)
  - "setnx":  Set a key only if it does not already exist (opts: value, ttl?)
  - "setex":  Set a key with an explicit TTL in seconds (same as set + ttl)
  - "cas":    Compare-and-swap: atomically set next only if current value matches expected
  - "exists": Check if a key exists
  - "ttl":    Get remaining TTL of a key in seconds
  - "expire": Set a TTL on an existing key
  - "mget":   Get values of multiple keys at once (uses batch op)
  - "mset":   Set multiple key-value pairs at once (uses batch op; entries: {key: value})

Parameters by action:
  list_rules:  { app_id, action: "list_rules" }
  expose:      { app_id, action: "expose", pattern, read, write }
  unexpose:    { app_id, action: "unexpose", pattern }
  stats:       { app_id, action: "stats" }
  scan:        { app_id, action: "scan", prefix?, limit?, cursor? }
  flush:       { app_id, action: "flush", confirm: true, include_config? }
  get:         { app_id, action: "get", key, raw?, touch? }
  set:         { app_id, action: "set", key, value, ttl?, ephemeral?, raw? }
  del:         { app_id, action: "del", key }
  incr:        { app_id, action: "incr", key, by? }
  decr:        { app_id, action: "decr", key, by? }
  setnx:       { app_id, action: "setnx", key, value, ttl? }
  setex:       { app_id, action: "setex", key, value, ttl }
  cas:         { app_id, action: "cas", key, expected, next }
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
      pattern: z.string().optional().describe('Key pattern for expose/unexpose (e.g. "user:*")'),
      prefix: z.string().optional().describe('Key prefix for scan (e.g. "user:")'),
      key: z.string().optional().describe('The KV key for single-key data-plane actions'),
      value: z.any().optional().describe('The value to set — can be any JSON (object, array, string, number)'),
      expected: z.any().optional().describe('The expected current value for CAS (compare-and-swap)'),
      next: z.any().optional().describe('The next value to set for CAS if expected matches'),
      ttl: z.number().nullable().optional().describe('TTL in seconds (null = no expiry; for set, setex, expire, setnx)'),
      cursor: z.string().optional().describe('Pagination cursor for scan (omit for first page)'),
      limit: z.number().int().positive().max(1000).optional().describe('Max keys to return per scan page (max 1000)'),
      confirm: z.boolean().optional().describe('Must be true to execute flush'),
      include_config: z.boolean().optional().describe('Also wipe exposure rules when flushing (use with flush)'),
      keys: z.array(z.string()).optional().describe('Array of keys for mget'),
      entries: z.record(z.string(), z.any()).optional().describe('Object of key→value pairs for mset (values can be any JSON)'),
      read: z.enum(['public', 'authed', 'owner', 'deny']).optional().describe('Read access role for expose'),
      write: z.enum(['public', 'authed', 'owner', 'deny']).optional().describe('Write access role for expose'),
      by: z.number().optional().describe('Amount to increment/decrement (default 1, for incr/decr)'),
      ephemeral: z.boolean().optional().describe('Store in ephemeral DB (shorter-lived, for set/setnx)'),
      raw: z.boolean().optional().describe('Store/retrieve raw string without JSON wrapping (for set/get)'),
      touch: z.boolean().optional().describe('Reset TTL to original on read (for get)'),
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
      const base = `/v1/${app_id}/kv`;
      const need = (cond: unknown, msg: string) =>
        cond
          ? null
          : { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true as const };

      switch (action) {
        case 'list_rules': {
          const result = await apiGet(`${base}/_expose`);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'expose': {
          const err =
            need(args.pattern, '"pattern" is required for expose.') ??
            need(args.read, '"read" role is required for expose.') ??
            need(args.write, '"write" role is required for expose.');
          if (err) return err;
          const result = await apiPut(`${base}/_expose/${encodeURIComponent(args.pattern!)}`, {
            read: args.read,
            write: args.write,
          });
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'unexpose': {
          const err = need(args.pattern, '"pattern" is required for unexpose.');
          if (err) return err;
          const result = await apiDelete(`${base}/_expose/${encodeURIComponent(args.pattern!)}`);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'stats': {
          const result = await apiGet(`${base}/_stats`);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'scan': {
          const params = new URLSearchParams();
          if (args.prefix) params.set('prefix', args.prefix);
          if (args.cursor) params.set('cursor', args.cursor);
          if (args.limit !== undefined) params.set('limit', String(args.limit));
          const qs = params.size ? `?${params.toString()}` : '';
          const result = await apiGet(`${base}/_scan${qs}`);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'flush': {
          const err = need(args.confirm === true, '"confirm: true" is required for flush.');
          if (err) return err;
          const body: Record<string, unknown> = { confirm: true };
          if (args.include_config !== undefined) body.include_config = args.include_config;
          const result = await apiPost(`${base}/_flush`, body);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'get': {
          const err = need(args.key, '"key" is required for get.');
          if (err) return err;
          const params = new URLSearchParams();
          if (args.raw) params.set('raw', '1');
          if (args.touch) params.set('touch', '1');
          const qs = params.size ? `?${params.toString()}` : '';
          const result = await apiGet(`${base}/${encodeURIComponent(args.key!)}${qs}`);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'set': {
          const err = need(args.key, '"key" is required for set.') ?? need(args.value !== undefined, '"value" is required for set.');
          if (err) return err;
          const body: Record<string, unknown> = { value: args.value };
          if (args.ttl !== undefined) body.ttl = args.ttl;
          if (args.ephemeral !== undefined) body.ephemeral = args.ephemeral;
          if (args.raw !== undefined) body.raw = args.raw;
          const result = await apiPut(`${base}/${encodeURIComponent(args.key!)}`, body);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'del': {
          const err = need(args.key, '"key" is required for del.');
          if (err) return err;
          const result = await apiDelete(`${base}/${encodeURIComponent(args.key!)}`);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'incr': {
          const err = need(args.key, '"key" is required for incr.');
          if (err) return err;
          const body: Record<string, unknown> = {};
          if (args.by !== undefined) body.by = args.by;
          const result = await apiPost(`${base}/${encodeURIComponent(args.key!)}/incr`, body);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'decr': {
          const err = need(args.key, '"key" is required for decr.');
          if (err) return err;
          const body: Record<string, unknown> = {};
          if (args.by !== undefined) body.by = args.by;
          const result = await apiPost(`${base}/${encodeURIComponent(args.key!)}/decr`, body);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'setnx': {
          const err = need(args.key, '"key" is required for setnx.') ?? need(args.value !== undefined, '"value" is required for setnx.');
          if (err) return err;
          const body: Record<string, unknown> = { value: args.value };
          if (args.ttl !== undefined) body.ttl = args.ttl;
          const result = await apiPost(`${base}/${encodeURIComponent(args.key!)}/setnx`, body);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'setex': {
          const err =
            need(args.key, '"key" is required for setex.') ??
            need(args.value !== undefined, '"value" is required for setex.') ??
            need(args.ttl, '"ttl" is required for setex.');
          if (err) return err;
          const result = await apiPut(`${base}/${encodeURIComponent(args.key!)}`, { value: args.value, ttl: args.ttl });
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'cas': {
          const err =
            need(args.key, '"key" is required for cas.') ??
            need(args.expected !== undefined, '"expected" is required for cas.') ??
            need(args.next !== undefined, '"next" is required for cas.');
          if (err) return err;
          const result = await apiPost(`${base}/${encodeURIComponent(args.key!)}/cas`, {
            expected: args.expected,
            next: args.next,
          });
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'exists': {
          const err = need(args.key, '"key" is required for exists.');
          if (err) return err;
          const result = await apiGet(`${base}/${encodeURIComponent(args.key!)}/exists`);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'ttl': {
          const err = need(args.key, '"key" is required for ttl.');
          if (err) return err;
          const result = await apiGet(`${base}/${encodeURIComponent(args.key!)}/ttl`);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'expire': {
          const err = need(args.key, '"key" is required for expire.') ?? need(args.ttl !== undefined, '"ttl" is required for expire.');
          if (err) return err;
          const result = await apiPost(`${base}/${encodeURIComponent(args.key!)}/expire`, { ttl: args.ttl });
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'mget': {
          const err = need(args.keys?.length, '"keys" array is required for mget.');
          if (err) return err;
          const ops = args.keys!.map((k) => ({ op: 'get', key: k }));
          const result = await apiPost(`${base}/_batch`, { ops });
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'mset': {
          const err = need(args.entries && Object.keys(args.entries).length > 0, '"entries" object is required for mset.');
          if (err) return err;
          const ops = Object.entries(args.entries!).map(([k, v]) => ({ op: 'set', key: k, value: v }));
          const result = await apiPost(`${base}/_batch`, { ops });
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
      }
    }
  );
}
