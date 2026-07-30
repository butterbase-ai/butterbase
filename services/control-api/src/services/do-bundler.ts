// services/control-api/src/services/do-bundler.ts
//
// Bundles user-supplied DO class source files into a single Worker module
// suitable for upload to Cloudflare's Workers for Platforms (WfP) dispatch
// namespace. No esbuild — concatenation + a fixed dispatch suffix template.
import * as ts from 'typescript';

export class BundlerError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'BundlerError';
  }
}

export type AccessMode = 'public' | 'authenticated' | 'service_key';

export interface ClassDef {
  /** URL-facing name (kebab-case), e.g. 'chat-room'. */
  name: string;
  /** User source. Must export exactly one class. The class name will be parsed. */
  code: string;
  access_mode: AccessMode;
}

const MAX_CLASSES_PER_APP = 5;
const MAX_BUNDLE_BYTES = 10 * 1024 * 1024; // 10 MB

const ALLOWED_IMPORT_PREFIXES = ['cloudflare:'];

const VALID_NAME_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

const VALID_ACCESS_MODES: ReadonlySet<string> = new Set(['public', 'authenticated', 'service_key']);

/**
 * Parses the user's source. Returns the single exported class name.
 * Throws BundlerError on zero / multi-class exports or disallowed imports.
 */
export function extractClassName(source: string): string {
  const sf = ts.createSourceFile('do.ts', source, ts.ScriptTarget.ES2022, true);

  // Reject imports that aren't from the cloudflare:* namespace.
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const m = stmt.moduleSpecifier.text;
      const allowed = ALLOWED_IMPORT_PREFIXES.some((p) => m.startsWith(p));
      if (!allowed) {
        throw new BundlerError(
          `Import '${m}' is not allowed. v1 DO source files may only import from cloudflare:* (e.g. 'cloudflare:workers'). npm packages are not supported.`,
          'DISALLOWED_IMPORT',
        );
      }
    }
  }

  // Detect `export default class` before the named-export check.
  for (const stmt of sf.statements) {
    // ExportAssignment covers `export default <expr>` — TypeScript represents
    // `export default class X {}` as a ClassDeclaration with both ExportKeyword
    // and DefaultKeyword modifiers, NOT as ExportAssignment.  We check both
    // shapes to be thorough.
    if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
      // `export default <classExpr>` or similar
      const expr = stmt.expression;
      if (ts.isClassExpression(expr) || ts.isClassDeclaration(expr as ts.Node)) {
        throw new BundlerError(
          "Source uses 'export default class' which is not supported. Use named export instead: 'export class YourClassName {}'.",
          'EXPORT_DEFAULT_NOT_SUPPORTED',
        );
      }
    }
    if (ts.isClassDeclaration(stmt)) {
      const hasExport = stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      const hasDefault = stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
      if (hasExport && hasDefault) {
        throw new BundlerError(
          "Source uses 'export default class' which is not supported. Use named export instead: 'export class YourClassName {}'.",
          'EXPORT_DEFAULT_NOT_SUPPORTED',
        );
      }
    }
  }

  // Find exported class declarations.
  const exported: string[] = [];
  for (const stmt of sf.statements) {
    if (ts.isClassDeclaration(stmt) && stmt.name) {
      const isExported = stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (isExported) exported.push(stmt.name.text);
    }
  }

  if (exported.length === 0) {
    throw new BundlerError(
      "Source must export exactly one class via 'export class YourClassName {}'. None found.",
      'NO_EXPORTED_CLASS',
    );
  }
  if (exported.length > 1) {
    throw new BundlerError(
      `Source must export exactly one class. Found ${exported.length}: ${exported.join(', ')}`,
      'MULTIPLE_EXPORTED_CLASSES',
    );
  }
  return exported[0]!;
}

/** Convert kebab-case URL name to UPPER_SNAKE binding name. */
function toBindingName(urlName: string): string {
  return urlName.toUpperCase().replace(/-/g, '_');
}

interface ImportSet {
  named: Set<string>;
  default?: string;
  namespace?: string;
  sideEffect?: boolean;
}

function collectImports(source: string): Map<string, ImportSet> {
  const sf = ts.createSourceFile('do.ts', source, ts.ScriptTarget.ES2022, true);
  const imports = new Map<string, ImportSet>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const spec = stmt.moduleSpecifier.text;
    const set: ImportSet = imports.get(spec) ?? { named: new Set<string>() };
    const ic = stmt.importClause;
    if (!ic) {
      set.sideEffect = true;
    } else {
      if (ic.name) set.default = ic.name.text;
      if (ic.namedBindings) {
        if (ts.isNamespaceImport(ic.namedBindings)) {
          set.namespace = ic.namedBindings.name.text;
        } else if (ts.isNamedImports(ic.namedBindings)) {
          for (const e of ic.namedBindings.elements) {
            set.named.add(e.name.text);
          }
        }
      }
    }
    imports.set(spec, set);
  }
  return imports;
}

function mergeImports(into: Map<string, ImportSet>, from: Map<string, ImportSet>): void {
  for (const [spec, src] of from) {
    const dst: ImportSet = into.get(spec) ?? { named: new Set<string>() };
    if (src.default) dst.default = src.default;
    if (src.namespace) dst.namespace = src.namespace;
    if (src.sideEffect) dst.sideEffect = true;
    for (const n of src.named) dst.named.add(n);
    into.set(spec, dst);
  }
}

function emitImports(merged: Map<string, ImportSet>): string {
  const lines: string[] = [];
  for (const [spec, set] of merged) {
    const parts: string[] = [];
    if (set.default) parts.push(set.default);
    if (set.namespace) parts.push(`* as ${set.namespace}`);
    if (set.named.size > 0) parts.push(`{ ${[...set.named].join(', ')} }`);
    if (parts.length === 0) {
      if (set.sideEffect) lines.push(`import '${spec}';`);
    } else {
      lines.push(`import ${parts.join(', ')} from '${spec}';`);
    }
  }
  return lines.length ? lines.join('\n') + '\n' : '';
}

/**
 * Transpile a TS source to JS and strip top-level import declarations.
 * Imports are hoisted separately by buildBundle (deduped across classes) so
 * concatenating multiple sources doesn't produce duplicate-binding errors.
 */
function transpileAndStripImports(source: string): string {
  const js = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      isolatedModules: true,
      removeComments: false,
    },
    reportDiagnostics: false,
  }).outputText;

  const sf = ts.createSourceFile('out.js', js, ts.ScriptTarget.ES2022, true);
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  const out: string[] = [];
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt)) continue;
    out.push(printer.printNode(ts.EmitHint.Unspecified, stmt, sf));
  }
  return out.join('\n');
}

export interface BuildBundleResult {
  bundle: string;
  bindingNames: string[];
}

export function buildBundle(classes: ClassDef[]): BuildBundleResult {
  if (classes.length > MAX_CLASSES_PER_APP) {
    throw new BundlerError(
      `Too many DO classes for one app (max ${MAX_CLASSES_PER_APP}, got ${classes.length}).`,
      'TOO_MANY_CLASSES',
    );
  }

  // Validate each class's name and access_mode before doing any work.
  for (const c of classes) {
    if (!VALID_NAME_RE.test(c.name)) {
      throw new BundlerError(
        `Invalid DO name '${c.name}'. Names must be lowercase kebab-case (e.g. 'chat-room').`,
        'INVALID_NAME',
      );
    }
    if (!VALID_ACCESS_MODES.has(c.access_mode)) {
      throw new BundlerError(
        `Invalid access_mode '${c.access_mode}'. Must be one of: public, authenticated, service_key.`,
        'INVALID_ACCESS_MODE',
      );
    }
  }

  // Parse class names from source (eliminates className divergence footgun).
  classes.forEach((c) => extractClassName(c.code));

  const bindingNames = classes.map((c) => toBindingName(c.name));

  const routesEntries = classes
    .map(
      (c, i) =>
        `  '${c.name}': { binding: '${bindingNames[i]}', access_mode: '${c.access_mode}' }`,
    )
    .join(',\n');

  // Hoist deduped imports across all class sources so concatenation does not
  // produce duplicate-binding SyntaxErrors at the worker entry.
  const mergedImports = new Map<string, ImportSet>();
  for (const c of classes) {
    mergeImports(mergedImports, collectImports(c.code));
  }
  const importBlock = emitImports(mergedImports);

  const header = `// Generated by Butterbase DO bundler at ${new Date().toISOString()}\n`;

  const BUTTERBASE_HELPER = `
// --- Butterbase runtime helper (prepended by bundler; do not edit) ---
const butterbase = {
  ctx(req, envIn, state) {
    const env = { ...envIn };
    delete env.DO_INVOKER_URL;
    delete env.DO_INVOKER_TOKEN;
    // Platform-injected key used by ctx.invoke below; user code should use
    // ctx.invoke instead of reading it directly, so hide it from ctx.env.
    delete env.BUTTERBASE_INTERNAL_FN_KEY;

    const caller = req.headers.get('x-butterbase-internal-caller');
    const loopDepthIn = Number(req.headers.get('x-butterbase-loop-depth') || '0') || 0;
    const userId = req.headers.get('x-butterbase-caller-user') || null;

    const appId = envIn.BUTTERBASE_APP_ID;
    const apiUrl = envIn.BUTTERBASE_API_URL;
    const invokerUrl = envIn.DO_INVOKER_URL;
    const invokerToken = envIn.DO_INVOKER_TOKEN;
    const fnKey = envIn.BUTTERBASE_INTERNAL_FN_KEY;

    return {
      env,
      user: userId ? { id: userId } : null,
      request: { caller, loopDepth: loopDepthIn },
      state,
      async invokeDO(className, instanceKey, body, opts) {
        const nextDepth = loopDepthIn + 1;
        if (nextDepth > 4) throw new Error('ctx.invokeDO loop limit exceeded (depth ' + nextDepth + ' > 4)');
        if (!invokerUrl || !invokerToken) throw new Error('ctx.invokeDO not configured (missing DO_INVOKER_URL/DO_INVOKER_TOKEN in DO env)');
        const userHeaders = (opts && typeof opts.headers === 'object' && opts.headers) || {};
        const platform = {
          'authorization': 'Bearer ' + invokerToken,
          'x-butterbase-app': appId,
          'x-butterbase-class': className,
          'x-butterbase-instance': instanceKey,
          'x-butterbase-internal-caller': caller || 'do:unknown',
          'x-butterbase-caller-user': userId || '',
          'x-butterbase-loop-depth': String(nextDepth),
          'content-type': 'application/json',
        };
        const merged = { ...userHeaders, ...platform };
        const method = (opts && typeof opts.method === 'string') ? opts.method : 'POST';
        const bodyInit = body === undefined || method === 'GET' || method === 'HEAD'
          ? undefined
          : (typeof body === 'string' ? body : JSON.stringify(body));
        return fetch(invokerUrl + '/invoke', { method, headers: merged, body: bodyInit });
      },
      async invoke(fnName, body, opts) {
        const nextDepth = loopDepthIn + 1;
        if (nextDepth > 4) throw new Error('ctx.invoke loop limit exceeded (depth ' + nextDepth + ' > 4)');
        if (!fnKey) throw new Error('ctx.invoke unavailable: no internal function key in DO env');
        const userHeaders = (opts && typeof opts.headers === 'object' && opts.headers) || {};
        const platform = {
          'authorization': 'Bearer ' + fnKey,
          'x-butterbase-internal-caller': caller || 'do:unknown',
          'x-butterbase-caller-user': userId || '',
          'x-butterbase-loop-depth': String(nextDepth),
          'content-type': 'application/json',
        };
        const merged = { ...userHeaders, ...platform };
        const method = (opts && typeof opts.method === 'string') ? opts.method : 'POST';
        const url = apiUrl + '/v1/' + appId + '/fn/' + encodeURIComponent(fnName);
        const bodyInit = body === undefined || method === 'GET' || method === 'HEAD'
          ? undefined
          : (typeof body === 'string' ? body : JSON.stringify(body));
        return fetch(url, { method, headers: merged, body: bodyInit });
      },
    };
  },
};
`;

  // Transpile each user source from TS → JS and strip imports (hoisted above).
  // CF runs JS, not TS — `private`, type annotations, parameter properties,
  // etc. would otherwise produce SyntaxErrors at deploy time.
  const userSources = classes
    .map((c) => `// === ${c.name} ===\n${transpileAndStripImports(c.code)}\n`)
    .join('\n');

  const dispatch = `
const ROUTES = {
${routesEntries}
};

async function checkAuth(req, mode, env) {
  if (mode === 'public') return null;
  const auth = req.headers.get('authorization') || '';
  if (mode === 'service_key') {
    if (!auth.startsWith('Bearer bb_sk_')) {
      return new Response('unauthorized', { status: 401 });
    }
    return null; // Validation against the app's keys is done by an upstream layer.
  }
  // 'authenticated': accept any valid bearer token. Fine-grained validation upstream.
  if (!auth.startsWith('Bearer ')) {
    return new Response('unauthorized', { status: 401 });
  }
  return null;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    // Internal dispatch path — only reachable via WfP dispatch-namespace
    // call from do-invoker (fn→DO) or another _do Worker (DO→DO). CF's
    // public edge does not route the 'internal.butterbase' hostname, so a
    // browser cannot arrive here. No access_mode check — the caller
    // proved intra-app origin by having the dispatch binding.
    if (url.hostname === 'internal.butterbase' && url.pathname.startsWith('/_dispatch/')) {
      const parts = url.pathname.split('/');
      const className = decodeURIComponent(parts[2] || '');
      const instanceKey = decodeURIComponent(parts[3] || '');
      const route = ROUTES[className];
      if (!route) return new Response('unknown class: ' + className, { status: 404 });
      const ns = env[route.binding];
      if (!ns) return new Response('binding missing: ' + route.binding, { status: 500 });
      const id = ns.idFromName(instanceKey);
      return ns.get(id).fetch(req);
    }

    const m = url.pathname.match(/^\\/_do\\/([^/]+)\\/([^/]+)/);
    if (!m) return new Response('not found', { status: 404 });
    const [, name, instance] = m;
    const route = ROUTES[name];
    if (!route) return new Response('unknown DO', { status: 404 });

    const denied = await checkAuth(req, route.access_mode, env);
    if (denied) return denied;

    const ns = env[route.binding];
    if (!ns) return new Response('binding missing', { status: 500 });
    const id = ns.idFromName(instance);
    return ns.get(id).fetch(req);
  },
};
`;

  const bundle = header + importBlock + BUTTERBASE_HELPER + userSources + dispatch;
  if (Buffer.byteLength(bundle, 'utf-8') > MAX_BUNDLE_BYTES) {
    throw new BundlerError(
      `Bundle exceeds ${MAX_BUNDLE_BYTES} bytes after concatenation.`,
      'BUNDLE_TOO_LARGE',
    );
  }
  return { bundle, bindingNames };
}
