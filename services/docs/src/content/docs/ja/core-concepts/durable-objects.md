---
title: Durable Objects
description: チャット、対戦ゲーム、AIエージェントなどでキーごとの状態を管理します。
---

Durable Objects（DO）は状態を持つ処理の基盤です。クラスとインスタンスIDで識別する実行単位が、リクエストをまたいでメモリに残り、トランザクション付きストレージへ保存し、WebSocketを保持します。**部屋・ユーザー・エージェントごとの状態**を扱うチャット、対戦、共同編集、ランキング、レート制限、長時間動くAIに適します。

状態の不要な処理には[関数](/ja/core-concepts/functions/)を使います。

<span id="quick-start"></span>

## クイックスタート

1つのクラスをexportするTypeScriptファイルを作成します。

```ts
// chat-room.ts
export class ChatRoom {
  constructor(public state: DurableObjectState, public env: any) {}

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1]);

      // Bootstrap the new client with current state. Without this, late
      // joiners see nothing until the next message arrives.
      const messages: any[] = (await this.state.storage.get('messages')) ?? [];
      pair[1].send(JSON.stringify({ type: 'init', messages }));

      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (req.method === 'POST') {
      const msg = await req.json();
      const messages: any[] = (await this.state.storage.get('messages')) ?? [];
      messages.push(msg);
      await this.state.storage.put('messages', messages.slice(-100));
      this.broadcast(JSON.stringify(msg));
      return Response.json({ ok: true });
    }
    const messages = (await this.state.storage.get('messages')) ?? [];
    return Response.json(messages);
  }

  // The runtime delivers either a string or an ArrayBuffer. Guard before
  // treating the payload as text — JSON.parse on an ArrayBuffer crashes the DO.
  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer) {
    if (typeof msg !== 'string') return;
    this.broadcast(msg);
  }

  broadcast(msg: string) {
    for (const ws of this.state.getWebSockets()) {
      try { ws.send(msg); } catch { /* dead conn */ }
    }
  }
}
```

:::tip[Next.jsと同じリポジトリに置く場合]
DOソースはNext.jsのtsconfig.jsonの対象外にしてください。DurableObjectStateやWebSocketPairなどCloudflareのグローバル型はNext.jsの環境に含まれず、型エラーになります。

```json
{ "exclude": ["node_modules", "durable-objects"] }
```
:::

CLIでデプロイします。

```bash
butterbase do deploy chat-room.ts --name chat-room
```

MCPのdeploy_durable_objectでも公開できます。

<span id="url-pattern"></span>

## URLの形式

公開後は各インスタンスへ次のURLで接続できます。

```
https://<your-subdomain>.butterbase.dev/_do/<name>/<instance-id>
```

同じURLでHTTPとWebSocketアップグレードを受け付けます。/lobby、/general、/team-1など別IDは、状態と接続を完全に分離します。

:::caution[アプリのサブドメインだけで利用]
DOは`<your-subdomain>.butterbase.dev`**だけ**で利用できます。Control APIの`https://api.butterbase.ai/v1/<app_id>/_do/...`は404です。VITE_API_URLやapi_baseから作る場合も、`/_do/<name>/<id>`を付ける前にアプリのサブドメインへ切り替えてください。
:::

```js
// Browser
const ws = new WebSocket('wss://my-app.butterbase.dev/_do/chat-room/lobby');
ws.onmessage = (e) => console.log('msg:', e.data);
ws.send(JSON.stringify({ user: 'alice', text: 'hello' }));
```

<span id="constraints"></span>

## 制約

- **ソースは1ファイル。** npm importは不可で、cloudflare:workersだけを利用。
- **クラスは1つ。** exportが必要。ファイル名が既定URL名で、--nameで変更可能。
- **v1ではアプリごとに最大5クラス。**
- **全クラスのバンドル合計は圧縮後10 MBまで。**
- **組み込みストレージ。** state.storageを使用。DO状態をPostgresへ置くと、同じ場所で処理する利点を失います。
- **サービスバインディングは未対応。** 関数とSSR WorkerからはHTTPで接続。今後対応予定。

<span id="access-modes"></span>

## アクセスモード

公開時に指定します。

- public — 誰でも呼び出し可能。
- authenticated（既定）— Authorization: Bearer ...によるユーザーJWTを要求。
- service_key — Authorization: Bearer bb_sk_...によるサービスキーを要求。

:::caution
**v1の制限：** DO WorkerはAuthorizationの**形式**（Bearer bb_sk_で始まるかなど）だけを確認します。キーの有効性、失効、対象アプリを検証しません。WfP手前のディスパッチャーは公開通信を受けますが、/_do/*に細かな認証は適用しません。

厳密な認証が必要な場合は、DOのfetch内でトークンを検証してください。方法は2つあります。

- **APIで確認：** `GET https://api.butterbase.ai/auth/<app_id>/me`へユーザートークンを渡す。200で有効性とユーザーを確認。
- **署名を検証：** アプリのJWKS（5分キャッシュ）を取得し、Web CryptoでJWT署名を検証。

ディスパッチャーでの認証強化はv2の計画に含まれます。
:::

:::caution[ブラウザのWebSocket認証]
**ブラウザWebSocketではaccess_mode: authenticatedを使えません。** カスタムヘッダーを設定できず、ディスパッチャーはAuthorizationだけを読みます。URLのtokenやSec-WebSocket-Protocolは無視するため、401になりfetchへ到達しません。

> tokenクエリを受け付ける/realtimeとは異なります。DO手前のWfPディスパッチャーは簡単な転送処理です。

**ブラウザ向けDOの方法：** publicを指定し、fetch内でtokenクエリかSec-WebSocket-Protocolを読み、自分で検証します。ディスパッチャーを通ればハンドラーで読めます。

```ts
async fetch(req: Request): Promise<Response> {
  if (req.headers.get('Upgrade') === 'websocket') {
    const token = new URL(req.url).searchParams.get('token');
    if (!token || !(await verifyToken(token, this.env))) {
      return new Response('unauthorized', { status: 401 });
    }
    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  // ... non-WS branches can still require Authorization header
}
```

`verifyToken`では、`Authorization: Bearer <token>`を付けて`GET https://api.butterbase.ai/auth/<app_id>/me`を呼ぶか、JWKSで署名検証します。関数や自分のサーバーからはAuthorizationを指定できるため、authenticatedやservice_keyを使えます。この制約はブラウザWebSocketに限ります。
:::

<span id="environment-variables"></span>

## 環境変数

env.KEYでアプリ共通の設定を読みます。DO名前空間のバインディングと併存し、CLIで管理できます。

```bash
butterbase do env set APP_ID app_abc123
butterbase do env set API_BASE_URL https://api.example.com
butterbase do env list
butterbase do env unset OLD_KEY
```

- キーは`^[A-Z_][A-Z0-9_]*$`（UPPER_SNAKE）。
- 稼働中クラスがあれば、設定・削除でWorkerを再公開して即時反映。
- 値は書き込み専用で、listはキー名だけを返す。
- 同じWorkerを共有するアプリ内の**全クラス**から見える。
- クラス名のUPPER_SNAKEバインディング（chat-roomならCHAT_ROOM）との衝突は不可。明示的なエラーで失敗。

```ts
export class ChatRoom {
  constructor(public state: DurableObjectState, public env: { APP_ID: string; API_BASE_URL: string }) {}

  async authorize(token: string) {
    const res = await fetch(`${this.env.API_BASE_URL}/auth/${this.env.APP_ID}/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.ok;
  }
}
```

<span id="lifecycle"></span>

## ライフサイクル

- **追加・更新：** `butterbase do deploy file.ts --name X`で全DOを再バンドルして公開。メモリ上の既存インスタンスは破棄し、次のリクエストで新コードを読み込み。
- **削除：** `butterbase do delete X`で全インスタンスと保存データを即時削除。**取り消せません。**
- **アプリ削除：** 全クラスとインスタンスを削除。
- **名前変更：** 未対応。新しい名前で登録し、データを移して旧名を削除。

<span id="server-to-server-calls-into-durable-objects"></span>

## サーバーからDOを呼ぶ

同じアプリの関数や別DOから、プラットフォームが管理する経路で
直接呼び出せます。Bearerや公開URLを自分で
組み立てる必要はありません。

<span id="from-a-function"></span>

### 関数から

    // Inside a function
    export default async (req, ctx) => {
      const res = await ctx.invokeDO('support-ticket-do', 'ticket-42', {
        cmd: 'handleFollowup',
        note: 'customer replied',
      });
      return new Response(await res.text());
    };

`ctx.invokeDO(className, instanceKey, body?, opts?)`：
- className — 登録したクラス名（support-ticket-doなど）
- instanceKey — idFromNameと同じインスタンス識別子
- body — 自動でJSON文字列にする本文
- 標準のResponseを返す

<span id="from-another-do"></span>

### 別DOから

DOでctxを使うには補助関数を呼びます。バンドラーがbutterbaseを追加するため、fetchの先頭で`butterbase.ctx(req, env, state)`を呼んでください。

    export class SupportTicketDo {
      constructor(state, env) { this.state = state; this.env = env; }

      async fetch(req) {
        const ctx = butterbase.ctx(req, this.env, this.state);

        // Call another DO in the same app
        const audit = await ctx.invokeDO('audit-log-do', 'app_events', { evt: 'closed' });
        // Call a function in the same app
        const notif = await ctx.invoke('send-slack', { text: 'ticket closed' });
        // App-level env (platform BUTTERBASE_* + app_env_vars — scrubbed of platform-only keys)
        const stripeKey = ctx.env.STRIPE_SECRET;
        return new Response('ok');
      }
    }

既存コードはbutterbase.ctxを呼ばなくても、そのまま動きます。

<span id="whats-not-in-ctxenv"></span>

### ctx.envに含めないキー

ユーザーコードが直接読むべきでないプラットフォーム専用キーを
ctx.envでは隠します。

- DO_INVOKER_URL／DO_INVOKER_TOKEN — 転送処理用のBearer。
  自分で接続せずctx.invokeDOを利用。
- BUTTERBASE_INTERNAL_FN_KEY — 関数呼び出し用のBearer。
  独自ヘッダーを作らずctx.invokeを利用。

他のBUTTERBASE_*値、アプリのapp_env_vars、DO固有の環境変数は
関数と同様にctx.envから参照できます。
クラス内のthis.env自体は変わらず参照できるため、
必要なら元のオブジェクトを使えます。ただし報告やログへ
シークレットを出力しないでください。除外するのは
butterbase.ctxが返すオブジェクトだけです。

<span id="who-called-me"></span>

### 呼び出し元を知る

サーバー間の呼び出しでは次を参照できます。
- ctx.request.caller — fn:widget-ingestやdo:support-ticket-do:ticket-42
- ctx.user?.id — 呼び出しチェーンの代理ユーザーID（存在する場合）
- ctx.request.loopDepth — 呼び出しの深さ（最大4）

公開HTTPは従来どおり、ブラウザや外部サービスが
`{subdomain}.butterbase.dev/_do/…`へ接続します。
DOのaccess_modeと訪問者トークンの検証が適用され、
この経路のctx.request.callerはnullです。

<span id="usage-and-billing"></span>

## 使用量と課金

Cloudflareのリクエスト数とCPU時間を、15分ごとのcronでButterbaseのメーターへ取り込みます。

- do_requests — HTTPとWebSocketの合計呼び出し
- do_cpu_ms — CPU時間（ミリ秒）

ストレージのGB・秒はv2で対応予定です。

v1では計測だけで制限は適用しません。`butterbase do usage <name>`かget_do_usageで確認します。現在はアプリ内の全クラス合計で、クラス別内訳はv2の計画です。

<span id="when-not-to-use-a-do"></span>

## DO以外が適する用途

- **状態不要のAPI：** [関数](/ja/core-concepts/functions/)。
- **静的フロントエンド：** [デプロイ](/ja/core-concepts/frontend-deployment/)。
- **サーバー描画のNext.js：** [エッジSSR](/ja/core-concepts/edge-ssr-deployment/)。
- **キーをまたぐDB検索：** Postgresと[自動API](/ja/core-concepts/database/)。
- **DB変更の配信：** [リアルタイム](/ja/core-concepts/realtime/)。

<span id="troubleshooting"></span>

## 問題の対処

**Source must export exactly one class** — export class Xだけを定義します。追加のinterface、関数、exportは不可。

**Import X is not allowed** — cloudflare:*だけをimportできます。v1はnpmをバンドルしません。

**Too many DO classes for one app** — v1の上限は5です。不要なものを削除してください。

**WebSocketがすぐ切れる** — アクセスモードを確認します。authenticatedはBearerがないアップグレードを拒否します。

**ストレージ制限** — Cloudflare DOのインスタンス容量は事実上無制限ですが、1キー・値は128 KBまでです。大きなデータは[ストレージ](/ja/core-concepts/storage/)を使います。
