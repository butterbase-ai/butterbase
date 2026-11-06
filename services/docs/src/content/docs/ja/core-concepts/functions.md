---
title: サーバーレス関数
description: HTTPやcronでTypeScript・JavaScriptの関数を実行し、データベースへアクセスします。
---

独自のバックエンド処理をサーバーレス関数としてデプロイできます。TypeScript・JavaScriptを、データベース、環境変数、ネットワークを利用できる隔離されたDeno環境で実行します。

関数はアプリと同じ[リージョン](/ja/core-concepts/regions/)で動き、データベースとの通信距離を抑えます。

<span id="deploying-a-function"></span>

## 関数のデプロイ

```json
POST /v1/{app_id}/functions
Authorization: Bearer {token}

{
  "name": "hello-world",
  "code": "export default async function handler(req) {\n  return new Response(JSON.stringify({ message: 'Hello!' }), {\n    headers: { 'Content-Type': 'application/json' }\n  });\n}",
  "description": "A simple greeting function",
  "trigger": {
    "type": "http",
    "config": {}
  }
}
```

**必須フィールド：**
- `name`：一意の名前（1〜100文字）。
- `code`：ハンドラーをデフォルトエクスポートするソースコード。

**任意フィールド：**
- `description`：関数の説明。
- `envVars`：環境変数のキーと値。保存時に暗号化します。再デプロイ時はマージし、指定したキーを優先します。省略すると維持します。
- `envVarsReplace`：trueなら環境変数全体を`envVars`へ置換します。既定値はfalse。
- `timeoutMs`：実行時間の上限（既定30000、最大300000ミリ秒）。
- `memoryLimitMb`：メモリの上限（既定128、64〜1024MB）。
- `triggers`：呼び出し方法を指定する配列。単数の`trigger`も受け付け、1要素の配列へ変換します。
- `agent_tool`：trueなら同じアプリの[エージェント](/ja/core-concepts/agents/)からツールとして呼び出せます。

<span id="trigger-types"></span>

## トリガーの種類

`triggers`に指定すると、HTTPと毎日のcronなど、**複数のトリガー**を設定できます。各種類につき1つです。

| 型 | 説明 | 設定 |
|------|-------------|--------|
| `http` | HTTPリクエストで実行 | `{ "method"?, "path"?, "auth"?: "required" \| "optional" \| "none" }` |
| `cron` | 定期的に実行 | `{ "schedule": "*/5 * * * *", "timezone"?: "UTC" }` |
| `s3_upload` | バケットへの保存時に実行 | `{ "bucket": "name", "prefix"?: "uploads/", "contentTypes"?: ["image/*"] }` |
| `webhook` | 署名付きURLから呼び出し | `{ "secret_required"?: true, "allowed_sources"?: "github,stripe" }` |
| `websocket` | リアルタイムのフレーム受信時に実行 | `{}` |

```json
"triggers": [
  { "type": "http", "config": { "auth": "required" } },
  { "type": "cron", "config": { "schedule": "0 9 * * *" } }
]
```

<span id="functions-as-agent-tools"></span>

## エージェントのツールとして使う

`agent_tool: true`で、同じアプリの[エージェント](/ja/core-concepts/agents/)に公開します。`agent_tool_description`をLLMの判断に使い、`agent_tool_mode`を適用します。`read_only`は承認なしで実行し、`read_write`は人の承認を待ちます。

```json
{
  "name": "lookup_account",
  "code": "...",
  "agent_tool": true,
  "agent_tool_description": "Look up a customer by email.",
  "agent_tool_mode": "read_only",
  "agent_tool_exposed_to": "developer_only"
}
```

グラフ仕様の`tools.functions`にも関数名を指定してください。存在しない、または`agent_tool: true`でない関数には、ダッシュボードのエディターが警告します。

<span id="writing-functions"></span>

## 関数の書き方

Requestを受け取り、Responseを返します。

```typescript
export default async function handler(req: Request, ctx: any): Promise<Response> {
  const body = await req.json();

  return new Response(JSON.stringify({ result: 'ok' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}
```

**関数内で使えるもの：**
- 標準Web API（fetch、Request、Response、Headers、URLなど）。
- `ctx.env.VAR_NAME`の環境変数。
- `ctx.db.query(sql)`のデータベース。
- `ctx.user`のユーザー情報。エンドユーザーJWT、または`X-Butterbase-As-User`を指定したサービスキーで設定します。下のサーバー間呼び出しを参照してください。
- `ctx.caller`の呼び出し元情報（種類、キーID、スコープ、引き継いだユーザーID）。
- `ctx.invoke('fn-name', body)`で同じアプリの関数を呼び出し。認証とユーザー情報を自動で引き継ぎます。
- `ctx.app`のアプリ情報と`ctx.request`のリクエスト情報。
- `console.log`、`console.info`、`console.warn`、`console.error`、`console.debug`のログ収集。
- ネットワークへのアクセス。
- `ctx.idempotency.claim(key)`のWebhook重複排除。
- `ctx.waitUntil(promise)`のバックグラウンド処理。

:::note
関数の環境変数は`ctx.env`で取得してください。`Deno.env.get()`では取得できません。
:::

<span id="environment-variables"></span>

## 環境変数

次の順序で`ctx.env`へマージし、後の値を優先します。

1. **アプリ単位**：全関数で共有します。
2. **関数単位**：`deploy_function`の`envVars`や`manage_function.update_env`で設定し、その関数だけで上書きします。
3. **プラットフォーム**：ランタイムの`BUTTERBASE_*`。[コンテキスト](#platform-context)を参照してください。常に優先します。

アプリ単位の値は全関数で利用できます。関数単位の同名キーはその関数だけで優先します。`BUTTERBASE_APP_ID`などのプラットフォームの値は上書きできません。

<span id="app-level"></span>

### アプリ単位

1回設定すると全関数に適用します。

```bash
# Via MCP
manage_app({ action: "update_env", app_id, env: { STRIPE_SECRET: "sk_live_…", SENTRY_DSN: "…" } })

# Via HTTP
PATCH /v1/{appId}/env
{ "envVars": { "STRIPE_SECRET": "sk_live_…", "SENTRY_DSN": "…" } }

# Pass value `null` to delete a key:
{ "envVars": { "SENTRY_DSN": null } }
```

- AES-256-GCMで暗号化して保存します。値は読み出せず、`GET /v1/{appId}/env`は`{ keys, updatedAt }`だけを返します。
- `/^BUTTERBASE_/i`のキーは予約済みで、書き込み時に拒否します。
- 1回の更新で全関数のキャッシュを無効にし、その一覧を返します。各関数の次の実行から適用します。
- ダッシュボードでは**App Settings → Environment variables**。関数の詳細には、継承した値の読み取り専用の一覧と関数単位の編集欄を表示します。

<span id="function-level"></span>

### 関数単位

デプロイ時または後から設定できます。その関数だけで使用します。

```bash
# On deploy
deploy_function({ app_id, name, code, envVars: { API_KEY: "…" } })

# Update without redeploying code
manage_function({ action: "update_env", app_id, function_name, env: { API_KEY: "…", OLD_KEY: null } })
```

- アプリ単位と同じ暗号化、値の非公開、予約済みプレフィックスの制限があります。
- 同名のアプリ単位の値より優先します。

<span id="precedence-in-code"></span>

### コードでの優先順位

```ts
export async function handler(req, ctx) {
  // If STRIPE_SECRET is set at both levels, the function-level value wins.
  const stripe = ctx.env.STRIPE_SECRET;

  // Platform value — always the real app id, even if a user "sets" it at either level (writes are rejected).
  const appId = ctx.env.BUTTERBASE_APP_ID;
}
```

<span id="platform-context"></span>

## プラットフォームのコンテキスト

ランタイムが値を設定するため、自分で環境変数として登録する必要はありません。同じ情報を2つの形式で取得できます。

**フラット形式（`ctx.env.BUTTERBASE_*`）**：特記がなければ常に存在します。

| キー | 値 |
|-----|-------|
| `BUTTERBASE_APP_ID` | アプリID（例：`app_abc123`） |
| `BUTTERBASE_API_URL` | 公開APIのベースURL |
| `BUTTERBASE_APP_NAME` | アプリの表示名 |
| `BUTTERBASE_REGION` | 主リージョン（例：`sjc`） |
| `BUTTERBASE_ANON_KEY` | ブラウザーへ公開できるアプリのanonキー |
| `BUTTERBASE_FRONTEND_URL` | フロントエンドのURL。**未デプロイなら省略**。 |
| `BUTTERBASE_SUBDOMAIN` | プラットフォームのサブドメイン。未設定なら省略。 |
| `BUTTERBASE_STRIPE_ACCOUNT_ID` | 接続したStripeアカウント。課金未設定なら省略。 |
| `BUTTERBASE_AI_DEFAULT_MODEL` | `manage_ai`の既定モデル。未設定なら省略。 |

任意のキーは空文字列ではなく**省略**します。`typeof ctx.env.BUTTERBASE_FRONTEND_URL === "string"`などで確認してください。

**構造化形式（`ctx.app`）**：同じ情報を型付きで取得できます。未設定の任意オブジェクトは`null`です。

```ts
ctx.app = {
  id, name, ownerId, region, subdomain, anonKey, allowedOrigins,
  substrateUserId,                    // substrate user the app is linked to, or null if not linked. ctx.substrate is also null in that case.
  frontend: { url } | null,           // null when no frontend deployed
  auth:     { accessTokenTtl, refreshTokenTtlDays, hookFunction },
  ai:       { defaultModel } | null,  // null when AI config empty
  billing:  { stripeAccountId } | null, // null when billing not connected
}
```

**リクエスト単位（`ctx.request`）**：受信したヘッダーから作成します。

```ts
ctx.request = { id, ip, country, functionName }
```

プラットフォームのキーは関数の環境変数の後に設定するため、`BUTTERBASE_APP_ID`を独自に指定しても実際の値を上書きしません。

<span id="server-to-server-function-calls"></span>

## サーバー間の関数呼び出し

cronで動く関数から、同じアプリの複数の関数を呼び出せます。
例えば`auto-sync-google`から`ingest-gmail`と
`ingest-calendar`を実行する場合に、次の方法を使います。

<span id="calling-a-durable-object-from-a-function"></span>

### 関数からDurable Objectを呼び出す

`ctx.invokeDO(className, instanceKey, body?, opts?)`を使います。
[Durable Objectsのサーバー間呼び出し](../durable-objects#server-to-server-calls-into-durable-objects)を参照してください。


<span id="ctxinvokefn-name-body--the-easy-path"></span>

### `ctx.invoke('fn-name', body)`による呼び出し

同じアプリの関数を、Bearerやキーの環境変数を用意せずに呼び出します。

```typescript
export async function handler(req, ctx) {
  // Identity propagates automatically: if this fn was invoked with an
  // end-user JWT, the callee sees the same ctx.user.id.
  const r = await ctx.invoke('ingest-gmail', { workspace_id: 'ws_abc' });
  const data = await r.json();
  return new Response(JSON.stringify({ enqueued: data.queued }), { status: 200 });
}
```

動作：
- 自動設定されるアプリの内部関数キーで認証します。このキーは
  `ctx.env`には公開しません。
- `ctx.user.id`を引き継ぎ、呼び出し先も同じユーザーを認識します。
- 呼び出し先の`ctx.caller.type`は`loopback`です。
- 循環を防ぐため深さは4までです。5回目の呼び出しで
  `ctx.invoke loop limit exceeded`を同期的に投げます。
- `fetch`と同じ標準の`Response`を返します。

<span id="ctxcaller--who-called-this-function"></span>

### 呼び出し元の`ctx.caller`

すべての実行で設定されます。監査ログやアクセス判断に使えるため、
自分で`req.headers.authorization`を解析する必要はありません。

```ts
ctx.caller = {
  type: 'service_key' | 'end_user_jwt' | 'loopback' | 'anonymous',
  keyId: string | null,  // present iff type === 'service_key'
  scope: string | null,  // first app- or gateway-scope on the key
  userId: string | null, // user this request is acting on behalf of
}
```

| 呼び出し元 | type | userId | keyId |
|--------|------|--------|-------|
| ブラウザーのエンドユーザーJWT | `end_user_jwt` | JWTの`sub` | `null` |
| cron・外部サービスの`bb_sk_*` | `service_key` | `null`（代理呼び出し以外） | APIキーの行ID |
| `ctx.invoke`で同じアプリの関数 | `loopback` | 引き継いだID | `null` |
| Bearerなし・無効 | `anonymous` | `null` | `null` |

<span id="x-butterbase-as-user--when-you-have-to-call-from-outside"></span>

### 外部からの`X-Butterbase-As-User`

ランタイム外のcron、外部サービス、スクリプトなど、
`ctx.invoke`を使えない場合は、アプリに対応する
`bb_sk_*`とともにこのヘッダーを送ります。

```http
POST /v1/app_abc/fn/ingest-gmail
Authorization: Bearer bb_sk_…
X-Butterbase-As-User: 11111111-2222-3333-4444-555555555555
Content-Type: application/json

{ "workspace_id": "ws_abc" }
```

実行前に指定したIDを`ctx.user.id`へ設定します。
関数内でBearerの一致を確認する必要はありません。

**関数ごとの制限。** デプロイ時に
`allow_service_key_impersonation: false`を指定するか、
`manage_function action: "update_settings"`で更新します。
この関数への`X-Butterbase-As-User`はエッジで403になります。
エンドユーザーの代理として実行してはいけない管理者専用や
課金Webhookのハンドラーで使ってください。

<span id="anti-pattern-bearer-equality-checks"></span>

### 避けるべきBearerの一致確認

古いテンプレートでは、リクエストのBearerと
`ctx.env.BUTTERBASE_API_KEY`の一致で、本文の`as_user_id`を
信頼するかを判断していました。

```ts
// ❌ Don't do this — fragile under key rotation, multi-key environments,
//    or cloned apps where every function gets a different key.
const expected = `Bearer ${ctx.env.BUTTERBASE_API_KEY}`;
if (req.headers.get('authorization') === expected) {
  userId = body.as_user_id;
}
```

プラットフォームで認証した`ctx.user.id`、または
Bearerを扱わない`ctx.invoke`へ変更してください。

<span id="rls-in-functions"></span>

## 関数のRLS

呼び出し方法に対応するロールでRLSポリシーを適用します。

| 呼び出し方法 | ロール | RLS |
|-----------|------|-----|
| エンドユーザーJWT | butterbase_user | ユーザー用ポリシーで自分のデータに制限 |
| プラットフォームAPIキー | butterbase_service | サービス用ポリシーで通常は全行を許可 |
| cronトリガー | butterbase_service | サービス用ポリシーで通常は全行を許可 |

<span id="user-scoped-function"></span>

### ユーザー単位の関数

```typescript
export default async function handler(req: Request, ctx: any): Promise<Response> {
  if (!ctx.user) {
    return new Response('Unauthorized', { status: 401 });
  }

  // Automatically filtered to current user's orders (RLS enforced)
  const orders = await ctx.db.query('SELECT * FROM orders');

  return new Response(JSON.stringify(orders.rows), {
    headers: { 'Content-Type': 'application/json' }
  });
}
```

<span id="testing-rls-from-service-functions"></span>

### サービス関数でのRLSテスト

`ctx.db.asUser()`と`ctx.db.asAnon()`で、特定のロールとしてクエリを実行できます。

```typescript
export default async function handler(req: Request, ctx: any): Promise<Response> {
  const userId = 'some-user-uuid';

  // Runs as butterbase_user with RLS enforced
  const userPosts = await ctx.db.asUser(userId, async (db) => {
    const result = await db.query('SELECT * FROM posts');
    return result.rows;
  });

  // Runs as butterbase_anon with RLS enforced
  const publicProducts = await ctx.db.asAnon(async (db) => {
    const result = await db.query('SELECT * FROM products');
    return result.rows;
  });

  return new Response(JSON.stringify({ userPosts, publicProducts }), {
    headers: { 'Content-Type': 'application/json' }
  });
}
```

<span id="using-environment-variables"></span>

## 環境変数の利用

```typescript
// Deploy with: envVars: { "API_KEY": "secret123", "BASE_URL": "https://api.example.com" }

export default async function handler(req: Request, ctx: any): Promise<Response> {
  const apiKey = ctx.env.API_KEY;
  const baseUrl = ctx.env.BASE_URL;

  const response = await fetch(`${baseUrl}/data`, {
    headers: { 'Authorization': `Bearer ${apiKey}` }
  });

  return new Response(await response.text());
}
```

<span id="updating-environment-variables"></span>

### 環境変数の更新

`PATCH /v1/{app_id}/functions/{name}/env`で、再デプロイせずに更新できます。

```json
PATCH /v1/{app_id}/functions/{name}/env
{
  "envVars": {
    "API_KEY": "new-value",
    "OLD_KEY": null
  }
}
```

既存の値へ**マージ**します。全体の置換ではありません。削除するキーは値を`null`にします。

<span id="idempotent-webhook-handlers-with-ctxidempotencyclaim"></span>

## ctx.idempotency.claim()によるWebhookの重複排除

Stripe、Telegram、GitHub、Slack、Twilio、Discordなどは、2xx以外の応答で同じイベントIDを再送します。重複を防がなければ、メール送信や課金などを繰り返す原因になります。

`ctx.idempotency.claim(key)`は不可分な操作で、初回はtrue、再試行はfalseです。重複した配信には処理を繰り返さず応答できます。

```typescript
export default async function handler(req: Request, ctx: any): Promise<Response> {
  const event = await req.json();

  // Returns true the first time, false on every retry of the same event.
  if (!(await ctx.idempotency.claim(event.id, { scope: 'stripe' }))) {
    // Already processed — ack the retry without re-running side effects.
    return new Response('duplicate', { status: 200 });
  }

  await processEvent(event);
  return new Response('ok', { status: 200 });
}
```

**オプション：**

| オプション | 型 | 既定値 | 用途 |
|---|---|---|---|
| `scope` | `string` | `"default"` | プロバイダーごとに名前空間を分けて競合を防ぎます（`stripe`、`telegram`、`github`など）。 |
| `ttlSeconds` | `number` | なし | 有効期限を付け、削除してよいキーを判断できます。 |

**保存と削除。** アプリのデータベースの`_idempotency_keys`に保存します。自動では削除しないため、日次cronなどで整理してください。

```typescript
export default async function handler(_req: Request, ctx: any): Promise<Response> {
  await ctx.db.query("DELETE FROM _idempotency_keys WHERE expires_at < now()");
  return new Response("ok");
}
```

**動作：**
- 呼び出し元に関係なく`butterbase_service`で実行し、サービス用の権限で重複を確認します。
- キーは255文字までです。超えると例外になります。
- `INSERT ... ON CONFLICT DO NOTHING`を使い、同じキーの同時実行でも重複を防ぎます。

<span id="background-work-with-ctxwaituntil"></span>

## ctx.waitUntil()のバックグラウンド処理

`ctx.waitUntil(promise)`で、応答した後も処理を続けられます。呼び出し元へはすぐに応答します。

メール送信、外部ログ、外部APIとの同期など、応答の完了を待たせる必要のない処理に使えます。

```typescript
export default async function handler(req: Request, ctx: any): Promise<Response> {
  const body = await req.json();

  // Schedule background work — continues after response is sent
  ctx.waitUntil(
    fetch("https://api.email.com/v1/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: body.email, subject: "Welcome!" }),
    })
  );

  // You can register multiple waitUntil promises
  ctx.waitUntil(
    ctx.db.query("INSERT INTO activity_log (event) VALUES ($1)", ["user_signup"])
  );

  // Response is returned immediately — background work continues
  return new Response(JSON.stringify({ status: "accepted" }), {
    headers: { "Content-Type": "application/json" }
  });
}
```

**動作：**
- 応答後の制限時間は**30秒**です。それを超える処理は中止します。
- Promise内でも`ctx.db`を使えます。
- 失敗は応答に影響せず、内部で抑制します。
- `Promise.allSettled`と同様に、一部が失敗しても他の登録済み処理を実行します。

<span id="calling-functions-from-your-frontend"></span>

## フロントエンドからの呼び出し

HTTPトリガーの関数は次のURLで利用できます。

```
ANY /v1/{app_id}/fn/{function_name}
```

任意のHTTPメソッドに対応し、エンドユーザーのトークンを関数へ転送します。

```javascript
const response = await fetch(`${API_BASE}/v1/${appId}/fn/hello-world`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${userAccessToken}`
  },
  body: JSON.stringify({ input: 'data' })
});
```

<span id="cron-functions"></span>

## cron関数

標準のcron式を使います。

| 式 | 実行時刻 |
|-----------|----------|
| `* * * * *` | 毎分 |
| `*/5 * * * *` | 5分ごと |
| `0 * * * *` | 毎時 |
| `0 9 * * *` | 毎日9時 |
| `0 0 * * 1` | 毎週月曜日0時 |

<span id="function-metrics"></span>

## 関数の指標

呼び出しの総数、エラー数と率、平均実行時間、最後の実行日時を記録します。

<span id="invocation-logs"></span>

## 呼び出しログ

HTTPメソッドとパス、応答ステータス、実行時間、メモリ、スタックトレース付きのエラー、`console.log/info/warn/error/debug`の`consoleLogs`を収集します。

<span id="reading-logs-for-a-deleted-function-forensics"></span>

### 削除済み関数のログの調査

`manage_function`の`get_logs`は、論理削除した関数に通常404を返します。ログ自体は残っています。調査には`include_deleted=true`を指定してください。

```bash
butterbase functions logs my-fn --include-deleted
```

```typescript
await admin.functions.logs('my-fn', { includeDeleted: true });
```

```http
GET /v1/{app_id}/functions/{name}/logs?include_deleted=true
```

所有者の認証が必要です。調査用のログもアプリの所有者だけが取得できます。

<span id="pausing-an-app-kill-switch"></span>

## アプリの一時停止

`manage_app`の`pause`で、アプリのデータ処理の通信をすべて停止します。Webhookの不具合、cronによる過剰な外部API利用、保守などに使えます。

停止中の動作：
- 関数のHTTP・cron呼び出しは503の`APP_PAUSED`。
- CRUD（`select_rows`、`insert_row`、REST）は503。
- ストレージのアップロード・ダウンロードは503。
- リアルタイムWebSocketは1013（Try again later）で切断。

復旧のため利用できるもの：
- 管理API（アプリ一覧と設定、スキーマ、RLS、環境変数、`pause`自体）。
- 認証（ログイン・登録）。運営者が再認証できるよう維持します。

**MCP：**

```json
{ "app_id": "app_abc123", "paused": true, "reason": "investigating outbound spam" }
```

**CLI：**

```bash
butterbase apps pause app_abc123 --reason "investigating outbound spam"
butterbase apps resume app_abc123
```

**SDK：**

```typescript
await admin.config.pause('investigating outbound spam');
await admin.config.resume();
```

停止状態は`apps`の列に保存し、Control APIの再起動でも維持します。所有者専用で、`app.config.paused`として監査ログに記録します。
