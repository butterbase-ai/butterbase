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

`wrangler.json` has no dispatch-namespace setting, so the CLI flag is
required. (The repo now uses Wrangler 4.x; whether it accepts a
`dispatch_namespace` config key here is unverified.)

Re-deploy whenever `index.js` changes.

## Architecture

- `init_app` (backend=wfp) writes KV `sub:{subdomain} → __placeholder__`.
- Dispatch worker (`dispatch-worker/`) reads KV and calls
  `env.DISPATCHER.get(scriptName).fetch(request)`.
- This worker receives the request, reads the Host header to derive the
  subdomain, and renders the landing page.
- First real user deploy overwrites the KV pointer with the real
  `app.id`; this worker is no longer hit for that subdomain.
