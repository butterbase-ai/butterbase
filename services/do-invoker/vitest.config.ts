import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
        // DO_INVOKER_TOKEN is a wrangler secret, so wrangler.toml does not
        // carry it; the dispatch tests authenticate with this value.
        miniflare: { bindings: { DO_INVOKER_TOKEN: 'test-token' } },
      },
    },
  },
});
