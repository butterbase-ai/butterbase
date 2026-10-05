// submodules/butterbase-oss/packages/cli/src/__tests__/init-sdk.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { pinLatestSdk } from '../commands/init.js';

const TEMPLATE_RANGE = '^2.10.0';

describe('pinLatestSdk', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-init-'));
    await fs.writeJson(path.join(dir, 'package.json'), {
      name: 'app',
      dependencies: { '@butterbase/sdk': TEMPLATE_RANGE, react: '^19.2.4' },
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.remove(dir);
  });

  const sdkRange = async () =>
    (await fs.readJson(path.join(dir, 'package.json'))).dependencies['@butterbase/sdk'];

  it('writes the registry latest as a caret range', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ version: '3.1.4' }), { status: 200 }),
    );

    expect(await pinLatestSdk(dir)).toBe('3.1.4');
    expect(await sdkRange()).toBe('^3.1.4');
    expect(fetchSpy.mock.calls[0][0]).toBe('https://registry.npmjs.org/@butterbase/sdk/latest');
  });

  it('keeps the template range when the registry is unreachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));

    expect(await pinLatestSdk(dir)).toBeNull();
    expect(await sdkRange()).toBe(TEMPLATE_RANGE);
  });

  it('keeps the template range on a non-OK or malformed response', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('nope', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ version: 'garbage' }), { status: 200 }));

    expect(await pinLatestSdk(dir)).toBeNull();
    expect(await pinLatestSdk(dir)).toBeNull();
    expect(await sdkRange()).toBe(TEMPLATE_RANGE);
  });

  it('leaves templates without the SDK untouched', async () => {
    await fs.writeJson(path.join(dir, 'package.json'), { name: 'app', dependencies: {} });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    expect(await pinLatestSdk(dir)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
