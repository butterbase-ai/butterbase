// scripts/spike-container-wfp.ts
//
// One-off: deploy a hello-world container Worker into the bb-containers WfP
// namespace via raw CF API, mirroring what wrangler does for build-runner.
//
// Usage:
//   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... IMAGE_REF=... \
//     npx tsx scripts/spike-container-wfp.ts
//
// IMAGE_REF must be an image already in the CF managed registry, e.g. the
// build-runner image:
//   registry.cloudflare.com/<account_id>/butterbase-build-runner:<tag>
// (find it: `cd services/build-runner && npx wrangler containers images list`)
//
// The API TOKEN must be a *bearer* token (not a wrangler OAuth login) with at
// least these scopes — verified against wrangler 4.x OAuth scope list:
//   - Workers Scripts:Edit       (workers_scripts:write)
//   - Workers for Platforms      (dispatch namespace script upload)
//   - Containers:Edit            (containers:write)        <-- required
//   - Cloudchamber / Workers Containers (cloudchamber:write) <-- required
//   - Account Settings:Read      (account:read)
// A token missing containers:write / cloudchamber:write will 403 on the
// container-bearing upload. See docs/containers-cf-api-notes.md.
//
// NOTE (2026-06-10): This script's metadata `containers` block is a best-effort
// reconstruction. As of the spike it was NOT executed end-to-end because no
// bearer token with container scopes was available in the dev environment
// (only a wrangler OAuth login missing containers:write/cloudchamber:write).
// The field NAMES below are corroborated by wrangler source
// (node_modules/wrangler) and CF docs, but the exact metadata acceptance for a
// container-enabled DO in a WfP namespace must be confirmed by a successful
// 200 run before any production wrapper relies on it. See the notes doc for the
// proven-vs-inferred breakdown.

const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID!;
const TOKEN = process.env.CLOUDFLARE_API_TOKEN!;
const IMAGE = process.env.IMAGE_REF!;
const NS = 'bb-containers';
const SCRIPT = 'spike_ctr_hello';

if (!ACCOUNT || !TOKEN || !IMAGE) {
  console.error(
    'Missing env. Required: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, IMAGE_REF',
  );
  process.exit(2);
}

// Front-door Worker. We prove the *raw* DurableObject form (this.ctx.container)
// rather than the `@cloudflare/containers` Container base class, because later
// tasks (Task 4 front-door template) generate this raw shape. The bare import
// of '@cloudflare/containers' is not bundled here, so it must be avoided.
const WORKER = `
export class CtrFrontDoor {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.container = ctx.container; // present only for container-enabled DOs
  }
  async fetch(req) {
    if (!this.container) {
      return new Response('no container binding on this DO', { status: 500 });
    }
    if (!this.container.running) {
      this.container.start();
    }
    // Container HTTP server is expected on :8080 (mirrors build-runner).
    return this.container.getTcpPort(8080).fetch(req);
  }
}

export default {
  async fetch(req, env) {
    const id = env.CTR.idFromName('spike');
    return env.CTR.get(id).fetch(req);
  },
};
`;

async function ensureNamespace() {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/dispatch/namespaces`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: NS }),
    },
  );
  const text = await res.text();
  // 200 => created; error code 100119 => already exists. Both are fine.
  console.log('[namespace]', res.status, text.slice(0, 400));
}

async function deploy() {
  const metadata = {
    main_module: 'worker.mjs',
    compatibility_date: '2025-01-24',
    bindings: [
      {
        type: 'durable_object_namespace',
        name: 'CTR',
        class_name: 'CtrFrontDoor',
      },
    ],
    // Container-enabled DOs require the SQLite-backed storage backend, so the
    // class must be registered via new_sqlite_classes (matches build-runner's
    // wrangler.toml `[[migrations]] new_sqlite_classes`).
    migrations: { new_tag: 'v1', new_sqlite_classes: ['CtrFrontDoor'] },
    containers: [
      {
        class_name: 'CtrFrontDoor',
        image: IMAGE,
        max_instances: 1,
        instance_type: 'basic',
      },
    ],
  };

  const form = new FormData();
  form.append(
    'metadata',
    new Blob([JSON.stringify(metadata)], { type: 'application/json' }),
  );
  form.append(
    'worker.mjs',
    new Blob([WORKER], { type: 'application/javascript+module' }),
    'worker.mjs',
  );

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/dispatch/namespaces/${NS}/scripts/${SCRIPT}`,
    { method: 'PUT', headers: { Authorization: `Bearer ${TOKEN}` }, body: form },
  );
  console.log('[deploy]', res.status, await res.text());
}

async function main() {
  await ensureNamespace();
  await deploy();
  console.log(
    `\nCleanup when done:\n  curl -X DELETE \\\n    "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/dispatch/namespaces/${NS}/scripts/${SCRIPT}?force=true" \\\n    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"`,
  );
}

main();
