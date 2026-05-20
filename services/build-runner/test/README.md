# Build runner e2e

Runs against a fully-configured Butterbase environment. The test does NOT
auto-stub a control-api or Cloudflare account — it drives a live pipeline
end-to-end:

1. Zips the fixture Next.js app under `e2e.fixture/`.
2. POSTs `/v1/:appId/edge-ssr/deployments/from-source`.
3. PUTs the zip to the returned presigned R2 URL.
4. POSTs `.../start` with `buildCommand: npx @cloudflare/next-on-pages`,
   `outputDir: .vercel/output/static`, `packageManager: npm`, and the sha256
   of the fixture's `package-lock.json` (first 32 hex chars).
5. Subscribes to the SSE log endpoint and asserts at least one chunk arrives.
6. Polls `GET /v1/:appId/edge-ssr/deployments/:id` for `status` until
   `READY` or `FAILED` (6-minute deadline).
7. If `READY`, fetches the returned `url` and asserts the body contains `ok`.

## Required environment

| Variable           | Description                                                    |
| ------------------ | -------------------------------------------------------------- |
| `CONTROL_API_URL`  | Base URL of a control-api with the from-source routes wired in |
| `BB_API_KEY`       | `bb_sk_`-prefixed API key for the test app                     |
| `BB_APP_ID`        | ID of an existing app to deploy into                           |

The control-api must in turn be configured with:

- `BUILD_RUNNER_URL` pointing to a deployed build-runner Worker.
- `BUILD_RUNNER_SHARED_SECRET` matching the secret on the Worker.
- R2 credentials for the `source/` and `logs/` prefixes.

## Run

```bash
CONTROL_API_URL=https://api.butterbase.ai \
BB_API_KEY=bb_sk_... \
BB_APP_ID=app_... \
  npx vitest run services/build-runner/test/e2e.test.ts
```

The test **skips itself** with a clear console message when any of the three
env vars is missing, so it is safe to leave in CI without flaking.
