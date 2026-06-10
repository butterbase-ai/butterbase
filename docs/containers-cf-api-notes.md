# Containers via raw CF API — WfP deploy notes (Task 1 spike)

**Status: PARTIALLY VERIFIED — the end-to-end PUT was NOT executed.**

This document is the source of truth for the WfP container deploy API shape that
later tasks consume verbatim (Task 4 front-door template, Task 5 CF API wrapper,
Task 10 registry facade). It is split into two clearly-labelled tiers:

- **PROVEN** — confirmed by a successful live API call.
- **INFERRED** — reconstructed from wrangler source (`node_modules/wrangler/wrangler-dist/cli.js`,
  wrangler 4.93.0) and Cloudflare API docs, but NOT yet confirmed by a 200 response.

> ⚠️ **Blocker recorded 2026-06-10.** The spike could not be run to a successful
> PUT because no Cloudflare **bearer token** with container scopes was available
> in the dev environment. The only credential present was a wrangler **OAuth
> login** (`wrangler whoami`: kcflexigbo@gmail.com), and that token is **missing
> the `containers:write` and `cloudchamber:write` scopes** (wrangler itself
> warns about this). See "Credentials required to re-run" below. Re-run
> `scripts/spike-container-wfp.ts` with a proper token to promote the INFERRED
> sections to PROVEN.

---

## 1. Dispatch namespace (PROVEN shape, INFERRED result)

The namespace `bb-containers` is created (idempotently) via:

```
POST https://api.cloudflare.com/client/v4/accounts/{account_id}/workers/dispatch/namespaces
Authorization: Bearer {token}
Content-Type: application/json

{"name":"bb-containers"}
```

- Expected: `success: true` on first create, or error **100119 "namespace
  already exists"** on subsequent runs — both are acceptable / idempotent.
- The path `workers/dispatch/namespaces` and the per-script path
  `workers/dispatch/namespaces/{ns}/scripts/{script}` are **confirmed against
  wrangler source** (grep of `cli.js` lists exactly these route templates) and
  CF docs. → This part of the path shape is reliable; only the *create result*
  is unverified here because the call wasn't run.

---

## 2. Worker upload metadata (INFERRED)

Container Workers are uploaded to a dispatch namespace with the same multipart
`PUT .../scripts/{script}` endpoint used for normal WfP user Workers:

```
PUT https://api.cloudflare.com/client/v4/accounts/{account_id}/workers/dispatch/namespaces/bb-containers/scripts/{script_name}
Authorization: Bearer {token}
Content-Type: multipart/form-data
  part "metadata"   (application/json)            <- the JSON below
  part "worker.mjs" (application/javascript+module)
```

### Working metadata JSON (best-effort, to be confirmed)

```json
{
  "main_module": "worker.mjs",
  "compatibility_date": "2025-01-24",
  "bindings": [
    { "type": "durable_object_namespace", "name": "CTR", "class_name": "CtrFrontDoor" }
  ],
  "migrations": { "new_tag": "v1", "new_sqlite_classes": ["CtrFrontDoor"] },
  "containers": [
    {
      "class_name": "CtrFrontDoor",
      "image": "registry.cloudflare.com/<account_id>/<image>:<tag>",
      "max_instances": 1,
      "instance_type": "basic"
    }
  ]
}
```

Field-by-field provenance:

| Field | Status | Evidence |
| --- | --- | --- |
| `main_module` | INFERRED (standard) | CF docs: module Workers reference the entry module by `main_module`. |
| `bindings[].type = durable_object_namespace` | INFERRED | wrangler `cli.js` emits this exact string for DO bindings. |
| `migrations.new_sqlite_classes` | INFERRED, high confidence | See §3 — build-runner's own `wrangler.toml` uses `new_sqlite_classes` for its container DO. |
| `migrations.new_tag` | INFERRED | wrangler uses `new_tag` (not `tag`) in the *upload metadata*; `tag` is the wrangler.toml form. Both `new_classes` and `new_sqlite_classes` appear in `cli.js`. |
| `containers[]` block | INFERRED, LOW confidence | See §4 — wrangler may provision containers via a **separate Cloudchamber `/applications` API** rather than (or in addition to) this metadata field. This is the single most important thing to verify on re-run. |

---

## 3. `new_sqlite_classes` vs `new_classes` for container DOs (INFERRED, high confidence)

**Use `new_sqlite_classes`.** Container-enabled Durable Objects require the
SQLite-backed storage backend. Evidence:

- `services/build-runner/wrangler.toml` registers its container DO with:
  ```toml
  [[migrations]]
  tag = "v1"
  new_sqlite_classes = ["BuildContainer"]
  ```
  build-runner is a *deployed, working* container Worker, so this is the proven
  form for the wrangler.toml → metadata translation.
- In raw upload metadata the equivalent key is `new_sqlite_classes` (the
  `new_classes` variant exists for non-SQLite DOs). Both keys are present in
  wrangler's `cli.js`.

A `class_name` listed in `containers[]` MUST also be migrated as a SQLite class
in the same upload, or the DO will be created with the wrong backend.

---

## 4. Image reference format (INFERRED) + registry credential flow (PROVEN from source)

### Image reference format

The CF **managed registry** domain is `registry.cloudflare.com`
(staging: `staging.registry.cloudflare.com`) — confirmed in wrangler source
(`getCloudflareContainerRegistry`). The `image` field in the metadata must be a
**fully-qualified registry reference without the `https://` scheme**, e.g.:

```
registry.cloudflare.com/<account_id>/<repo>:<tag>
```

wrangler source explicitly errors if the registry value *includes* the protocol
part ("should not include the protocol part, e.g. registry.cloudflare.com rather
than https://registry.cloudflare.com"). Find existing images with:

```
cd services/build-runner && npx wrangler containers images list
```

### Registry push credential flow (for `wrangler containers push` — Task 10)

Confirmed from wrangler source (`ImageRegistriesService`, `src/containers/registries.ts`):

1. wrangler resolves the managed registry domain (`registry.cloudflare.com`).
2. It requests **short-lived registry credentials** from the Cloudchamber API:
   ```
   POST .../registries/{domain}/credentials
   {
     "expiration_minutes": 5,
     "permissions": ["push", "pull"]   // push for `containers push`, pull for runtime
   }
   ```
   (For a pull-only flow wrangler sends `permissions: ["pull"]`; push CLI sends
   both.)
3. The returned credential is used as a **docker registry password** of the form
   `v1:<credential>` (wrangler builds the docker auth as `Buffer.from(\`v1:${credentials...}\`)`),
   with the standard docker login / `docker push` against
   `registry.cloudflare.com`. i.e. the registry uses Basic-auth docker login
   with an ephemeral, scoped token rather than a long-lived password.

The Cloudchamber API for these calls is the account-scoped containers base
(documented base: `https://api.cloudflare.com/client/v4/accounts/{account_id}/cloudchamber`,
with the registries/applications routes under `containers-shared`
`ImageRegistriesService` / `ApplicationsService`). The exact base prefix is
built dynamically in wrangler, so confirm with a live call before hard-coding.

> **Architecture note for Task 5 / Task 10:** wrangler does NOT push images or
> fully provision container capacity through the WfP `scripts` upload alone. It
> uses the separate **Cloudchamber `/applications` API**
> (`/applications`, `/applications/{id}`, `/applications/{id}/rollouts`,
> `/applications/{id}/deployments`, etc. — all present in `cli.js`) to manage the
> container application lifecycle. Whether a WfP-namespaced container Worker
> needs an explicit `/applications` provisioning step in addition to the
> `containers[]` metadata field is the key open question for the re-run.

---

## 5. Front-door Worker shape (INFERRED — raw `ctx.container` form)

Later tasks generate the **raw DurableObject** form (not the
`@cloudflare/containers` `Container` base class), because the bare
`@cloudflare/containers` import is not bundled into the uploaded module. The
spike script uses:

```js
export class CtrFrontDoor {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; this.container = ctx.container; }
  async fetch(req) {
    if (!this.container.running) this.container.start();
    return this.container.getTcpPort(8080).fetch(req);  // container HTTP on :8080
  }
}
export default {
  async fetch(req, env) {
    const id = env.CTR.idFromName('spike');
    return env.CTR.get(id).fetch(req);
  },
};
```

`this.ctx.container` (the `getTcpPort(8080).fetch()` form) mirrors build-runner's
runtime access pattern (build-runner uses `container.getTcpPort(8080).fetch()` —
see its `wrangler.toml` comment). `ctx.container` is only present on a DO class
that is registered in the `containers[]` metadata block.

---

## 6. Credentials required to re-run (the current blocker)

To execute the spike to a 200, you need a Cloudflare **API bearer token** (NOT a
wrangler OAuth login) for account `de35c2e8...` (or the WithNira account) with:

- Workers Scripts: Edit
- Workers for Platforms (dispatch namespace script upload)
- **Containers: Edit** (`containers:write`)  ← missing from current OAuth token
- **Cloudchamber / Workers Containers** (`cloudchamber:write`)  ← missing
- Account Settings: Read

Then:

```bash
export CLOUDFLARE_ACCOUNT_ID=<account_id>
export CLOUDFLARE_API_TOKEN=<bearer_token_with_container_scopes>
export IMAGE_REF=registry.cloudflare.com/<account_id>/butterbase-build-runner:<tag>
npx tsx scripts/spike-container-wfp.ts
```

A `403` with a permissions error = the token still lacks the scopes above
(re-mint it), not a code bug. On success (HTTP 200, `success: true`), promote
§2 and §4's `containers[]`/`/applications` open questions to PROVEN and record
the verbatim response here, then clean up:

```bash
curl -X DELETE \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/dispatch/namespaces/bb-containers/scripts/spike_ctr_hello?force=true" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```
