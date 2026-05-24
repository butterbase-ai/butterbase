import { apiFetch } from './api-client.js';

const base = (appId: string) => `/v1/${appId}/kv`;

export const kvApi = {
  get: (appId: string, key: string, raw = false) =>
    apiFetch('GET', `${base(appId)}/${encodeURI(key)}${raw ? '?raw=1' : ''}`),
  set: (appId: string, key: string, value: unknown, opts: { ttl?: number | null; ephemeral?: boolean } = {}) =>
    apiFetch('PUT', `${base(appId)}/${encodeURI(key)}`, { value, ...opts }),
  del: (appId: string, key: string) => apiFetch('DELETE', `${base(appId)}/${encodeURI(key)}`),
  scan: (appId: string, prefix: string, limit: number, cursor = '0') =>
    apiFetch('GET', `${base(appId)}/_scan?prefix=${encodeURIComponent(prefix)}&limit=${limit}&cursor=${cursor}`),
  stats: (appId: string) => apiFetch('GET', `${base(appId)}/_stats`),
  flush: (appId: string, includeConfig = false) =>
    apiFetch('POST', `${base(appId)}/_flush`, { confirm: true, include_config: includeConfig }),
  listRules: (appId: string) => apiFetch('GET', `${base(appId)}/_expose`),
  expose: (appId: string, pattern: string, read: string, write: string) =>
    apiFetch('PUT', `${base(appId)}/_expose/${encodeURIComponent(pattern)}`, { read, write }),
  unexpose: (appId: string, pattern: string) =>
    apiFetch('DELETE', `${base(appId)}/_expose/${encodeURIComponent(pattern)}`),
};
