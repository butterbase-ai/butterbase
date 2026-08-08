/**
 * The dependency-cache key rule, and the ONE place it is now defined.
 *
 * WHY THIS FILE EXISTS. The rule used to be written out three times: once in
 * deploy.ts (the from-source deploy), once in build-hydration.ts (the operator
 * sandbox build), and — as of the baked-node_modules image — once more inside
 * a Dockerfile. Three copies of a hash rule is three chances for two of them
 * to disagree, and a disagreement here is SILENT: the sandbox simply never
 * hits its cache and pays a full `npm install` forever, with no error anywhere.
 *
 * So the TypeScript copies are collapsed into `install-key.ts` and the image's
 * copy is pinned by the last test in this file, which asserts that the exact
 * quantity a Dockerfile can compute with `sha256sum package.json` is the same
 * value `installKeyFor` produces for the real template tree.
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

import { installKeyFor, LOCKFILE_NAMES } from '../install-key.js'

const HERE = fileURLToPath(new URL('.', import.meta.url))
// src/services/dashboard-agent/__tests__ -> services/dashboard-agent-template
const TEMPLATE_ROOT = join(HERE, '..', '..', '..', '..', '..', '..', 'dashboard-agent-template')

function tree(files: Record<string, string>) {
  return new Map(
    Object.entries(files).map(([path, content]) => [path, { path, content }]),
  )
}

describe('installKeyFor', () => {
  it('hashes the lockfile CONTENT when there is one', () => {
    const a = installKeyFor(tree({ 'package.json': '{"name":"x"}', 'package-lock.json': 'v1' }))
    const b = installKeyFor(tree({ 'package.json': '{"name":"y"}', 'package-lock.json': 'v1' }))
    // Same lockfile, different package.json: the install is the same install.
    expect(a).toBe(b)
    expect(a).toBe(createHash('sha256').update('v1', 'utf8').digest('hex'))
  })

  it('falls back to package.json when there is no lockfile', () => {
    // NOT an edge case: dashboard-agent-template ships no lockfile and
    // file-ops.ts:23 denies the agent any write to package-lock.json, so this
    // is the ONLY branch that runs for a scaffolded app.
    const a = installKeyFor(tree({ 'package.json': '{"deps":1}' }))
    expect(a).toBe(createHash('sha256').update('{"deps":1}', 'utf8').digest('hex'))
    expect(a).not.toBe(installKeyFor(tree({ 'package.json': '{"deps":2}' })))
  })

  it('hashes the empty string for an empty tree rather than throwing', () => {
    expect(installKeyFor(tree({}))).toMatch(/^[a-f0-9]{64}$/)
  })

  it('prefers lockfiles in a fixed order so two writers cannot disagree', () => {
    expect([...LOCKFILE_NAMES]).toEqual(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'])
    const both = tree({ 'package-lock.json': 'npm', 'yarn.lock': 'yarn' })
    expect(installKeyFor(both)).toBe(createHash('sha256').update('npm', 'utf8').digest('hex'))
  })
})

describe('the baked-image key agrees with the runtime key', () => {
  /**
   * THE AGREEMENT THAT MAKES THE BAKED IMAGE WORK.
   *
   * The image records the key it was baked with at /opt/butterbase/baked-install-key
   * and the sandbox compares the app's runtime key against it. If those two
   * are computed by different rules the optimisation never fires and nothing
   * reports an error — so the agreement is asserted, not assumed.
   *
   * The image computes `sha256sum package.json` over the template's own
   * package.json, because a scaffolded app carries the template's package.json
   * byte-for-byte and no lockfile. This test is what makes that shortcut legal.
   */
  it('sha256 of the template package.json == installKeyFor(the template tree)', async () => {
    const pkg = await readFile(join(TEMPLATE_ROOT, 'package.json'), 'utf8')
    const bakedRule = createHash('sha256').update(pkg, 'utf8').digest('hex')

    // A tree exactly as a freshly scaffolded app has it: template files, no
    // lockfile (template-loader.ts copies what is on disk, and there is none).
    const runtimeRule = installKeyFor(tree({
      'package.json': pkg,
      'index.html': '<html></html>',
      'src/App.tsx': 'export default function App(){return null}',
      '.env': 'VITE_APP_ID=app_1234',
    }))

    expect(runtimeRule).toBe(bakedRule)
  })

  it('a tree that DOES carry a lockfile no longer matches the baked key', async () => {
    // Tier 1 must miss here, not silently reuse a tree that was resolved from
    // a different lockfile. This is the safety half of the agreement.
    const pkg = await readFile(join(TEMPLATE_ROOT, 'package.json'), 'utf8')
    const baked = createHash('sha256').update(pkg, 'utf8').digest('hex')
    expect(installKeyFor(tree({ 'package.json': pkg, 'package-lock.json': '{}' }))).not.toBe(baked)
  })
})
