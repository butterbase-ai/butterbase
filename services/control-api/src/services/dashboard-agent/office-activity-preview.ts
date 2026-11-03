import type { OfficeToolValuePreview } from '@butterbase/shared';
import { classifyOfficePreviewPath, resolveOfficePreviewPolicy, type OfficePreviewContext } from './office-activity-preview-policy.js';

const WITHHELD = '[withheld]';
const OMITTED = '[omitted: preview limit]';
const LIMIT = { bytes: 65536, nodes: 2048, depth: 6, entries: 50, array: 20, text: 4096, envelope: 12288 };
const byteLength = (text: string) => Buffer.byteLength(text, 'utf8');
const own = (value: object, key: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
};
const normalizeKey = (key: string) => key.replace(/[^a-z0-9]/gi, '').toLowerCase();
const credentialKey = (key: string) => /password|passwd|passphrase|secret|privatekey|apikey|accesskey|byok|credential|authorization|cookie|signature|connectionstring|connectionurl|databaseurl|ciphertext/.test(key)
  || /^(token|tokens|accesstoken|refreshtoken|idtoken|authtoken|sessiontoken|jwt|key|headers|submissioncode)$/.test(key);
const environmentKey = (key: string) => /^(env|envvars|environment|environmentvariables|vars|userenv|envoverrides|buildenv|previewenv|buildoverrides|previewoverrides|functionenv|appenvvalues)$/.test(key);
const opaqueKey = (key: string) => /^(sql|source|sourcecode|filecontent|filebody|body|html|logs|consolelogs|stdout|stderr|output|stack|trace|base64|binary|embedding|embeddings|providermetadata|oauth|oauthcredentials|encryptedkey|graphspec|prompt|messages|transportheaders|session|sessioninternals)$/.test(key);
const credentialValue = (text: string) => /\bbearer\s+\S+|\bbb_sk_[A-Za-z0-9_-]{16,}|\b(?:sk_live_|sk_test_|sk-proj-|ghp_|github_pat_|AKIA)[A-Za-z0-9_-]{12,}|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|-----BEGIN (?:[A-Z ]+)?PRIVATE KEY-----|\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss):\/\//i.test(text);
const capabilityUrl = (url: URL, key: string) => /(?:upload|download|signed|presigned|confirmation|portal|meeting|recording|transcript)/i.test(key)
  || [...url.searchParams.keys()].some(name => /signature|credential|token|secret|policy|key-pair-id|x-amz-|x-goog-/i.test(name));

/** Bounded, server-only projection. No raw value escapes on failures. */
export function previewOfficeToolValue(value: unknown, context: OfficePreviewContext): OfficeToolValuePreview {
  if (value === undefined) return { state: 'unavailable', format: 'json', redacted: false, truncated: false, reason: 'not_recorded' };
  let redacted = false;
  let truncated = false;
  let bytes = 0;
  let nodes = 0;
  const seen = new WeakSet<object>();
  const hide = () => { redacted = true; return WITHHELD; };
  const omit = () => { truncated = true; return OMITTED; };
  // Iterate only the allowed prefix of a string; do not serialize unbounded inputs.
  const boundedString = (text: string, cap: number): string => {
    let output = '';
    let consumed = 0;
    for (const point of text) {
      const size = byteLength(point);
      if (consumed + size > cap || bytes + size > LIMIT.bytes) { truncated = true; return output + OMITTED; }
      output += point; consumed += size; bytes += size;
    }
    return output;
  };

  let policy: ReturnType<typeof resolveOfficePreviewPolicy>;
  const project = (input: unknown, path: string[], trusted: boolean, depth: number, env = false, activeContext = context): unknown => {
    if (nodes >= LIMIT.nodes || depth > LIMIT.depth || bytes >= LIMIT.bytes) return omit();
    nodes++;
    const key = path[path.length - 1] ?? '';
    if (key.length > 200) return hide();
    const normalized = normalizeKey(key);
    const activePolicy = activeContext === context ? policy : resolveOfficePreviewPolicy(activeContext);
    const classification = path.at(-1) === '*' && trusted ? 'structured' : classifyOfficePreviewPath(activePolicy, activeContext.phase, path);
    const kvKey = activeContext.toolName === 'manage_kv' && normalized === 'key' && path.length === 1;
    const envName = activeContext.toolName === 'manage_app' && activeContext.action === 'preview_clone_env_vars'
      && normalized === 'key' && path.includes('key_meta');
    if (env) return hide();
    if (classification === 'secret' || (credentialKey(normalized) && !kvKey && !envName)) return hide();
    const structuredAuditRecords = activeContext.toolName === 'query_audit_logs' && activeContext.phase === 'result'
      && path.length === 1 && normalized === 'logs' && Array.isArray(input);
    if (classification === 'opaque' || (opaqueKey(normalized) && !structuredAuditRecords)) return hide();
    if (normalized === 'code' && typeof input === 'string' && !/^[a-z][a-z0-9_.:-]{0,100}$/i.test(input)) return hide();
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') return hide();
    const isEnvironment = environmentKey(normalized);
    if (isEnvironment && (input === null || typeof input !== 'object')) return hide();
    const approved = trusted && (path.length === 0 ? Boolean(activePolicy) : classification === 'structured' || classification === 'url');
    if (input === null || typeof input === 'boolean' || typeof input === 'number') {
      bytes += 8;
      return approved && (typeof input !== 'number' || Number.isFinite(input)) ? input : hide();
    }
    if (typeof input === 'string') {
      if (!approved) return hide();
      if (path.length === 0 && input !== '') return hide();
      if (/^(error|result|results|decision|verdict|data|config|metadata|warnings|details|items|rows|records)$/.test(normalized)) return hide();
      if (path.at(-1) === '*' && !classifyOfficePreviewPath(activePolicy, activeContext.phase, path)
        && !/^(keys|envKeys|env_keys|scopes|additional_scopes|tables|roles|read|write|allowed_origins|redirect_uris|conventions)$/.test(path.at(-2) ?? '')) return hide();
      // Scan at most the budget. A secret after the retained prefix cannot leak.
      const text = boundedString(input, LIMIT.text);
      if (text === WITHHELD || text === OMITTED) return text;
      if (credentialValue(text) || /^[\s]*[\[{]/.test(text)) return hide();
      const trimmed = text.trim();
      const urlField = classification === 'url' || /(?:url|uri|origin|endpoint|href)$/.test(normalized)
        || (key === '*' && /(?:urls|uris|origins|endpoints)$/.test(normalizeKey(path.at(-2) ?? '')));
      if (urlField || /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || /^\/\//.test(trimmed)) {
        try {
          const relative = !/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !trimmed.startsWith('//');
          const url = new URL(trimmed, 'https://preview.invalid');
          if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || capabilityUrl(url, key)) return hide();
          const safe = relative ? url.pathname : url.origin + url.pathname;
          if (safe !== text) redacted = true;
          return safe;
        } catch { return hide(); }
      }
      return text;
    }
    if (typeof input !== 'object' || input === undefined) return hide();
    if (seen.has(input)) return omit();
    seen.add(input);
    if (Array.isArray(input)) {
      const out: unknown[] = [];
      const length = own(input, 'length') as number;
      for (let index = 0; index < Math.min(length, LIMIT.array); index++) {
        if (nodes >= LIMIT.nodes || bytes >= LIMIT.bytes) { out.push(omit()); break; }
        const elementPath = path.length === 0 ? [] : [...path, '*'];
        // A structured array admits its elements, but never all their fields.
        out.push(project(own(input, String(index)), elementPath, approved, depth + 1, isEnvironment, activeContext));
      }
      if (length > LIMIT.array) out.push(omit());
      seen.delete(input);
      return out;
    }
    const out = Object.create(null) as Record<string, unknown>;
    let count = 0;
    for (const field in input) {
      if (!Object.hasOwn(input, field)) continue;
      if (count++ >= LIMIT.entries || bytes >= LIMIT.bytes || nodes >= LIMIT.nodes) { out['[omitted]'] = omit(); break; }
      // Keys can themselves contain arbitrary credentials; never persist those strings.
      const safeField = field.length > 200 || credentialValue(field) || /[\u0000-\u001f]/.test(field) ? `[withheld field ${count}]` : field;
      if (safeField !== field) redacted = true;
      const fieldBytes = byteLength(safeField);
      if (bytes + fieldBytes > LIMIT.bytes) { out['[omitted]'] = omit(); break; }
      bytes += fieldBytes;
      const descriptor = Object.getOwnPropertyDescriptor(input, field);
      if (!descriptor || !('value' in descriptor)) { out[safeField] = hide(); continue; }
      // A proposal carries another operation, not proof that it executed. Reuse
      // the target policy without exposing its otherwise opaque wrapper args.
      if (activeContext.toolName === 'propose_action' && field === 'arguments' && path.join('.') === 'operation') {
        const name = own(input, 'tool');
        const args = descriptor.value;
        const action = args && typeof args === 'object' ? own(args, 'action') : own(input, 'action');
        out[safeField] = project(args, [], true, depth + 1, false, { toolName: typeof name === 'string' ? name : '', action: typeof action === 'string' ? action : undefined, phase: activeContext.phase });
      } else {
        out[safeField] = project(descriptor.value, [...path, field], path.length === 0 ? Boolean(activePolicy) : approved, depth + 1, isEnvironment, activeContext);
      }
    }
    seen.delete(input);
    return out;
  };

  try {
    if (!context.capability && value && typeof value === 'object') {
      const capability = own(value, 'capability');
      if (typeof capability === 'string' && capability.length <= 128) context = { ...context, capability };
    }
    policy = resolveOfficePreviewPolicy(context);
    let observed: unknown = value;
    let envelopeError: boolean | undefined;
    // Recognize transport envelopes only at the result root. Getters are never read.
    if (context.phase === 'result' && observed && typeof observed === 'object' && !Array.isArray(observed)) {
      const isError = own(observed, 'isError');
      const keys: string[] = [];
      for (const key in observed) { if (Object.hasOwn(observed, key)) keys.push(key); if (keys.length > 4) break; }
      const wrapper = keys.length > 0 && keys.every(key => ['content', 'structuredContent', 'isError', '_meta'].includes(key));
      if (wrapper && Object.hasOwn(observed, 'structuredContent') && own(observed, 'structuredContent') !== undefined) observed = own(observed, 'structuredContent');
      else if (wrapper && Array.isArray(own(observed, 'content'))) {
        const content = own(observed, 'content') as unknown[];
        const block = own(content, '0');
        const text = block && typeof block === 'object' && own(block, 'type') === 'text' ? own(block, 'text') : undefined;
        if (content.length === 1 && typeof text === 'string' && text.length <= LIMIT.bytes && byteLength(text) <= LIMIT.bytes) {
          try { observed = JSON.parse(text); } catch { observed = { content: hide() }; }
        } else observed = { content: hide() };
      }
      if (wrapper && typeof isError === 'boolean') envelopeError = isError;
      // This is the sanitized receipt shape persisted by this projector. Keep
      // its transport metadata separate when applying the current field policy.
      if (!wrapper && keys.length === 2 && keys.includes('isError') && keys.includes('result') && typeof isError === 'boolean') {
        envelopeError = isError; observed = own(observed as object, 'result');
      }
    }
    const body = project(observed, [], true, 0);
    const projected = envelopeError === undefined ? body : { isError: envelopeError, result: body };
    let text = JSON.stringify(projected, null, 2);
    // Compacting cannot break JSON or Unicode. If still too large, replace complete
    // values in a bounded sanitized tree instead of slicing serialized JSON.
    if (byteLength(text) > LIMIT.text) text = JSON.stringify(projected);
    const trim = (node: unknown): boolean => {
      if (!node || typeof node !== 'object') return false;
      const keys = Object.keys(node);
      for (let index = keys.length - 1; index >= 0; index--) {
        const key = keys[index]!;
        const record = node as Record<string, unknown>;
        if (record[key] === OMITTED) continue;
        if (trim(record[key])) return true;
        record[key] = OMITTED; truncated = true;
        return true;
      }
      return false;
    };
    while (byteLength(text) > LIMIT.text) {
      if (!trim(projected)) { text = JSON.stringify(OMITTED); truncated = true; break; }
      text = JSON.stringify(projected);
    }
    let preview: OfficeToolValuePreview = { state: 'available', format: 'json', text, redacted, truncated };
    if (byteLength(JSON.stringify(preview)) > LIMIT.envelope) preview = { state: 'unavailable', format: 'json', reason: 'too_large', redacted, truncated: true };
    return preview;
  } catch {
    return { state: 'unavailable', format: 'json', reason: 'capture_failed', redacted: true, truncated };
  }
}
