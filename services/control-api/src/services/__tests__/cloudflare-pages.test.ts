/**
 * `wrangler` resolution for Pages deployments.
 *
 * The deploy runs from a temp directory (`/tmp/cf-deploy-...`), where `npx`
 * cannot see the control-api workspace's nested `wrangler` install. In
 * production that surfaced as `sh: wrangler: not found` and every Pages-backed
 * frontend deploy failed after a successful build. The invocation must resolve
 * the installed CLI from this module's own resolution chain and run it with the
 * current Node binary; `npx` stays as the fallback for environments where that
 * resolution does not exist.
 */
import { describe, it, expect } from 'vitest';
import { wranglerInvocation } from '../cloudflare-pages.js';

describe('wranglerInvocation', () => {
  it('runs the resolved wrangler JS entry with the current Node binary', () => {
    const invocation = wranglerInvocation(() => '/app/node_modules/wrangler/bin/wrangler.js');

    expect(invocation.file).toBe(process.execPath);
    expect(invocation.args).toEqual(['/app/node_modules/wrangler/bin/wrangler.js']);
  });

  it('falls back to npx wrangler when the package cannot be resolved', () => {
    const invocation = wranglerInvocation(() => {
      throw new Error('MODULE_NOT_FOUND');
    });

    expect(invocation).toEqual({ file: 'npx', args: ['wrangler'] });
  });
});
