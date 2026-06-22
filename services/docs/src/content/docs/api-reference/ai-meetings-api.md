---
title: AI Meetings API
description: Complete reference for the meeting-bot REST endpoints.
sidebar:
  order: 7
---

Endpoints for spawning meeting bots, inspecting their lifecycle, retrieving recordings + transcripts, and configuring webhook delivery. See [AI Meetings](/core-concepts/ai-meetings/) for the conceptual overview and a complete worked example.

All endpoints are app-scoped — the `app_id` lives in the URL path, and the call is authenticated with a Butterbase service-key (`bb_sk_...`) belonging to that app's owner.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | /v1/\{app_id\}/ai/meetings | Spawn a meeting bot |
| GET | /v1/\{app_id\}/ai/meetings/\{bot_id\} | Get one bot — status, duration, URLs |
| DELETE | /v1/\{app_id\}/ai/meetings/\{bot_id\} | Force the bot to leave the call |
| GET | /v1/\{app_id\}/ai/meetings | List this app's bots |
| GET | /v1/\{app_id\}/ai/meetings/\_estimate | Predict the USD charge for a session |
| GET | /v1/\{app_id\}/ai/meetings/usage | Recent `actor_usage_logs` rows for the app |
| PUT | /v1/\{app_id\}/ai/meetings/webhook | Configure forward URL + (re)mint signing secret |
| GET | /v1/ai/meetings/\_status | Public — `{ "available": true \| false }` |

## Spawn a bot

```
POST /v1/{app_id}/ai/meetings
Authorization: Bearer {token}
Content-Type: application/json

{
  "meetingUrl": "https://zoom.us/j/12345...",
  "transcript": true,
  "recording": "mp4",
  "botName": "Acme Notetaker",
  "metadata": { "session_id": "abc123" },
  "automaticLeave": {
    "waitingRoomTimeoutSec": 900,
    "noOneJoinedTimeoutSec": 600,
    "everyoneLeftTimeoutSec": 120,
    "inCallNotRecordingTimeoutSec": 1800
  }
}
```

| Field | Type | Default | Notes |
|---|---|---|---|
| `meetingUrl` | string | required | Any Zoom / Meet / Teams / Webex URL |
| `transcript` | boolean | `true` | Transcribe in addition to recording |
| `recording` | `"mp4" \| "audio_only" \| false` | `"mp4"` | `false` skips recording entirely |
| `botName` | string | `"Butterbase Notetaker"` | Display name the bot uses when it joins the call. 1–64 chars |
| `metadata` | `Record<string,string>` | `{}` | Arbitrary string→string map. Keys may not start with `bb_` (reserved) |
| `automaticLeave` | object | `{}` | Per-bot overrides for the auto-leave timers. Any sub-field you omit inherits the provider default. See [Auto-leave timers](#auto-leave-timers). |

### Auto-leave timers

Tell the bot when to give up and leave on its own. All sub-fields are optional; omitted ones fall back to the provider's default. All values are positive integers in **seconds** (max `86400` = 24h).

| Sub-field | Triggers when… |
|---|---|
| `waitingRoomTimeoutSec` | Bot has been stuck in the waiting room (host hasn't admitted it) for this many seconds. |
| `noOneJoinedTimeoutSec` | Bot is in the call but no participants ever joined within this many seconds. |
| `everyoneLeftTimeoutSec` | All participants have left and this many seconds pass with the room empty. |
| `inCallNotRecordingTimeoutSec` | Bot is in the call but not recording (e.g. recording consent denied) for this many seconds. |

**Example — make the bot leave if not admitted within 15 minutes:**

```json
{ "automaticLeave": { "waitingRoomTimeoutSec": 900 } }
```

Response:

```json
{
  "id": "c086e720-d319-44b8-82d8-3a363f2cd9f4",
  "status": "joining",
  "startedAt": null,
  "completedAt": null,
  "durationSeconds": null,
  "recordingUrl": null,
  "transcriptUrl": null,
  "botName": "Acme Notetaker",
  "metadata": { "session_id": "abc123" }
}
```

`botName` is echoed back so callers can confirm what was sent. Bots created before this field was supported come back with `"Butterbase Notetaker"`.

`startedAt` / `completedAt` / URLs populate as the bot progresses. Poll `GET /v1/{app_id}/ai/meetings/{id}` or rely on webhooks.

## Get a bot

```
GET /v1/{app_id}/ai/meetings/{bot_id}
Authorization: Bearer {token}
```

Returns the same shape as `POST`. The `status` field moves through:

| Status | Meaning |
|---|---|
| `joining` | Bot is dialing in |
| `waiting_room` | Bot is in the waiting room awaiting host admit |
| `in_call` | Bot is in the call (recording may not have started yet) |
| `recording` | Recording in progress |
| `ended` | Call ended; artifacts being finalised |
| `done` | Terminal — call finished cleanly, `recordingUrl` + `transcriptUrl` available |
| `fatal` | Terminal — bot failed to join, was kicked, or had a fatal error |

## List bots

```
GET /v1/{app_id}/ai/meetings?status={status}&limit={n}&cursor={cursor}
Authorization: Bearer {token}
```

Query params (all optional):

| Param | Type | Default | Notes |
|---|---|---|---|
| `status` | string | — | Filter to one lifecycle phase |
| `limit` | integer | 20 | 1–100 |
| `cursor` | string | — | From `nextCursor` in a prior response |

Response:

```json
{
  "bots": [ /* MeetingBot[] */ ],
  "nextCursor": "..." | null
}
```

## Stop a bot

```
DELETE /v1/{app_id}/ai/meetings/{bot_id}
Authorization: Bearer {token}
```

Forces the bot to leave the call. Returns `204` on success. Idempotent — a stopped or already-done bot still returns `204`.

## Cost estimate

```
GET /v1/{app_id}/ai/meetings/_estimate?durationMinutes={n}&transcript={bool}
Authorization: Bearer {token}
```

| Param | Type | Default | Notes |
|---|---|---|---|
| `durationMinutes` | integer | required | 1 – 1440 |
| `transcript` | boolean | `true` | Whether to include transcription cost |

Response:

```json
{ "usd": 0.39 }
```

## Configure forward webhook

```
PUT /v1/{app_id}/ai/meetings/webhook
Authorization: Bearer {token}
Content-Type: application/json

{
  "forward_url": "https://your-app.example.com/recall/events",
  "rotate_secret": true
}
```

| Field | Type | Notes |
|---|---|---|
| `forward_url` | string (URL) | Where Butterbase will POST forwarded events |
| `rotate_secret` | boolean | If true (or no row exists yet), mint a fresh per-app secret |

Response:

```json
{
  "ok": true,
  "app_id": "app_abc123",
  "forward_url": "https://your-app.example.com/recall/events",
  "secret": "wsec_..."
}
```

`secret` is returned **once** — only on initial create and when `rotate_secret: true`. Store it immediately. On subsequent calls without `rotate_secret`, `secret` is `null`. Butterbase stores the value AES-256-GCM-encrypted; the platform decrypts it transiently each time it signs an outbound forward.

### Forwarded event shape

When the bot's status advances or an artifact becomes ready, Butterbase POSTs to your `forward_url`:

```
POST /your/configured/path
content-type: application/json
x-bb-event: bot.done
x-bb-signature: v1,<base64 HMAC-SHA256>

{
  "event": "bot.done",
  "data": {
    "bot":  { "id": "c086e720-...", "metadata": { ... } },
    "data": { "code": "done", "sub_code": null, "updated_at": "..." }
  }
}
```

### Verifying the signature

Recompute `base64(HMAC-SHA256(<your wsec_>, <raw request body>))`, prefix with `v1,`, and compare to `x-bb-signature` in constant time. The full Stripe / GitHub / Recall.ai webhook pattern — see the [worked example](/core-concepts/ai-meetings/#verifying-a-forwarded-event).

### Default subscriptions

Each new app gets these events forwarded by default:

- `bot.in_call_recording`
- `bot.done`
- `bot.fatal`
- `recording.done`
- `transcript.done`
- `transcript.failed`

### Webhook payloads carry IDs, not URLs

`recording.done` and `transcript.done` events deliver only the artifact **id** and metadata. To get a downloadable URL, follow up with `GET /v1/{app_id}/ai/meetings/{bot_id}` and read `recordingUrl` / `transcriptUrl` from the response. URLs are short-lived (Recall re-mints them on demand), which is why they're not baked into the webhook payload.

## Usage

```
GET /v1/{app_id}/ai/meetings/usage
Authorization: Bearer {token}
```

Returns the last 100 rows from `actor_usage_logs`:

```json
{
  "rows": [
    {
      "id": "5",
      "dimension": "recording",
      "seconds": 44,
      "usd_charged": "0.007333",
      "created_at": "2026-06-11T19:18:53.734Z"
    },
    {
      "id": "4",
      "dimension": "transcription",
      "seconds": 44,
      "usd_charged": "0.002200",
      "created_at": "2026-06-11T19:18:53.485Z"
    }
  ]
}
```

One row per dimension (`recording` and, when transcription was enabled, `transcription`) per completed session.

## Availability

```
GET /v1/ai/meetings/_status
```

No auth — public. Returns:

```json
{ "available": true }
```

`false` means the provider isn't registered on this deployment (e.g. an OSS-mode deployment without `MEETINGS_API_KEY` set). Use this to gate UI affordances client-side.

## Errors

OpenAI-shaped: `{ "error": { "message", "type", "code" } }`.

| Status | `error.type` | `error.code` | When |
|---|---|---|---|
| 400 | `invalid_request_error` | `invalid_request` | Request body failed validation. `error.details` has the zod issues. |
| 401 | `authentication_error` | `missing_credentials` | No / invalid Authorization header. |
| 402 | `billing_error` | `insufficient_credits` | AI credits balance can't cover the up-front lease. `error.required_usd` + `error.available_usd` included. |
| 403 | `permission_error` | `not_authorized` | Authenticated user doesn't own this app. |
| 404 | `invalid_request_error` | `app_not_found` | `app_id` doesn't exist. |
| 501 | `api_error` | `provider_unavailable` | Meetings adapter isn't registered on this deployment. |
| 5xx | `api_error` | (varies) | Upstream provider error. Retry with backoff. |
