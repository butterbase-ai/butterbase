#!/usr/bin/env node
// Boots the static frontend worker locally via Miniflare (the same workerd
// runtime CF runs in prod). Serves a configurable assets directory with the
// same html_handling and binding setup the deployed worker uses, so devs can
// reproduce SPA routing issues without redeploying.
//
// Usage (from package root):
//   npm run dev:serve
//
// Env:
//   LOCAL_FRONTEND_ASSETS_DIR  Path to the dist/ to serve.
//                              Default: ./local-assets (a sample SPA shipped
//                              with this package).
//   LOCAL_FRONTEND_PORT        Port to bind. Default: 8787.
//   LOCAL_FRONTEND_HOST        Host to bind. Default: 0.0.0.0 (so docker port
//                              forwarding works; use 127.0.0.1 for native
//                              loopback-only).
//   LOCAL_FRONTEND_HTML_HANDLING  none (default, matches prod), auto-trailing-slash,
//                                 drop-trailing-slash, or force-trailing-slash.
import { Miniflare } from 'miniflare';
import { readFileSync, existsSync, mkdtempSync, readdirSync, symlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parseRedirects } from '../dist/redirects-parser.js';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');

const workerJsPath = join(packageRoot, 'dist', 'worker.js');
if (!existsSync(workerJsPath)) {
  console.error(
    `[local-server] dist/worker.js not found at ${workerJsPath}. Run \`npm run build\` first.`,
  );
  process.exit(1);
}
const workerSource = readFileSync(workerJsPath, 'utf8');

const assetsDir = resolve(
  process.env.LOCAL_FRONTEND_ASSETS_DIR || join(packageRoot, 'local-assets'),
);
if (!existsSync(assetsDir)) {
  console.error(`[local-server] Assets directory does not exist: ${assetsDir}`);
  process.exit(1);
}

const port = Number.parseInt(process.env.LOCAL_FRONTEND_PORT || '8787', 10);
const host = process.env.LOCAL_FRONTEND_HOST || '0.0.0.0';
const htmlHandling =
  /** @type {"auto-trailing-slash" | "drop-trailing-slash" | "force-trailing-slash" | "none"} */ (
    process.env.LOCAL_FRONTEND_HTML_HANDLING || 'none'
  );

// Auto-parse `_redirects` from the assets dir if present. Mirrors what
// control-api does at deploy time (see services/control-api/src/services/
// deployment.service.ts:deployViaWfp) so the local dev experience matches
// production.
let redirectsRulesJson = '';
const redirectsPath = join(assetsDir, '_redirects');
if (existsSync(redirectsPath)) {
  const text = readFileSync(redirectsPath, 'utf8');
  const { rules, warnings } = parseRedirects(text);
  for (const w of warnings) console.warn(`[local-server] _redirects: ${w}`);
  if (rules.length > 0) {
    redirectsRulesJson = JSON.stringify(rules);
  }
}

// Strip _redirects from the served assets dir, mirroring deployViaWfp which
// deletes the file from the upload bundle after parsing so /_redirects → 404
// in prod. Build a symlink farm excluding _redirects so the local worker sees
// the same bundle shape without mutating the user's actual dist/.
let servedDir = assetsDir;
if (existsSync(redirectsPath)) {
  const stripped = mkdtempSync(join(tmpdir(), 'bb-local-assets-'));
  for (const entry of readdirSync(assetsDir)) {
    if (entry === '_redirects') continue;
    symlinkSync(join(assetsDir, entry), join(stripped, entry));
  }
  servedDir = stripped;
}

const mf = new Miniflare({
  modules: true,
  script: workerSource,
  host,
  port,
  // BB_REDIRECTS_RULES is a plain_text binding in prod; mirror that exactly so
  // the worker reads it the same way locally.
  bindings: redirectsRulesJson
    ? { BB_REDIRECTS_RULES: redirectsRulesJson }
    : {},
  assets: {
    directory: servedDir,
    binding: 'ASSETS',
    assetConfig: {
      html_handling: htmlHandling,
    },
    // Match prod: in a WfP dispatch namespace the user worker is the entry
    // point and env.ASSETS is just a binding. Miniflare's default routes
    // assets ahead of the user worker, which would bypass our SPA fallback.
    routerConfig: {
      has_user_worker: true,
      invoke_user_worker_ahead_of_assets: true,
    },
  },
});

// Trigger initialization so the server is bound before we log readiness.
await mf.ready;

console.log(`[local-server] static-frontend-worker ready`);
console.log(`[local-server]   listening:    http://${host}:${port}`);
console.log(`[local-server]   assets dir:   ${assetsDir}`);
console.log(`[local-server]   html_handling: ${htmlHandling}`);
if (redirectsRulesJson) {
  const ruleCount = JSON.parse(redirectsRulesJson).length;
  console.log(`[local-server]   _redirects:   ${ruleCount} rule(s) loaded`);
} else {
  console.log(`[local-server]   _redirects:   (none)`);
}
console.log(`[local-server] try:`);
console.log(`[local-server]   curl -sI http://localhost:${port}/                  # 200 + text/html`);
console.log(`[local-server]   curl -sI http://localhost:${port}/some/deep/route   # 200 (SPA fallback)`);
console.log(`[local-server]   curl -sI http://localhost:${port}/about             # 200 (resolves /about.html)`);

const shutdown = async (signal) => {
  console.log(`[local-server] received ${signal}, shutting down…`);
  await mf.dispose();
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
