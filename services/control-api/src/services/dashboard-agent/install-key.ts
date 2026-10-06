import { createHash } from 'node:crypto'

/**
 * THE DEPENDENCY-CACHE KEY — one definition, four consumers.
 *
 * The question this hash answers is "is the dependency tree I already have the
 * one this source needs?", and it is asked in four places that MUST agree:
 *
 *   1. deploy.ts — the from-source deploy, which hands `lockfile_hash` to the
 *      build-runner container.
 *   2. build-hydration.ts — the operator sandbox build, which presigns the
 *      SHARED R2 tar `cache/<appId>/<hash>.tar` that (1) also reads and writes.
 *   3. cloud/services/cron-scheduler/src/sandbox-build.ts — the guest side,
 *      which compares this value against `.bb-install-key` and against the
 *      image's baked key.
 *   4. docker/operator-sandbox/Dockerfile.baked — the image, which records the
 *      key its baked node_modules was built for.
 *
 * (1) and (2) now import this function. (3) only ever compares strings, so it
 * cannot drift. (4) cannot import TypeScript at `docker build` time, so it
 * computes `sha256sum package.json` instead, and
 * __tests__/install-key.test.ts asserts that this is the same value this
 * function returns for the real template tree.
 *
 * A disagreement between any two of them is SILENT — no error, just a cache
 * that never hits and an `npm install` that never stops being paid. That is
 * the whole reason this is one exported function with its own test file rather
 * than four inline `createHash` calls.
 */

/**
 * Lockfile names in a FIXED precedence order. If two lockfiles somehow coexist
 * in one tree, every consumer must pick the same one — otherwise two writers
 * key the same shared R2 object differently and each keeps invalidating the
 * other's cache.
 */
export const LOCKFILE_NAMES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'] as const

/** The minimum a working tree entry needs to be hashable. */
export type InstallKeyFile = { content: string }

/**
 * sha256 of the lockfile CONTENT, or of package.json's content when there is
 * no lockfile.
 *
 * The package.json fallback is not a degenerate case, it is the ONLY case for
 * a scaffolded app: `dashboard-agent-template` ships no lockfile, and
 * file-ops.ts:23 (`ROOT_MANAGED_PATHS`) denies the agent any write to
 * `package.json` or `package-lock.json`. Which is also why every app has the
 * SAME key, and therefore why baking one node_modules into the sandbox image
 * is correct rather than a bet.
 *
 * Content, never mtime or path list: editing source must not invalidate an
 * install, and two apps with identical dependencies must share one cache
 * entry.
 */
export function installKeyFor(tree: Map<string, InstallKeyFile>): string {
  let source = ''
  for (const name of LOCKFILE_NAMES) {
    const f = tree.get(name)
    if (f) { source = f.content; break }
  }
  if (!source) source = tree.get('package.json')?.content ?? ''
  return createHash('sha256').update(source, 'utf8').digest('hex')
}
