---
title: AI会議
description: Zoom、Google Meet、Teams、Webexへボットを参加させ、録画と文字起こしを取得します。
---

ctx.ai.meetings、またはSDKのbb.ai.meetingsで会議URLを渡すと、ボットが参加し、終了後に録画と文字起こしを返します。チャットや埋め込みと同様にAIクレジットから消費します。

<span id="when-to-use-it"></span>

## 用途

- 会議の記録と要約
- 営業会議の文字起こしとフォローアップ作成
- 顧客会議の社内記録
- 外部会議の音声、動画、文字起こしが必要な機能

<span id="how-it-works"></span>

## 仕組み

1. 会議URLで`POST /v1/{app_id}/ai/meetings`を呼ぶと、ボットを作成してidとstatusを即時返し、残高から少額を仮確保。
2. ボットが参加。joining → waiting_room → in_call → recording → ended → doneをWebhookで通知し、GETでも確認可能。
3. 終了後に録画と文字起こしを作成。実測時間で費用を確定し、仮確保の未使用分を自動返金。
4. 成果物の準備ができると、登録WebhookへIDだけを通知。ボットをGETするとrecordingUrlとtranscriptUrlが入るため、そこから取得。

<span id="controlling-when-the-bot-gives-up"></span>

## 自動退出の時間

既定ではプロバイダーの自動退出設定に従い、待機室や無人の部屋でしばらく待ちます。作成時のautomaticLeaveで個別に変更でき、各項目は任意の正の秒数です。省略項目はプロバイダーの既定値を使います。

| 項目 | 退出する条件 |
|---|---|
| `waitingRoomTimeoutSec` | 入室許可を得られず待機室で指定秒数が経過。 |
| `noOneJoinedTimeoutSec` | 誰も参加しないまま指定秒数が経過。 |
| `everyoneLeftTimeoutSec` | 全員退出し、無人のまま指定秒数が経過。 |
| `inCallNotRecordingTimeoutSec` | 同意拒否などで録画しないまま指定秒数が経過。 |

**例：15分で入室できなければ退出：**

```ts
await bb.ai.meetings.start({
  meetingUrl,
  automaticLeave: { waitingRoomTimeoutSec: 900 },
});
```

HTTPの形は[AI会議API](/ja/api-reference/ai-meetings-api/#auto-leave-timers)を参照してください。

<span id="configuring-webhooks"></span>

## Webhookの設定

アプリごとに転送URLとHMACシークレットを登録します。イベントをそのアプリのキーで署名し、Stripe・GitHub・Recall.aiと同様のHMAC-SHA256で検証します。

```bash
curl -X PUT https://api.butterbase.ai/v1/{app_id}/ai/meetings/webhook \
  -H "authorization: Bearer bb_sk_..." \
  -H "content-type: application/json" \
  -d '{
    "forward_url": "https://your-app.example.com/recall/events",
    "rotate_secret": true
  }'
```

レスポンス（secretだけは機密です。再取得できないため、画面を離れる前に安全に保存してください）：

```json
{
  "ok": true,
  "app_id": "app_abc123",
  "forward_url": "https://your-app.example.com/recall/events",
  "secret": "wsec_..."
}
```

既定のイベント：

- bot.in_call_recording — 参加・録画開始
- bot.done — 正常終了
- bot.fatal — エラー終了
- recording.done — 録画の準備完了
- transcript.done — 文字起こし完了
- transcript.failed — 文字起こし失敗

<span id="verifying-a-forwarded-event"></span>

## 転送イベントを検証

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

PUTで返されたwsec_...を使います。AES-256-GCMで保存し、平文はアプリとプラットフォームだけが扱います。

<span id="pricing"></span>

## 料金

録画は1時間0.50ドル、文字起こしは1時間0.15ドルで、[AI連携](/ja/core-concepts/ai-integration/)のクレジットから消費します。最初に数セント程度を仮確保し、確定時に未使用分を返金します。

`GET /v1/{app_id}/ai/meetings/_estimate?durationMinutes=30`で時間に応じた見積もりを取得します。

<span id="complete-worked-example"></span>

## 完全な実装例

受け取った会議URLを記録し、管理用の情報を保存し、Webhookから録画・文字起こしURLを補う最小アプリです。

<span id="schema"></span>

### スキーマ

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

<span id="spawn-function-post-fnspawn-bot"></span>

### 作成用関数（POST /fn/spawn-bot）

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

`envVars: { BUTTERBASE_API_KEY: 'bb_sk_...' }`で公開します。

<span id="webhook-function-post-fnmeetings-webhook"></span>

### Webhook関数（POST /fn/meetings-webhook）

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

HTTPトリガーでpath: /meetings-webhook、auth: noneを指定し、MEETINGS_WEBHOOK_SECRETとBUTTERBASE_API_KEYを環境変数に設定します。呼び出し元は関数内のHMACで検証するため、auth: noneが適切です。

<span id="drive-it"></span>

### 実行

```bash
curl -X POST https://{app_id}.api.butterbase.ai/fn/spawn-bot \
  -H "content-type: application/json" \
  -d '{ "meetingUrl": "https://zoom.us/j/12345..." }'
# → { "bot_id": "...", "status": "joining" }
```

ボットが参加し、状態が進むとmeetings-webhookへ通知します。行には最新状態と録画・文字起こしURLを保持します。

<span id="reference"></span>

## リファレンス

- [AI会議API](/ja/api-reference/ai-meetings-api/) — 全経路とリクエスト・レスポンス
- [TypeScript SDK](/ja/sdks-and-tools/typescript-sdk/) — bb.ai.meetings.start／get／list／stop／estimateCost
- [CLI](/ja/sdks-and-tools/cli/) — bb ai meetings start／get／list／stop／estimate／usage／webhook
