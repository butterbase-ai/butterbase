---
title: Substrate
description: AIエージェントの記憶とアクションをユーザー単位で共有し、台帳とルールで管理します。
---

Substrateは、AIエージェントの永続的な記憶と外部への操作を、ユーザー単位の台帳でまとめて管理する層です。各アプリのエンティティ、決定、提案を同じ場所へ記録し、確認・制御できます。

[関数](/ja/core-concepts/functions/)内の`ctx.substrate`、CLIの[`butterbase substrate`](/ja/cli/substrate/)、Substrate用キーによるHTTPから利用できます。

<span id="what-you-get"></span>

## 主な機能

| 概念 | 内容 |
|---|---|
| **エンティティ** | 人物、企業、プロジェクト、エージェントなどの永続的な対象。 |
| **アクション台帳** | 提案者、ポリシーの判断、実行結果。 |
| **決定・約束・学び・原則** | 後から検索できる長期の記憶。 |
| **元資料** | 会議、メール、録音、文書などの全文検索可能な資料。決定・約束・学びの根拠を参照できます。 |
| **注意ルール** | スナップショットを定期評価し、条件に一致すると提案するルール。 |
| **Outboxの送信先** | 実行時のHMAC署名付きWebhook。 |
| **設定** | `yolo_mode`の自動承認など、ユーザー単位の設定。 |
| **WebSocketストリーム** | エンティティ、台帳、記憶、ルール、発火の変更をリアルタイム配信。 |

<span id="how-agents-use-it"></span>

## エージェントからの利用

Substrateのユーザーに紐付けたアプリの関数では、`ctx`に`substrate`を追加します。

```typescript
export async function handler(req, ctx) {
  // Propose an action. The substrate's policy engine decides whether it
  // executes immediately, queues for approval, or is rejected.
  const verdict = await ctx.substrate.propose('record_decision', {
    title: 'Migrate billing to Stripe',
    kind: 'strategic',
    rationale: 'Vendor consolidation; lower switching cost than custom.',
  });

  // Search prior memory.
  const prior = await ctx.substrate.searchMemory('billing', { kinds: ['decisions'], limit: 5 });

  // Look up an entity.
  const people = await ctx.substrate.findEntities({ type: 'person', limit: 10 });

  return Response.json({ verdict, prior, people });
}
```

使える呼び出し：

| 呼び出し | 用途 |
|---|---|
| `propose(capability, payload, opts?)` | 提案。応答：`{ action_id, verdict, requires_approval, result? }`。 |
| `getEntity(entity_id)` | エンティティを1件取得 |
| `findEntities({ type?, q?, limit? })` | 一覧・検索 |
| `searchMemory(query, { kinds?, limit? })` | 決定、約束、学び、元資料の全文検索 |

<span id="capabilities-at-a-glance"></span>

### 機能の一覧

提案は即座に実行するか、`proposed`で所有者の承認を待ちます。表の既定ポリシーが初期の動作です。所有者は1回の呼び出しに`dangerously_skip_approval: true`を指定できますが、エージェントは指定できません。

**`record_decision`は自動承認ですが、`record_principle`、`supersede_decision`、`retire_principle`は既定で人の承認が必要です。** ポリシーの判断に影響する情報を変更するためです。

| 機能 | 既定ポリシー | 取り消し可能 | 制限あり | 補足 |
|---|---|---|---|---|
| `record_decision` | auto | はい | いいえ | 決定を記録 |
| `record_commitment` | auto | はい | いいえ | 約束を記録。任意の`source_artifact_id`。 |
| `record_learning` | auto | はい | いいえ | 振り返りの学びを記録 |
| `upsert_entity` | auto | はい | いいえ | 作成・更新。id、canonical_keys、primary_emailの順で重複を確認。 |
| `update_entity` | auto | はい | いいえ | 旧形式。`attrs`全体を置換。`patch_entity`を優先してください。 |
| `patch_entity` | auto | はい | いいえ | RFC 7396による`attrs`の部分更新。`if_updated_at`の楽観ロックに対応。 |
| `upsert_source_artifact` | auto | はい | いいえ | 元資料の作成・更新。`(external_system, external_id)`で冪等。 |
| `revert_action` | auto | いいえ | いいえ | 取り消し可能なアクションを1件取り消す |
| `record_principle` | approval_required | いいえ | いいえ | ポリシーで使う原則を記録。人の承認が必要。 |
| `supersede_decision` | approval_required | いいえ | いいえ | 以前の決定を置き換える。人の承認が必要。 |
| `retire_principle` | approval_required | いいえ | いいえ | 原則を`status=expired`にする。人の承認が必要。 |
| `delete_entity` | approval_required | いいえ | いいえ | 完全削除。取り消せません。 |
| `merge_entities` | approval_required | いいえ | いいえ | 別名を残して重複を統合。取り消せません。 |
| `bulk_revert_actions` | approval_required | いいえ | いいえ | 最大200件を一括取り消し。個別の失敗は応答に含めます。 |
| `send_email_draft` | approval_required | いいえ | いいえ | メールの下書きを操作として記録。エージェントの提案には常に承認が必要。 |

アプリの関数からの提案は`kind: 'agent'`です。[yoloモード](#yolo-mode)が有効でも、外部への操作の一部には人の承認が必要です。

<span id="entity-primitives"></span>

## エンティティの基本操作

<span id="upsert-upsert_entity"></span>

### 作成または更新（`upsert_entity`）

重複を探す順序：**`id` > `canonical_keys` > `primary_email` > 新規作成**。

- `id`があればIDで作成・更新します（従来の動作）。
- 空でない`canonical_keys`があれば、同じ種類で指定したすべてのキーと値を含む行を探します（JSONBの`@>`）。一致すれば更新し、`was_insert: false`を返します。
- `primary_email`があれば`(type, lower(primary_email))`で探します。一致すれば更新し、新規作成なら`canonical_keys.email`へ自動で反映して両方の方法で重複を探せるようにします。

メールは部分一意インデックスで競合を防ぎます。`canonical_keys`だけでは同時書き込みが競合する場合があるため、`merge_entities`で整理してください。

<span id="patch-patch_entity"></span>

### 部分更新（`patch_entity`）

`attrs`へRFC 7396のJSON Merge Patchを不可分な操作で適用します。

```ts
await ctx.substrate.patchEntity('ent_…', { title: 'CTO', previous_title: null });
// title set to 'CTO', previous_title key deleted, all other attrs untouched.
```

`if_updated_at`を指定すると、競合時に上書きせずエラーを返す楽観ロックを使えます。

部分更新には`patch_entity`を使ってください。旧`update_entity`は`attrs`全体を置き換える互換用の操作です。

<span id="merge-merge_entities"></span>

### 統合（`merge_entities`）

重複したエンティティを残す側へ統合します。

```ts
await ctx.substrate.mergeEntities('ent_loser', 'ent_winner', 'duplicate by email');
```

動作：
- **削除する側**を`substrate.entities`から完全に削除します。
- `substrate.entity_aliases`へ`loser_id → winner_id`の別名を登録します。
- **外部キーは自動で書き換えません。** 他のエンティティの`attrs.company_id = 'ent_loser'`などは維持されるため、読み取り時に`entity_aliases`で古いIDを解決してください。

  ```sql
  SELECT COALESCE(a.canonical_id, $1) AS resolved_id
  FROM (VALUES ($1)) t(id)
  LEFT JOIN substrate.entity_aliases a ON a.alias_id = $1;
  ```

- 統合ごとに1つの台帳アクションを作ります。`reversible: false`で、自動では元に戻せません。

<span id="delete-delete_entity"></span>

### 削除（`delete_entity`）

完全削除で、取り消せません。既定で承認が必要です。

```ts
await ctx.substrate.deleteEntity('ent_…', 'manual cleanup');
```

重複の整理には、別名を維持する`merge_entities`を優先してください。不要で参照を残す必要がない場合だけ`delete_entity`を使います。

論理削除には`ctx.substrate.patchEntity(id, { deleted_at: new Date().toISOString() })`を使い、読み取りで除外します。

<span id="idempotent-proposals"></span>

### 提案の重複排除

`propose`の第3引数、または`POST /v1/me/substrate/actions/propose`の本文に`idempotency_key`を指定すると、通信障害、Lambdaの再実行、Webhookの再送でも二重登録しません。

```ts
await ctx.substrate.propose('record_decision', payload, {
  idempotency_key: 'mtg_2026-06-16:record_decision',
});
```

キーはユーザーごとで、TTLなしで保持します。処理単位で固定の値（会議IDと機能の組み合わせなど）を使い、呼び出しごとのUUIDは避けてください。同じキーなら以前のアクションと現在の状態を返し、`"replay": true`を含めます。

<span id="bulk-revert-bulk_revert_actions"></span>

### 一括取り消し（`bulk_revert_actions`）

最大200件を1回で取り消します。一部の失敗は例外ではなく応答に含めます。誤った取り込みが多数のアクションを生成した場合などに使います。

```ts
await ctx.substrate.propose('bulk_revert_actions', {
  action_ids: ['act_…', 'act_…', /* … */],
  reason: 'rolling back failed ingest run 2026-06-11',
});
```

<span id="authentication"></span>

## 認証

接続方法は3つあります。

1. **Substrate用APIキー**（`bb_sub_*`）：CLI、SDK、自動処理用。`butterbase keys generate --substrate`で発行します。
2. **Cognitoセッション**：Webのダッシュボードで自動的に扱います。
3. **デプロイ済みの関数内**：紐付けたアプリの`ctx.substrate`を自動で設定し、トークンの管理は不要です。

<span id="yolo-mode"></span>

## yoloモード

通常はポリシーを評価し、必要なら承認を待ちます。`yolo_mode`で、人からの提案を自動承認できます。

```bash
butterbase substrate settings yolo on
```

`ctx.substrate`のエージェントによる外部への操作には、yoloモードの自動承認は適用しません。

<span id="the-dashboard"></span>

## ダッシュボード

`/substrate`で台帳、エンティティ、メモリー、注意ルール、承認待ちを確認できます。CLIの操作はブラウザーからも行えます。

<span id="walkthrough--your-first-substrate-aware-agent"></span>

## 手順：Substrateを使う最初のエージェント

決定を提案する関数、定期的に条件を確認する注意ルール、実行時のWebhookを作ります。所要時間の目安は10分です。

<span id="1-provision-your-substrate"></span>

### 1. Substrateの準備

初回利用時に作成します。ダッシュボードのOpen Substrate、またはCLIで開始します。

```bash
butterbase substrate settings show
```

`{"yolo_mode": false, ...}`なら準備済みです。`not provisioned`なら、表示される解決方法に従ってください。

<span id="2-generate-a-substrate-scoped-key"></span>

### 2. Substrate用キーの発行

```bash
butterbase keys generate --substrate --name "my-laptop"
# → bb_sub_…  (shown once — store it now)
export BUTTERBASE_API_KEY="bb_sub_..."
```

自分のSubstrateに紐付きます。アプリのデータベースを読み書きする権限はありません。

<span id="3-propose-your-first-action-from-the-cli"></span>

### 3. CLIで最初の提案

```bash
butterbase substrate propose record_decision \
  --payload '{"title":"Adopt substrate","kind":"strategic","rationale":"agent memory needs a single source of truth"}'
```

応答：

```json
{
  "action_id": "act_01...",
  "verdict": { "result": "auto_approved", "reason": "capability default = auto" },
  "requires_approval": false,
  "result": { "decision_id": "dec_01..." }
}
```

`substrate.decisions`へ保存したことを確認します。

```bash
butterbase substrate memory "adopt substrate" --kinds decisions
```

<span id="4-link-an-app-to-substrate"></span>

### 4. アプリとの紐付け

明示的に紐付けたアプリの関数だけに`ctx.substrate`を設定します。ダッシュボードのLink to substrate、またはSDK・CLIで設定してください。

<span id="5-deploy-a-function-that-uses-ctxsubstrate"></span>

### 5. `ctx.substrate`を使う関数のデプロイ

```typescript
// fn-summarize-week.ts
export async function handler(req, ctx) {
  const lastWeekDecisions = await ctx.substrate.searchMemory('', { kinds: ['decisions'], limit: 20 });

  const verdict = await ctx.substrate.propose('record_decision', {
    title: 'Weekly summary',
    kind: 'operational',
    rationale: `Reviewed ${lastWeekDecisions.length} decisions this week.`,
  });

  return Response.json({ verdict, count: lastWeekDecisions.length });
}
```

`butterbase fn deploy`またはMCPの`deploy_function`でデプロイします。1回実行すると、台帳に`kind: 'agent'`とアプリの`source_app_id`を記録します。

<span id="6-add-an-attention-rule"></span>

### 6. 注意ルールの追加

日次スナップショットへ[JSON-Logic](https://jsonlogic.com/)を適用し、一致するとテンプレートから提案します。

```json
{
  "name": "weekly digest",
  "trigger_cron": "0 9 * * 1",
  "condition_mode": "snapshot_predicate",
  "condition": { ">": [ { "var": "entity_count" }, 0 ] },
  "action_capability": "send_email_draft",
  "action_payload_template": {
    "to": "you@example.com",
    "subject": "Weekly digest",
    "body": "{{entity_count}} entities tracked this week."
  }
}
```

保存して作成します。

```bash
butterbase substrate rules create --file rule.json
```

定期実行せずに、今日の結果をプレビューできます。

```bash
butterbase substrate rules preview --file rule.json
```

<span id="7-send-execution-events-to-a-webhook"></span>

### 7. Webhookへの実行イベントの送信

`send_email_draft`などの機能が承認され実行されると、自分のエンドポイントへPOSTできます。

```bash
butterbase substrate outbox put send_email_draft \
  --webhook-url https://example.com/hooks/substrate \
  --signing-secret "$(openssl rand -hex 16)"
```

指定したシークレットで`X-Butterbase-Signature: sha256=…`を付けます。再試行と失敗後の待機列を自動で処理します。

<span id="8-stream-live-updates-to-a-ui"></span>

### 8. UIへのリアルタイム配信

書き込みの変更をWebSocketで配信します。フレームは本文を含まない`{ org, op, tbl, id }`です。IDで行を再取得してください。[リアルタイム](/ja/core-concepts/realtime/)と同じ方式です。

対象は`entities`、`action_ledger`、`decisions`、`commitments`、`learnings`、`attention_rules`、`attention_rule_firings`です。組織単位で、認証情報に紐付いた組織の変更だけを受信します。

クライアントの認証情報に応じて3つの方法があります。

**a）Substrateキーを持つサーバー・スクリプト。** SDKの`bb.substrate.stream`がWebSocket、間隔を延ばした再接続、helloフレームの除外を処理します。

```typescript
import { createClient } from '@butterbase/sdk';
const bb = createClient({ apiUrl: 'https://api.butterbase.ai', /* … */ });

const sub = bb.substrate.stream({
  token: process.env.BUTTERBASE_SUBSTRATE_KEY, // bb_sub_… or bb_sk_…
  onChange: (evt) => {
    // evt = { org, op: 'insert' | 'update' | 'delete', tbl, id }
    if (evt.tbl === 'entities') refetchEntity(evt.id);
  },
  onStatus: (s) => console.log('substrate stream', s), // 'connecting' | 'open' | 'closed'
});

// later
sub.unsubscribe();
```

**b）Substrateキーを持たないエンドユーザーのブラウザー。** キーをブラウザーへ渡さず、アプリの関数で**1回限りのチケット**を発行してください。関数内：

```typescript
// app function: substrate-proxy
export async function handler(req, ctx) {
  const { op } = await req.json();
  if (op === 'ws_ticket') {
    return Response.json(await ctx.substrate.wsTicket()); // { ticket, expires_in }
  }
  // … other ops
}
```

ブラウザー内：

```typescript
// 1. Ask your function for a 60s single-use ticket.
const { ticket } = await bb.functions.invoke('substrate-proxy', { op: 'ws_ticket' });

// 2. Open the stream, then re-fetch on each change.
const ws = new WebSocket(`wss://api.butterbase.ai/v1/me/substrate/stream?ticket=${ticket}`);
ws.onmessage = (evt) => {
  const change = JSON.parse(evt.data);
  if (change.type === 'hello') return;
  // change = { org, op, tbl, id } — e.g. invalidate your query cache by id
};
```

**c）Cognitoセッションのあるダッシュボード。** 関数を経由せず、直接チケットを発行できます。

```typescript
const { ticket } = await fetch('/v1/me/substrate/ws-ticket', {
  method: 'POST',
  credentials: 'include',
}).then(r => r.json());
const ws = new WebSocket(`wss://api.butterbase.ai/v1/me/substrate/stream?ticket=${ticket}`);
```

接続時に`{ type: 'hello' }`、その後は変更ごとのフレームを送ります。**チケットは1回限りで60秒で失効**します。再接続のたびに発行し、再試行の間隔を延ばしてください。SDKの`bb.substrate.stream`では自動で行います。

<span id="see-also"></span>

## 関連ページ

- [CLI：`butterbase substrate`](/ja/cli/substrate/)：シェルからの管理コマンド。
- [Substrate API](/ja/api-reference/substrate-api/)：HTTPのパスと本文・応答。
- [関数](/ja/core-concepts/functions/)：`ctx.substrate`の利用。
- [リアルタイム](/ja/core-concepts/realtime/)：アプリ全般のリアルタイム機能。Substrateのストリームと併用できます。
