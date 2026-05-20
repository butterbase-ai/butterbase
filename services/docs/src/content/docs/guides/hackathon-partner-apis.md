---
title: Using Hackathon Partner APIs
description: Call Seedance, Z.AI / 智谱, and other sponsor APIs from your hackathon project — no partner keys to manage.
draft: true
---

When you participate in a Butterbase-hosted hackathon, the host pre-loads partner API keys
into Butterbase. Your code calls partner APIs through Butterbase using your normal project
key, and Butterbase handles partner-side auth.

## What you need before you start

- **Hackathon slug** — the URL identifier of the hackathon you're in (e.g. `butterbase-may-2026`). Get it from the host or copy it out of the dashboard URL when you're viewing the hackathon.
- **Submission code** — provided by the organizer. You only need it once, on your first submission, to bind your account to the hackathon.
- **Butterbase service key** (`bb_sk_…`) — generate one in the dashboard or via the `generate_service_key` MCP tool. Use this in `Authorization: Bearer …` for all partner-proxy calls.
- **Your `app_id`** — the Butterbase app the request is associated with (`app_…`). Visible in the dashboard or via `list_apps`.

## 1. Discover what's available

```ts
const { data: partners } = await bb.partners.list('your-hackathon-slug');
console.table(partners);
```

Or from the CLI:

```bash
butterbase partners list --hackathon your-hackathon-slug --app app_xxxxxxxxxxxx
```

You'll see entries like `seedance` (video gen), `zhipu` (Z.AI chat models), and `qingyun` (OpenAI-compatible aggregator: GPT, Claude, Gemini, image, video, music).

## 2. Call a partner

The proxy URL pattern is:

```
${BUTTERBASE_URL}/v1/${APP_ID}/partners/${HACKATHON_SLUG}/${PARTNER_SLUG}/${PARTNER_PATH}
```

Send the request you'd send to the partner directly, but with `Authorization: Bearer <your bb_sk_ key>`. The proxy strips your auth header, swaps in the partner's key, and forwards everything else verbatim.

**SDK — Qingyun (OpenAI-compatible chat completion):**

```ts
const res = await bb.partners.fetch(
  'your-hackathon-slug',
  'qingyun',
  '/v1/chat/completions',
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'Suggest 3 hackathon ideas about cats.' }],
    }),
  },
);
const { choices } = await res.json();
```

**CLI — same call:**

```bash
butterbase partners curl qingyun /v1/chat/completions \
  --hackathon your-hackathon-slug --app app_xxxxxxxxxxxx \
  -X POST \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}' \
  -x
```

(`-x` actually executes. Without it, the CLI prints a copy-pastable curl with your key masked.)

**SDK — Z.AI / 智谱 chat completion:**

```ts
const res = await bb.partners.fetch(
  'your-hackathon-slug',
  'zhipu',
  '/api/paas/v4/chat/completions',
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'glm-4',
      messages: [{ role: 'user', content: 'hi' }],
    }),
  },
);
```

## 3. Handle the "quota exhausted" case

Partner pools have finite quota. When the pool is dead, every request returns:

```json
{ "error": { "code": "PARTNER_QUOTA_EXHAUSTED",
             "message": "The free Seedance quota for this hackathon has been used up.",
             "remediation": "DM @host on Discord." } }
```

Surface that `remediation` text to your user — it tells them how to ask the host for more.

```ts
if (!res.ok) {
  const err = await res.json();
  if (err.error?.code === 'PARTNER_QUOTA_EXHAUSTED') {
    showToast(err.error.remediation);
  } else {
    throw err;
  }
}
```

## What does NOT happen

- Partner keys are **never** exposed to your app or your users.
- Butterbase does **not** track per-partner quota. Partners track it themselves; when a key
  goes dead, Butterbase rotates to the next.
- There is no per-project quota. The pool is shared across all participants — it's first-come.

## Troubleshooting

If a request fails before reaching the partner, you'll see one of:

| Status | Code | What it means |
|---|---|---|
| 404 | `HACKATHON_NOT_FOUND` | The slug in the URL doesn't match any hackathon. Check spelling. |
| 503 | `HACKATHON_NOT_IN_WINDOW` | The hackathon exists but is outside its submission window. **Terminal — don't retry.** |
| 403 | `NOT_HACKATHON_PARTICIPANT` | You're authenticated, but not a participant of this hackathon. Run the submission flow first to bind your account. |
| 404 | `PARTNER_NOT_FOUND` | The hackathon is correct but no partner with that slug is configured. Run `partners.list(...)` to see what's available. |
| 503 | `PARTNER_QUOTA_EXHAUSTED` | All keys in the pool are dead. Show `error.remediation` to your user — it's the host's contact instructions. |
| 400 | `REQUEST_ERROR` ("Body is not valid JSON…") | Your body bytes didn't parse as JSON. Common cause on Windows: shells double-quoting issues. See [Common gotchas](/api-reference/partners-api#common-gotchas). |

For shell-specific footguns (PowerShell UTF-16 bodies, Git Bash MSYS path mangling, JSON quoting), see the [API reference's Common gotchas section](/api-reference/partners-api#common-gotchas).
