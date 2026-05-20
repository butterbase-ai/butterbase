# WfP cutover E2E fixtures

Static site + zip builder used to verify the WfP deployment path end-to-end.

## Run

```sh
node scripts/wfp-e2e/build-zip.mjs
```

Produces `scripts/wfp-e2e/frontend.zip` from `scripts/wfp-e2e/dist/`.

## Verification flow

1. `mcp.init_app({ name: "wfptest" })`
2. `mcp.create_frontend_deployment({ app_id, framework: "static" })` — returns `uploadUrl`
3. `curl -X PUT <uploadUrl> --data-binary @frontend.zip`
4. `mcp.manage_frontend({ app_id, deployment_id, action: "start_deployment" })` — expect `status: READY`, `url: https://<sub>.butterbase.dev`
5. `curl https://<sub>.butterbase.dev/` and `.../about` — both 200, both serve `index.html`
6. `mcp.manage_frontend({ app_id, action: "set_env", vars: { ... } })` — `updated_at` on all READY rows bumps (= `env_vars_stale` flipped)

See `docs/superpowers/plans/foamy-gliding-wigderson.md` Task 11.
