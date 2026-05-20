# bb-placeholder

Shared placeholder worker deployed into the `bb-frontends` dispatch
namespace under script name `__placeholder__`. Serves the Butterbase
landing page for newly-initialized WfP apps that haven't deployed a real
frontend yet.

## Deploy

```bash
cd bb-placeholder
npx wrangler deploy --dispatch-namespace bb-frontends
```

Wrangler 3.x does not recognize the `dispatch_namespace` top-level key,
so the CLI flag is required. Wrangler 4.x may accept the key — update
the README if/when we upgrade.

Re-deploy whenever `index.js` changes.

## Architecture

- `init_app` (backend=wfp) writes KV `sub:{subdomain} → __placeholder__`.
- Dispatch worker (`dispatch-worker/`) reads KV and calls
  `env.DISPATCHER.get(scriptName).fetch(request)`.
- This worker receives the request, reads the Host header to derive the
  subdomain, and renders the landing page.
- First real user deploy overwrites the KV pointer with the real
  `app.id`; this worker is no longer hit for that subdomain.
