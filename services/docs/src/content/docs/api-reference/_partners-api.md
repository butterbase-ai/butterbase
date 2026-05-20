---
title: Partners API
description: Forward requests to hackathon partner APIs (Seedance, Z.AI, etc.) without managing partner API keys.
draft: true
---

The Partners API is a generic HTTP forwarder. Hackathon participants call partner endpoints
through Butterbase using their existing project key (`bb_sk_*`); Butterbase swaps in a host-
supplied partner key from a pool. Hackers never see partner keys.

## Endpoints

### `GET /v1/{appId}/partners/{hackathonSlug}`

List partner APIs available to the named hackathon. Multiple hackathons can be open simultaneously; the slug in the URL selects which one.

**Auth:** any Butterbase project key.

**Response:**

```json
{
  "partners": [
    {
      "slug": "seedance",
      "display_name": "Seedance",
      "description": "AI video generation",
      "docs_url": "https://docs.seedance.ai",
      "proxy_url_template": "https://api.butterbase.ai/v1/app_abc/partners/butterbase-may-2026/seedance{path}",
      "contact_message": "DM @host on Discord.",
      "status": "available"
    }
  ]
}
```

`status: "exhausted"` means the pool is currently dead. Show `contact_message` to the user.

### `ANY /v1/{appId}/partners/{hackathonSlug}/{slug}/{path...}`

Forward the request to `partner.base_url + /{path...}` (with the original querystring) and
stream the response back.

**Auth:** any Butterbase project key. The user must be a participant in the named hackathon. Multiple hackathons can be open simultaneously; the slug in the URL selects which one.

**Headers:** all inbound headers except `host`, `authorization`, `cookie`, and standard
hop-by-hop headers (`content-length`, `connection`, etc.) are forwarded. The proxy injects
the partner-side auth header (or query param) per the partner's configured `auth_template`.

**Body:** forwarded verbatim. JSON, multipart, octet-stream, raw bytes — all pass through.

**Response status codes:**

| Status | Meaning |
| --- | --- |
| 2xx / 3xx / partner 4xx (other) / 5xx | Partner's response, returned unchanged. |
| 401 / 402 / 403 / 429 from partner | Internally retried up to 3 times with the next pool key. The caller never sees these unless the whole pool is dead. |
| 404 PARTNER_NOT_FOUND | Slug isn't configured for this hackathon. |
| 403 NOT_HACKATHON_PARTICIPANT | Caller isn't an active participant of the named hackathon. |
| 404 HACKATHON_NOT_FOUND | No hackathon exists with the slug in the URL. |
| 503 HACKATHON_NOT_IN_WINDOW | The named hackathon exists but is outside its submission window. Terminal — retrying won't help; pick a different hackathon. |
| 503 PARTNER_QUOTA_EXHAUSTED | All keys in the pool returned a quota-dead status. Body includes `error.remediation` with the host's contact instructions. |

**Example (Seedance):**

```bash
curl -X POST https://api.butterbase.ai/v1/app_abc/partners/<hackathonSlug>/seedance/v1/video/generate \
  -H "Authorization: Bearer bb_sk_xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "a cat dancing", "duration": 4}'
```

**Example (Z.AI / 智谱):**

```bash
curl -X POST https://api.butterbase.ai/v1/app_abc/partners/<hackathonSlug>/zhipu/api/paas/v4/chat/completions \
  -H "Authorization: Bearer bb_sk_xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"glm-4","messages":[{"role":"user","content":"hi"}]}'
```

**Example (Qingyun, OpenAI-compatible aggregator):**

```bash
curl -X POST https://api.butterbase.ai/v1/app_abc/partners/<hackathonSlug>/qingyun/v1/chat/completions \
  -H "Authorization: Bearer bb_sk_xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
```

## Quota exhausted error

```json
{
  "error": {
    "code": "PARTNER_QUOTA_EXHAUSTED",
    "message": "The free Seedance quota for this hackathon has been used up.",
    "remediation": "DM @host on Discord.",
    "details": { "partner": "seedance" }
  }
}
```

## Common gotchas

### PowerShell 5.1 sends string bodies as UTF-16

`Invoke-WebRequest -Body '<json>'` in Windows PowerShell 5.1 transmits the JSON as UTF-16, so the partner's parser sees a null byte after every character and rejects the request (often with a vague `400 BadRequest`). Two fixes:

```powershell
# Option A: convert to UTF-8 bytes explicitly.
$bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
Invoke-WebRequest -Method POST -Uri $uri -Headers $headers -Body $bytes -UseBasicParsing
```

```powershell
# Option B: shell out to curl.exe (Windows ships it at C:\Windows\System32\curl.exe).
curl.exe -X POST -H "Content-Type: application/json" --data-binary "@body.json" $uri
```

PowerShell 7+ has `-SkipHttpErrorCheck` and saner string handling; consider using it for any scripted partner work.

### Git Bash on Windows mangles paths starting with `/`

If you run the CLI from Git Bash on Windows, MSYS rewrites `/v1/chat/completions` into `C:/Program Files/Git/v1/chat/completions` before the CLI ever sees it. The CLI then refuses with `Path must start with "/"`. Two fixes:

```bash
# Option A: disable conversion just for this command.
MSYS_NO_PATHCONV=1 butterbase partners curl qingyun /v1/chat/completions \
  --hackathon my-hackathon -X POST -d '{...}' -x

# Option B: prefix with `//` — MSYS leaves anything starting `//` alone.
butterbase partners curl qingyun //v1/chat/completions \
  --hackathon my-hackathon -X POST -d '{...}' -x
```

For the global fix, add `export MSYS_NO_PATHCONV=1` to `~/.bashrc`.

### Body must be valid JSON when `Content-Type: application/json`

The proxy forwards bodies verbatim, but a JSON content type still has to be parseable JSON. If you see `REQUEST_ERROR: Body is not valid JSON but content-type is set to 'application/json'`, the bytes you sent didn't parse — usually a quoting or encoding issue (BOM, CRLF, escaped quotes lost in shell quoting). Write the body to a file and use `--data-binary @file` to bypass shell quoting entirely.
