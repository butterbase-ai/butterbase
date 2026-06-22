---
title: AI Meetings
description: Spawn meeting bots that join Zoom, Google Meet, Microsoft Teams, and Webex calls and return recordings + transcripts.
---

Butterbase includes a meeting bot primitive at `ctx.ai.meetings` (or `bb.ai.meetings` from the SDK). You pass a meeting URL, the platform spawns a bot that joins the call, and you receive recordings + transcripts back when the call ends. Usage is billed against your AI credits allowance just like chat or embeddings.

## When to use it

- Meeting notetakers ("our AI joined the call, here's the recap")
- Sales call transcript ingestion + follow-up generation
- Internal recording of all customer calls
- Any product surface that needs the audio, video, or transcript of a third-party call

## How it works

1. Your code calls `POST /v1/{app_id}/ai/meetings` with the meeting URL. The platform spawns a bot, returns its `id` and `status` immediately, and reserves a small credit lease against your balance.
2. The bot joins the call. Its lifecycle (`joining → waiting_room → in_call → recording → ended → done`) is exposed over webhooks; you can also poll `GET /v1/{app_id}/ai/meetings/{id}`.
3. When the call ends, recording and transcript artifacts become available. The exact charge is computed from real measured duration and settles against your reserved lease — unused portion refunded automatically.
4. Your registered webhook endpoint receives a forwarded event when each artifact is ready. The webhook payload only carries the recording / transcript **id**; to get the download URL, follow up with a `GET` on the bot — `recordingUrl` and `transcriptUrl` are populated there.

## Controlling when the bot gives up

By default, the bot leans on the provider's built-in auto-leave defaults — it'll sit in a waiting room or an empty room for a while before giving up. Pass `automaticLeave` on spawn to override any of those timers per bot. Each sub-field is optional (omitted ones inherit the provider default) and takes a positive number of seconds.

| Sub-field | Triggers when… |
|---|---|
| `waitingRoomTimeoutSec` | The bot has been stuck in the waiting room (host hasn't admitted it) for this many seconds. |
| `noOneJoinedTimeoutSec` | The bot is in the call but no participants ever joined within this many seconds. |
| `everyoneLeftTimeoutSec` | All participants have left and this many seconds pass with the room empty. |
| `inCallNotRecordingTimeoutSec` | The bot is in the call but not recording (e.g. recording consent denied) for this many seconds. |

**Example — leave if not admitted within 15 minutes:**

```ts
await bb.ai.meetings.start({
  meetingUrl,
  automaticLeave: { waitingRoomTimeoutSec: 900 },
});
```

See the [AI Meetings API reference](/api-reference/ai-meetings-api/#auto-leave-timers) for the full HTTP shape.

## Configuring webhooks

For each app, register one forward URL plus a per-app HMAC secret. Butterbase signs every forwarded event with your app's own secret — verification on your side is the standard HMAC-SHA256 pattern, identical to Stripe / GitHub / Recall.ai webhooks.

```bash
curl -X PUT https://api.butterbase.ai/v1/{app_id}/ai/meetings/webhook \
  -H "authorization: Bearer bb_sk_..." \
  -H "content-type: application/json" \
  -d '{
    "forward_url": "https://your-app.example.com/recall/events",
    "rotate_secret": true
  }'
```

Response (only `secret` is sensitive — store it before navigating away, you can't read it again):

```json
{
  "ok": true,
  "app_id": "app_abc123",
  "forward_url": "https://your-app.example.com/recall/events",
  "secret": "wsec_..."
}
```

The default event subscriptions:

- `bot.in_call_recording` — bot joined, recording started
- `bot.done` — bot left, call finished cleanly
- `bot.fatal` — bot terminated with an error
- `recording.done` — recording artifact ready
- `transcript.done` — transcript artifact ready
- `transcript.failed` — transcription failed

## Verifying a forwarded event

```ts
// node or deno function
const expected = 'v1,' + crypto
  .createHmac('sha256', Buffer.from(ctx.env.MEETINGS_WEBHOOK_SECRET, 'utf8'))
  .update(rawBody)
  .digest('base64');

if (!timingSafeEqual(expected, req.headers.get('x-bb-signature'))) {
  return new Response('invalid signature', { status: 401 });
}
```

The secret is the same `wsec_...` Butterbase returned to you at `PUT` time. The platform stores it AES-256-GCM-encrypted; only your app and the platform ever see the plaintext.

## Pricing

Recording: $0.50 / hour. Transcription: $0.15 / hour. Both charged against the AI credits pool documented under [AI Integration](/core-concepts/ai-integration/). Up-front the platform reserves a small lease (a few cents); the unused portion is refunded when the call settles.

Use `GET /v1/{app_id}/ai/meetings/_estimate?durationMinutes=30` to predict cost for any duration.

## Complete worked example

A minimal app that records every meeting URL it receives, stores tracking metadata, and back-fills recording / transcript URLs from webhooks.

### Schema

```json
{
  "tables": {
    "meetings": {
      "columns": {
        "id":             { "type": "uuid", "primaryKey": true, "default": "gen_random_uuid()" },
        "bot_id":         { "type": "text", "nullable": false, "unique": true },
        "meeting_url":    { "type": "text", "nullable": false },
        "status":         { "type": "text", "nullable": false, "default": "'pending'" },
        "last_event":     { "type": "text" },
        "events_count":   { "type": "integer", "nullable": false, "default": "0" },
        "recording_url":  { "type": "text" },
        "transcript_url": { "type": "text" },
        "created_at":     { "type": "timestamptz", "nullable": false, "default": "now()" }
      },
      "indexes": { "meetings_bot_id_idx": { "columns": ["bot_id"], "unique": true } }
    }
  }
}
```

### Spawn function (`POST /fn/spawn-bot`)

```ts
export default async function handler(req: Request, ctx: any): Promise<Response> {
  const { meetingUrl } = await req.json();
  const res = await fetch(
    `${ctx.env.BUTTERBASE_API_URL}/v1/${ctx.env.BUTTERBASE_APP_ID}/ai/meetings`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ctx.env.BUTTERBASE_API_KEY}`,
      },
      body: JSON.stringify({ meetingUrl, transcript: true, recording: 'mp4' }),
    },
  );
  const bot = await res.json();
  if (!res.ok) return new Response(JSON.stringify(bot), { status: 502 });

  await ctx.db.query(
    'INSERT INTO meetings (bot_id, meeting_url, status, last_event) VALUES ($1, $2, $3, $4)',
    [bot.id, meetingUrl, bot.status ?? 'joining', 'spawn'],
  );
  return new Response(JSON.stringify({ bot_id: bot.id, status: bot.status }), {
    headers: { 'content-type': 'application/json' },
  });
}
```

Deploy with `envVars: { BUTTERBASE_API_KEY: 'bb_sk_...' }`.

### Webhook function (`POST /fn/meetings-webhook`)

```ts
function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function hmacBase64(secret: string, body: string) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return btoa(String.fromCharCode(...new Uint8Array(mac)));
}

export default async function handler(req: Request, ctx: any): Promise<Response> {
  const rawBody = await req.text();
  const sig = req.headers.get('x-bb-signature') ?? '';
  const event = req.headers.get('x-bb-event') ?? '';

  // wsec_... from PUT, stored in envVars.MEETINGS_WEBHOOK_SECRET
  const expected = `v1,${await hmacBase64(ctx.env.MEETINGS_WEBHOOK_SECRET, rawBody)}`;
  if (!timingSafeEqual(expected, sig)) return new Response('invalid signature', { status: 401 });

  const payload = JSON.parse(rawBody);
  const botId = payload?.data?.bot?.id;
  if (!botId) return new Response('ok');

  let nextStatus: string | null = null;
  if (event === 'bot.in_call_recording') nextStatus = 'recording';
  else if (event === 'bot.done') nextStatus = 'done';
  else if (event === 'bot.fatal') nextStatus = 'fatal';

  let recordingUrl: string | null = null;
  let transcriptUrl: string | null = null;
  if (event === 'recording.done' || event === 'transcript.done' || event === 'bot.done') {
    const res = await fetch(
      `${ctx.env.BUTTERBASE_API_URL}/v1/${ctx.env.BUTTERBASE_APP_ID}/ai/meetings/${botId}`,
      { headers: { authorization: `Bearer ${ctx.env.BUTTERBASE_API_KEY}` } },
    );
    if (res.ok) {
      const bot = await res.json();
      recordingUrl = bot.recordingUrl ?? null;
      transcriptUrl = bot.transcriptUrl ?? null;
    }
  }

  await ctx.db.query(
    `UPDATE meetings
        SET status = COALESCE($2, status),
            last_event = $3,
            recording_url = COALESCE($4, recording_url),
            transcript_url = COALESCE($5, transcript_url),
            events_count = events_count + 1
      WHERE bot_id = $1`,
    [botId, nextStatus, event, recordingUrl, transcriptUrl],
  );
  return new Response(JSON.stringify({ ok: true }));
}
```

Deploy with `trigger: { type: 'http', config: { method: 'POST', path: '/meetings-webhook', auth: 'none' } }` and `envVars: { MEETINGS_WEBHOOK_SECRET: 'wsec_...', BUTTERBASE_API_KEY: 'bb_sk_...' }`. `auth: 'none'` is correct here — the HMAC inside is what authenticates the caller.

### Drive it

```bash
curl -X POST https://{app_id}.api.butterbase.ai/fn/spawn-bot \
  -H "content-type: application/json" \
  -d '{ "meetingUrl": "https://zoom.us/j/12345..." }'
# → { "bot_id": "...", "status": "joining" }
```

That's it. The bot joins the meeting, events arrive on `meetings-webhook` as the lifecycle advances, and the row is kept current with the latest status plus the recording / transcript URLs.

## Reference

- [AI Meetings API](/api-reference/ai-meetings-api/) — every endpoint, request shape, and response shape
- [TypeScript SDK](/sdks-and-tools/typescript-sdk/) — `bb.ai.meetings.start / get / list / stop / estimateCost`
- [CLI](/sdks-and-tools/cli/) — `bb ai meetings start | get | list | stop | estimate | usage | webhook`
