// cloudflare-wfp.ts
// Wraps the subset of Cloudflare APIs needed to deploy customer frontends onto
// Workers for Platforms (WfP) and to map `{subdomain}.butterbase.dev` -> `app_id`
// via Workers KV.
import crypto from 'node:crypto';
import { config } from '../config.js';
import { cfFetch, CF_BASE } from './cloudflare-client.js';

const NS = config.cloudflare.dispatchNamespace;
const KV_ID = config.cloudflare.subdomainKvId;

/**
 * Sentinel script name for the shared placeholder worker deployed into the
 * dispatch namespace. Double-underscore rules out collision with real app IDs,
 * which are `app_` prefixed.
 */
export const PLACEHOLDER_SCRIPT_NAME = '__placeholder__';

export interface DeployInput {
  scriptName: string; // use app.id for stability
  files: Map<string, Buffer>; // absolute paths (e.g. '/index.html') -> bytes
  envVars: Record<string, string>; // will become plain_text bindings
}

function hash32(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32);
}

// SPA fallback handled explicitly in-worker: on a non-2xx from the assets
// binding, rewrite the path to /index.html and retry. This is the CF-canonical
// SPA pattern and is deterministic across CF runtime variants (we previously
// tried `not_found_handling: 'single-page-application'` and it threw inside WfP).
//
// NOTE: We check `res.ok` (status 200-299) rather than `res.status !== 404`
// because the Assets binding inside a WfP dispatch namespace may return 307
// redirects for non-file paths (e.g. /people → 307 Location: /) instead of
// 404. Catching all non-2xx responses ensures SPA deep-links always resolve to
// index.html instead of producing unexpected redirects.
//
// MIME workaround: the Assets binding inside a WfP dispatch namespace does not
// reliably set Content-Type headers. Without a correct Content-Type, browsers
// block module scripts entirely ("strict MIME type checking"). We detect the
// type from the URL extension and override the header when it is missing.
const STATIC_FALLBACK_WORKER_JS = `
const MIME = {
  js: 'application/javascript',
  mjs: 'application/javascript',
  css: 'text/css',
  html: 'text/html',
  htm: 'text/html',
  json: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',
  wasm: 'application/wasm',
  xml: 'application/xml',
  txt: 'text/plain',
  map: 'application/json',
};

function withMime(req, res) {
  if (res.headers.get('content-type')) return res;
  // Extract extension from the last path segment only. Splitting the whole URL
  // on '.' picks up the hostname (e.g. '.butterbase.ai/geo' → 'ai/geo') for
  // extensionless paths. Extensionless paths are served by the Assets binding
  // from a .html file via html_handling, so default them to text/html —
  // octet-stream triggers a browser download instead of rendering.
  const path = new URL(req.url).pathname;
  const filename = path.split('/').pop() || '';
  const dot = filename.lastIndexOf('.');
  const ext = dot > -1 ? filename.slice(dot + 1).toLowerCase() : '';
  const ct = MIME[ext] || (ext ? 'application/octet-stream' : 'text/html');
  const h = new Headers(res.headers);
  h.set('content-type', ct);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

export default {
  async fetch(request, env) {
    try {
      const res = await env.ASSETS.fetch(request);
      if (res.ok) return withMime(request, res);
      const url = new URL(request.url);
      url.pathname = '/index.html';
      const fallback = await env.ASSETS.fetch(new Request(url.toString(), request));
      return withMime(new Request(url.toString()), fallback);
    } catch (err) {
      return new Response('worker error: ' + (err && err.message ? err.message : String(err)), { status: 500 });
    }
  }
};`;

export async function deployUserWorkerWithScript(
  input: DeployInput,
  workerScript: string,
  additionalModules?: Map<string, Buffer>,
  compatibilityFlags?: string[],
): Promise<void> {
  const { scriptName, files, envVars } = input;

  // Build manifest + hash->content lookup
  const manifest: Record<string, { hash: string; size: number }> = {};
  const hashToContent: Record<string, Buffer> = {};
  for (const [p, content] of files) {
    const h = hash32(content);
    manifest[p] = { hash: h, size: content.length };
    hashToContent[h] = content;
  }

  // 1. Session
  const session = await cfFetch<{ jwt: string; buckets?: string[][] }>(
    `/workers/dispatch/namespaces/${NS}/scripts/${scriptName}/assets-upload-session`,
    { method: 'POST', body: JSON.stringify({ manifest }) },
  );
  let completionToken = session.jwt;

  // 2. Upload each bucket (direct fetch — uses session JWT, not account token)
  for (const bucket of session.buckets ?? []) {
    const form = new FormData();
    for (const h of bucket) {
      const content = hashToContent[h];
      if (!content) throw new Error(`CF asked to upload unknown hash: ${h}`);
      form.append(h, content.toString('base64'));
    }
    const res = await fetch(`${CF_BASE}/workers/assets/upload?base64=true`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.jwt}` },
      body: form,
    });
    const body = (await res.json()) as {
      success: boolean;
      result: { jwt?: string };
      errors: unknown;
    };
    if (!body.success) {
      throw new Error(`Asset upload failed: ${JSON.stringify(body.errors)}`);
    }
    if (body.result?.jwt) completionToken = body.result.jwt;
  }

  // 3. Deploy script
  const metadata = {
    main_module: 'worker.mjs',
    assets: {
      jwt: completionToken,
      config: {
        html_handling: 'auto-trailing-slash',
      },
    },
    bindings: [
      // Expose the uploaded assets as env.ASSETS so the worker fallback can call it.
      { type: 'assets', name: 'ASSETS' },
      ...Object.entries(envVars).map(([name, text]) => ({
        type: 'plain_text',
        name,
        text,
      })),
    ],
    compatibility_date: '2025-01-24',
    ...(compatibilityFlags && compatibilityFlags.length > 0
      ? { compatibility_flags: compatibilityFlags }
      : {}),
  };

  const form = new FormData();
  form.append(
    'metadata',
    new Blob([JSON.stringify(metadata)], { type: 'application/json' }),
  );
  // CRITICAL: pass filename as third arg — Cloudflare matches `main_module` to the
  // filename, not the field name.
  form.append(
    'worker.mjs',
    new Blob([workerScript], { type: 'application/javascript+module' }),
    'worker.mjs',
  );
  // Append any additional modules (e.g. chunks from _worker.js/ directory).
  // Each entry becomes its own form-part with the filename as the third arg so
  // Cloudflare can resolve import statements between modules.
  if (additionalModules) {
    for (const [filename, content] of additionalModules) {
      form.append(
        filename,
        new Blob([new Uint8Array(content)], { type: 'application/javascript+module' }),
        filename,
      );
    }
  }

  await cfFetch(`/workers/dispatch/namespaces/${NS}/scripts/${scriptName}`, {
    method: 'PUT',
    body: form,
  });
}

export async function deployUserWorker(input: DeployInput): Promise<void> {
  return deployUserWorkerWithScript(input, STATIC_FALLBACK_WORKER_JS);
}

export async function deleteUserWorker(scriptName: string): Promise<void> {
  await cfFetch(`/workers/dispatch/namespaces/${NS}/scripts/${scriptName}`, {
    method: 'DELETE',
  });
}

export async function writeSubdomainMapping(
  subdomain: string,
  appId: string,
  region: string,
): Promise<void> {
  if (process.env.KV_LOCAL_FILE) {
    // Dynamic import path string prevents tsc from resolving the out-of-rootDir
    // test helper at compile time (it is only loaded in E2E / local runs).
    const mockKvPath = '../../../../tests/e2e/helpers/mock-kv.js';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { mockKv } = await (import(mockKvPath) as Promise<any>);
    await mockKv.put(`sub:${subdomain}`, JSON.stringify({ appId, region }));
    return;
  }
  await cfFetch(`/storage/kv/namespaces/${KV_ID}/values/sub:${subdomain}`, {
    method: 'PUT',
    body: JSON.stringify({ appId, region }),
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function deleteSubdomainMapping(subdomain: string): Promise<void> {
  await cfFetch(`/storage/kv/namespaces/${KV_ID}/values/sub:${subdomain}`, {
    method: 'DELETE',
  });
}

export async function writeDomainMapping(
  hostname: string,
  appId: string,
  region: string,
): Promise<void> {
  if (process.env.KV_LOCAL_FILE) {
    const mockKvPath = '../../../../tests/e2e/helpers/mock-kv.js';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { mockKv } = await (import(mockKvPath) as Promise<any>);
    await mockKv.put(`domain:${hostname}`, JSON.stringify({ appId, region }));
    return;
  }
  await cfFetch(`/storage/kv/namespaces/${KV_ID}/values/domain:${hostname}`, {
    method: 'PUT',
    body: JSON.stringify({ appId, region }),
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function deleteDomainMapping(hostname: string): Promise<void> {
  await cfFetch(`/storage/kv/namespaces/${KV_ID}/values/domain:${hostname}`, {
    method: 'DELETE',
  });
}

export interface DoDeployInput {
  scriptName: string;
  bundle: string;          // The full Worker module source.
  classNames: string[];    // Actual TS class names exported from the bundle.
  bindingNames: string[];  // Same length as classNames; binding name per class.
  migrations: {
    new_classes: string[];
    deleted_classes: string[];
  };
  // Required when the script already exists on CF with a tag. CF rejects the
  // PUT (code 10079) if the old_tag doesn't match the script's current tag.
  // Pass null/undefined for first-ever deploy.
  oldTag?: string | null;
  // Plain-text bindings exposed as `env.KEY` inside both the dispatcher and
  // each DO class instance. Caller is responsible for ensuring keys do not
  // collide with `bindingNames` (the DO namespace bindings).
  envVars?: Record<string, string>;
}

/**
 * Deploys the DO Worker script for an app. Returns the new migration tag the
 * caller must persist so the next deploy can supply it as `old_tag`.
 */
export async function deployDoWorker(input: DoDeployInput): Promise<{ newTag: string }> {
  const { scriptName, bundle, classNames, bindingNames, migrations, oldTag, envVars } = input;

  if (classNames.length !== bindingNames.length) {
    throw new Error('deployDoWorker: classNames and bindingNames length mismatch');
  }

  const doBindings = classNames.map((cls, i) => ({
    type: 'durable_object_namespace' as const,
    name: bindingNames[i]!,
    class_name: cls,
  }));

  const envBindings = Object.entries(envVars ?? {}).map(([name, text]) => ({
    type: 'plain_text' as const,
    name,
    text,
  }));

  const newTag = `v-${Date.now()}`;
  const metadata = {
    main_module: 'worker.mjs',
    bindings: [...doBindings, ...envBindings],
    migrations: {
      ...(oldTag ? { old_tag: oldTag } : {}),
      new_tag: newTag,
      new_classes: migrations.new_classes,
      deleted_classes: migrations.deleted_classes,
    },
    compatibility_date: '2025-01-24',
  };

  const form = new FormData();
  form.append(
    'metadata',
    new Blob([JSON.stringify(metadata)], { type: 'application/json' }),
  );
  form.append(
    'worker.mjs',
    new Blob([bundle], { type: 'application/javascript+module' }),
    'worker.mjs',
  );

  await cfFetch(`/workers/dispatch/namespaces/${NS}/scripts/${scriptName}`, {
    method: 'PUT',
    body: form,
  });

  return { newTag };
}

/**
 * Read the current migration tag for a DO script from CF. Returns null when
 * the script does not exist. Used to backfill `app_do_deploy_state` for apps
 * deployed before we started persisting the tag locally.
 *
 * The per-script GET in WfP returns the script source (not the metadata),
 * and the /settings endpoint omits migration_tag. The list endpoint is the
 * one that returns each script's `migration_tag`, so we list the namespace
 * and find ours.
 */
export async function getDoWorkerMigrationTag(scriptName: string): Promise<string | null> {
  try {
    const scripts = await cfFetch<Array<{ id?: string; script_name?: string; migration_tag?: string | null }>>(
      `/workers/dispatch/namespaces/${NS}/scripts?per_page=1000`,
    );
    const match = scripts.find((s) => s.id === scriptName || s.script_name === scriptName);
    return match?.migration_tag ?? null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('(404)') || msg.includes('[10007]')) {
      return null;
    }
    throw err;
  }
}

export async function deleteDoWorker(scriptName: string): Promise<void> {
  await cfFetch(`/workers/dispatch/namespaces/${NS}/scripts/${scriptName}`, {
    method: 'DELETE',
  });
}
