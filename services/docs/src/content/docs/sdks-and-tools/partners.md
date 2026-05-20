---
title: Partners
description: SDK and CLI for the Partners proxy.
draft: true
---

## SDK

```ts
import { createClient } from '@butterbase/sdk';
const bb = createClient({ apiUrl: 'https://api.butterbase.ai', appId: 'app_abc', anonKey: 'bb_sk_...' });

// 1. Discover what's available
const { data: partners } = await bb.partners.list('your-hackathon-slug');
// [{ slug: 'seedance', status: 'available', ... }]

// 2. Call a partner
const res = await bb.partners.fetch('your-hackathon-slug', 'zhipu', '/api/paas/v4/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'glm-4', messages: [{ role: 'user', content: 'hi' }] }),
});
if (!res.ok) {
  const err = await res.json();
  if (err.error?.code === 'PARTNER_QUOTA_EXHAUSTED') {
    alert(err.error.remediation); // "DM @host on Discord."
  }
} else {
  console.log(await res.json());
}
```

`partners.fetch` returns a raw `Response`, so streaming works:

```ts
const stream = await bb.partners.fetch('your-hackathon-slug', 'zhipu', '/api/paas/v4/chat/completions', {
  method: 'POST',
  body: JSON.stringify({ model: 'glm-4', stream: true, messages: [...] }),
});
for await (const chunk of stream.body!) { /* SSE bytes */ }
```

## CLI

```bash
butterbase partners list --hackathon your-hackathon-slug
butterbase partners curl seedance /v1/video/generate --hackathon your-hackathon-slug -X POST -d '{"prompt":"a cat"}'
butterbase partners curl seedance /v1/video/generate --hackathon your-hackathon-slug -X POST -d '{"prompt":"a cat"}' -x   # actually run
```

The `curl` command prints a copy-pastable curl with your project key masked. Add `-x` to execute it.
