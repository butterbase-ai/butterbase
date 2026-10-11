---
title: Substrate API
description: Butterbase SubstrateのHTTP APIを説明します。
sidebar:
  order: 9
---

Substrate APIはユーザー単位です。Bearerトークンで識別した呼び出し元自身のSubstrateに対して操作します。パスに`{app_id}`は含みません。

<span id="authentication"></span>

## 認証

すべてのエンドポイントで、次のいずれかを使います。

- **Substrate用APIキー**：`Authorization: Bearer bb_sub_…`（`butterbase keys generate --substrate`で発行）。
- **プラットフォームJWT**（ダッシュボード・Cognitoのセッション）。

Substrate用ではないAPIキー（`bb_sk_…`）には403を返します。

エラーは標準の形式です。

```json
{ "error": { "code": "AUTH_INVALID_TOKEN", "message": "…", "remediation": "…" } }
```

<span id="settings"></span>

## 設定

| メソッド | パス | 用途 |
|--------|------|---------|
| GET | /v1/me/substrate/settings | yoloモードなどのユーザー設定を取得 |
| PUT | /v1/me/substrate/settings/yolo | yoloモードを切り替える |

```json
PUT /v1/me/substrate/settings/yolo
{ "yolo_mode": true }
```

<span id="actions"></span>

## アクション

| メソッド | パス | 用途 |
|--------|------|---------|
| POST | /v1/me/substrate/actions/propose | アクションを提案 |
| GET | /v1/me/substrate/actions | 台帳のアクション一覧を取得 |
| GET | /v1/me/substrate/actions/\{action_id} | アクションを1件取得 |
| POST | /v1/me/substrate/actions/\{action_id}/approve | 承認待ちのアクションを承認 |
| POST | /v1/me/substrate/actions/\{action_id}/reject | 承認待ちのアクションを拒否 |

<span id="propose"></span>

### 提案

```json
POST /v1/me/substrate/actions/propose
{
  "capability": "record_decision",
  "payload": { "title": "…", "kind": "operational", "rationale": "…" },
  "idempotency_key": "optional-stable-string"
}
```

応答：

```json
{
  "action_id": "act_01…",
  "verdict": { "result": "auto_approved", "reason": "capability default = auto" },
  "requires_approval": false,
  "result": { "decision_id": "dec_01…" }
}
```

判断の値：`auto_approved`、`auto_approved_yolo`、`requires_approval`、`rejected`。

<span id="idempotency_key--deduplicating-retries"></span>

#### `idempotency_key`：再試行の重複排除

本文の`idempotency_key`は任意の文字列です。指定すると、通信の中断やLambdaの再実行があっても、同じ処理を台帳へ重複登録しません。

- **範囲：** Substrateのユーザーごと。別のユーザーは同じキーを使っても競合しません。
- **期間：** 無期限。キーは削除しません。重複を防ぐ処理単位で変わらない値（例：`meeting_id + ":" + capability`）を選んでください。呼び出しごとのUUIDは適しません。
- **競合時：** 同じ`(substrate_user_id, idempotency_key)`のアクションがあれば、その判断と結果を返し、機能を再実行しません。
- **再取得の応答：** 元と同じ`action_id`、判断（再取得の`conflicts`は常に空）、結果を返します。ただし**現在の**状態を反映するため、後から承認された場合は`requires_approval`が`false`です。新規の提案と区別できるよう、トップレベルに`"replay": true`を追加します。

例：同じキーを2回送信する場合：

```json
// First call — fresh propose
POST /v1/me/substrate/actions/propose
{
  "capability": "record_decision",
  "payload": { "title": "Migrate billing to Stripe", "kind": "strategic" },
  "idempotency_key": "mtg_2026-06-16:record_decision"
}
// → { "action_id": "act_01…", "verdict": { … }, "requires_approval": false, "result": { … } }

// Second call — same key, same user
POST /v1/me/substrate/actions/propose
{ …same body… }
// → { "action_id": "act_01…", "verdict": { … }, "requires_approval": false, "result": { … }, "replay": true }
```

機能ごとの本文は[機能の本文](#capability-payloads)を参照してください。

<span id="list"></span>

### 一覧

```
GET /v1/me/substrate/actions?status=executed&capability=send_email_draft&limit=25&before=2026-05-28T00:00:00Z
```

| クエリパラメーター | 型 | 既定値 |
|---|---|---|
| `status` | `proposed` \| `executed` \| `rejected` | _すべて_ |
| `capability` | string | _すべて_ |
| `limit` | int（1〜500） | 100 |
| `before` | ISO形式の日時 | _現在_ |
| `source_app_id` | string | _すべて_ |
| `source_rule_id` | string | _すべて_ |

<span id="approve--reject"></span>

### 承認と拒否

```
POST /v1/me/substrate/actions/{action_id}/approve
POST /v1/me/substrate/actions/{action_id}/reject
{ "reason": "policy mismatch" }
```

いずれも更新したアクションの行を返します。`proposed`以外の状態では`409 wrong_status`を返します。

<span id="entities"></span>

## エンティティ

| メソッド | パス | 用途 |
|--------|------|---------|
| GET | /v1/me/substrate/entities | エンティティ一覧を取得 |
| GET | /v1/me/substrate/entities/\{entity_id} | エンティティを1件取得 |
| PATCH | /v1/me/substrate/entities/\{entity_id} | 提案を経由してエンティティを更新 |

```
GET /v1/me/substrate/entities?type=person&q=alice&limit=20&count=true
```

| クエリパラメーター | 型 | 既定値 |
|---|---|---|
| `type` | `person` \| `company` \| `fund` \| `workspace` \| `team` \| `project` \| `event` \| `agent` \| `self` | _すべて_ |
| `q` | string（表示名の検索） | _なし_ |
| `limit` | int（1〜200） | 50 |
| `count` | `true`で応答に`total`を含める | `false` |

<span id="source-artifacts"></span>

## 元資料

元資料は、会議の文字起こし、メールのスレッド、通話の録音、文書などの全文検索できる永続的な資料です。Substrateはそこから決定、約束、学びを抽出します。約束には、抽出元を示す`source_artifact_id`を設定できます。

| メソッド | パス | 用途 |
|--------|------|---------|
| GET | /v1/me/substrate/source-artifacts | 元資料の一覧、絞り込み、全文検索 |
| GET | /v1/me/substrate/source-artifacts/\{artifact_id} | 元資料を1件取得（全文の`content`を含む） |

```
GET /v1/me/substrate/source-artifacts?kind=meeting_transcript&q=billing&limit=20&count=true
```

| クエリパラメーター | 型 | 既定値 |
|---|---|---|
| `kind` | string | _すべて_ |
| `q` | string（`title + summary + content`の全文検索） | _なし_ |
| `limit` | int（1〜200） | 50 |
| `count` | `true`で応答に`total`を含める | `false` |

応答：

```json
{
  "artifacts": [
    {
      "id": "art_01…",
      "kind": "meeting_transcript",
      "external_system": "fireflies",
      "external_id": "abc123",
      "title": "Weekly product sync — 2026-06-09",
      "summary": "Reviewed phase 6 scope; Alice owns billing migration.",
      "url": "https://fireflies.ai/…",
      "storage_object_id": null,
      "links": { "entity_ids": ["ent_01…"], "project_tags": ["phase-6"] },
      "attrs": {},
      "source_app_id": "app_…",
      "created_at": "2026-06-09T…",
      "updated_at": "2026-06-09T…"
    }
  ]
}
```

`GET /v1/me/substrate/source-artifacts/{artifact_id}`は、同じ形式に全文の`content`を加えて返します。

元資料の保存には、`POST /v1/me/substrate/actions/propose`で`upsert_source_artifact`を指定します。`id`を省略すると`(external_system, external_id)`で既存の行を探し、なければ`art_<ulid>`を生成する冪等な操作です。インストールしたアプリからの提案は、`source_app_id`でそのアプリに関連付けます。

<span id="memory-search"></span>

## メモリーの検索

`decisions`、`commitments`、`learnings`、`source_artifacts`を横断して全文検索します。

```
GET /v1/me/substrate/memory?q=billing&kinds=decisions,commitments&limit=20
```

`kinds`には`decisions`、`commitments`、`learnings`、`source_artifacts`をカンマ区切りで指定できます。省略するとすべてを検索します。

| クエリパラメーター | 型 | 既定値 |
|---|---|---|
| `q` | string（全文検索。省略または`*`で一覧） | _なし_ |
| `kinds` | `decisions`、`commitments`、`learnings`、`source_artifacts`のカンマ区切り | _すべて_ |
| `limit` | int（1〜200） | 20 |
| `match` | `and` \| `or` \| `phrase` | `and` |

`q`が空、省略、または`*`の場合、選択した種類の最新項目を`updated_at DESC`で返し、`limit`で件数を制限します。全文検索の順位付けはせず、`rank`は`null`です。全件の一覧として利用できます。

`match`は複数語の条件です。`and`はすべての語を含む（既定値）、`or`はいずれかの語を含む、`phrase`は語が連続する場合に一致します。省略すると`match=and`です。

:::note[検索と一覧の使い分け]
全文検索の順位と関連度（`rank`）が必要なら`GET /v1/me/substrate/memory`を使います。日時順や種類・元資料・置き換え済みの状態で絞り込むなら`GET /v1/me/substrate/memory/list`を使います。同じテーブルを参照しますが、取得方法が異なります。
:::

応答：

```json
{
  "results": [
    {
      "id": "dec_01…",
      "kind": "decision",
      "title": "Adopt substrate",
      "body_text": "agent memory needs a single source of truth",
      "rank": 0.18,
      "updated_at": "2026-05-31T…",
      "source_artifact_id": null,
      "supersedes": null,
      "status": "active"
    },
    {
      "id": "art_01…",
      "kind": "source_artifact",
      "title": "Weekly product sync — 2026-06-09",
      "body_text": "Reviewed phase 6 scope; Alice owns billing migration.",
      "rank": 0.12,
      "updated_at": "2026-06-09T…",
      "source_artifact_id": null,
      "supersedes": null,
      "status": null
    }
  ]
}
```

すべての結果に次の3つのフィールドを含めます。

| フィールド | 型 | 補足 |
|---|---|---|
| `source_artifact_id` | `string \| null` | 抽出元の資料の参照。元資料自体や、抽出元なしで取り込んだ項目では`null`。 |
| `supersedes` | `string \| null` | 以前の決定を置き換える`kind: 'decision'`だけに設定。置き換えた決定のID。 |
| `status` | `string \| null` | 決定は`active`・`superseded`・`reversed`・`expired`、約束は`proposed`・`confirmed`・`fulfilled`・`expired`・`broken`など。学びと元資料は`null`。 |

<span id="memory-list-chronological-browse"></span>

## メモリーの一覧（日時順）

`decisions`、`commitments`、`learnings`、`source_artifacts`を条件で絞り込み、日時順で取得します。全文検索と異なり、常に`updated_at DESC`で並び、関連度の順位付けはしません。

```
GET /v1/me/substrate/memory/list?source_artifact_id=art_…&kinds=decisions,commitments,learnings&limit=25
```

| クエリパラメーター | 型 | 既定値 |
|---|---|---|
| `kinds` | `decisions`、`commitments`、`learnings`、`source_artifacts`のカンマ区切り | _すべて_ |
| `source_artifact_id` | string | _なし_ |
| `superseded` | `true` \| `false` | _すべて含める_ |
| `before` | ISO形式の日時（`next_before`のカーソル） | _なし_ |
| `limit` | int（1〜100） | 25 |

**`source_artifact_id`**は、その元資料に関連する行だけに絞ります。元資料の行自体には同フィールドがないため、この条件では含めません。

**`superseded`**が`false`なら、`status='superseded'`の決定と`status='expired'`の約束を除外します。`true`または省略なら、すべての状態を返します。

**`before`**には前の応答の`next_before`をそのまま指定します。ISO形式の日時を使うキーベースのページ分割です。

応答：

```json
{
  "results": [
    {
      "id": "dec_…",
      "kind": "decision",
      "title": "…",
      "body_text": "…",
      "updated_at": "…",
      "source_artifact_id": "art_…",
      "supersedes": "dec_…",
      "status": "active"
    }
  ],
  "next_before": "2026-06-09T14:32:00.000Z"
}
```

次のページがなければ`next_before`は`null`です。

決定と約束には`status`を設定します。学びと元資料では`null`です。`supersedes`は、以前の決定を置き換える決定だけに設定します。

<span id="example--list-every-decision-commitment-and-learning-extracted-from-a-meeting"></span>

### 例：会議から抽出した決定、約束、学びの全件取得

```
GET /v1/me/substrate/memory/list
  ?source_artifact_id=art_01JXYZ…
  &kinds=decisions,commitments,learnings
  &superseded=false
  &limit=50
```

応答：

```json
{
  "results": [
    {
      "id": "dec_01JXYZ…",
      "kind": "decision",
      "title": "Ship phase 6 by end of June",
      "body_text": "Agreed in the weekly sync. Alice owns the billing migration.",
      "updated_at": "2026-06-09T14:30:00.000Z",
      "source_artifact_id": "art_01JXYZ…",
      "supersedes": null,
      "status": "active"
    },
    {
      "id": "com_01JXYZ…",
      "kind": "commitment",
      "title": "Alice to deliver billing migration PR by 2026-06-13",
      "body_text": null,
      "updated_at": "2026-06-09T14:30:01.000Z",
      "source_artifact_id": "art_01JXYZ…",
      "supersedes": null,
      "status": "confirmed"
    }
  ],
  "next_before": null
}
```

<span id="capabilities"></span>

## 機能

一部の機能には、次の任意フィールドがあります。

| 機能 | 任意フィールド | 補足 |
|---|---|---|
| `record_commitment` | `source_artifact_id`, `attrs` | `source_artifact_id`は抽出元の資料への参照（`source_artifacts(id) ON DELETE SET NULL`の外部キー）。`attrs`は呼び出し元のメタデータ用の任意JSON。 |
| `upsert_source_artifact` | `id`, `external_system`, `external_id`, `summary`, `content`, `storage_object_id`, `url`, `links`, `attrs` | 必須：`kind`、`title`。`id`省略時は`(external_system, external_id)`で冪等。`default_policy='auto'`、`reversible=true`、`yolo_eligible=true`。応答：`{ artifact_id, was_insert, before }`。 |

<span id="capability-payloads"></span>

## 機能の本文

各機能の既定のポリシーとフラグは、[機能の一覧](/ja/core-concepts/substrate/#capabilities-at-a-glance)を参照してください。

以下は機能のZodスキーマで定義されたフィールド名と型です。任意のフィールドは省略できます。

<span id="memory-writes"></span>

### メモリーへの書き込み

```
record_decision
  required: title (string), kind ('operational'|'strategic'|'mission'|'vision'|'principle'|'policy_decision')
  optional: rationale (string), salience ('ambient'|'normal'|'archival', default 'normal'), source_artifact_id (string)
  default_policy: auto

record_commitment
  required: description (string), status ('proposed'|'tentative'|'confirmed'|'fulfilled'|'expired'|'broken')
  optional: from_entity (string), to_entity (string), amount (number), unit (string), due_at (string, ISO 8601), source_artifact_id (string), attrs (object)
  default_policy: auto

record_learning
  required: title (string), description (string)
  optional: resolution_taken (string), related_decision_id (string), source_artifact_id (string)
  default_policy: auto

record_principle
  required: title (string), applies_to (object, e.g. {capability: "send_email_draft", target_role: "investor"}), constraint_spec (object, e.g. {type: "max_per_week", params: {n: 2}})
  optional: rationale (string), salience ('ambient'|'normal'|'archival', default 'ambient')
  default_policy: approval_required

supersede_decision
  required: old_decision_id (string), new_title (string), kind ('operational'|'strategic'|'mission'|'vision'|'principle'|'policy_decision')
  optional: new_rationale (string)
  default_policy: approval_required

retire_principle
  required: principle_id (string), reason (string)
  default_policy: approval_required
```

<span id="entity-writes"></span>

### エンティティへの書き込み

```
upsert_entity
  required: type ('person'|'company'|'fund'|'workspace'|'team'|'project'|'event'|'agent'|'self'), display_name (string)
  optional: id (string), primary_email (string, email), canonical_keys (object), linked_app_user_id (string, uuid), linked_app_id (string), attrs (object)
  default_policy: auto
  note: dedups by id > canonical_keys > primary_email

update_entity
  required: id (string)
  optional: display_name (string), primary_email (string, email), attrs (object)
  default_policy: auto
  note: replaces attrs wholesale; prefer patch_entity for partial updates

patch_entity
  required: id (string)
  optional: display_name (string), primary_email (string, email), attrs_patch (object, RFC 7396 merge-patch), if_updated_at (string, datetime, optimistic lock)
  default_policy: auto

merge_entities
  required: loser_id (string), winner_id (string), reason (string)
  default_policy: approval_required

delete_entity
  required: id (string), reason (string)
  default_policy: approval_required
```

<span id="source-artifacts-1"></span>

### 元資料

```
upsert_source_artifact
  required: kind (string), title (string)
  optional: id (string), external_system (string), external_id (string), summary (string), content (string), storage_object_id (string), url (string), links ({entity_ids?: string[], project_tags?: string[]}), attrs (object)
  default_policy: auto
  note: idempotent by (external_system, external_id) when id is omitted
```

<span id="revert--bulk-revert"></span>

### 取り消しと一括取り消し

```
revert_action
  required: action_id (string)
  default_policy: auto

bulk_revert_actions
  required: action_ids (string[], 1–200 items), reason (string)
  default_policy: approval_required
```

<span id="side-effecting"></span>

### 外部への操作

```
send_email_draft
  required: to (string), subject (string), body (string)
  optional: target_role (string)
  default_policy: approval_required
```

<span id="daily-snapshots"></span>

## 日次スナップショット

注意ルールの`snapshot_predicate`条件は、スナップショットを基に評価します。

```
GET /v1/me/substrate/snapshots?days=7
```

応答：

```json
{
  "snapshots": [
    { "snapshot_date": "2026-05-31", "entity_count": 12, "decision_count": 8, "…": "…" }
  ]
}
```

<span id="attention-rules"></span>

## 注意ルール

| メソッド | パス | 用途 |
|--------|------|---------|
| GET | /v1/me/substrate/attention-rules | ルール一覧を取得 |
| GET | /v1/me/substrate/attention-rules/\{rule_id} | ルールを1件取得 |
| POST | /v1/me/substrate/attention-rules | ルールを作成 |
| PUT | /v1/me/substrate/attention-rules/\{rule_id} | ルールを更新 |
| DELETE | /v1/me/substrate/attention-rules/\{rule_id} | ルールを削除 |
| POST | /v1/me/substrate/attention-rules/\{rule_id}/enable | 有効にする |
| POST | /v1/me/substrate/attention-rules/\{rule_id}/disable | 無効にする |
| POST | /v1/me/substrate/attention-rules/preview | 今日のスナップショットでルールの本文を試す |
| GET | /v1/me/substrate/attention-rules/\{rule_id}/firings | 発火履歴を取得 |

<span id="rule-body"></span>

### ルールの本文

```json
{
  "name": "weekly digest",
  "description": "Monday morning summary",
  "trigger_cron": "0 9 * * 1",
  "condition_mode": "snapshot_predicate",
  "condition": { ">": [ { "var": "entity_count" }, 0 ] },
  "action_capability": "send_email_draft",
  "action_payload_template": {
    "to": "you@example.com",
    "subject": "Weekly digest",
    "body": "{{entity_count}} entities."
  },
  "enabled": true,
  "max_fires_per_day": 1
}
```

| フィールド | 必須 | 補足 |
|---|---|---|
| `name` | はい | 表示名 |
| `trigger_cron` | はい | 標準の5フィールドのcron式（UTC） |
| `condition_mode` | はい | `snapshot_predicate`は今日のスナップショットに対してJSON-Logicを評価します。`row_query`は行クエリとして条件を実行する上級者向けの指定です。 |
| `condition` | はい | JSON-Logicオブジェクト。利用できる変数は`condition_mode`により異なります。 |
| `action_capability` | はい | 発火時に提案する機能 |
| `action_payload_template` | はい | 一致した値で`{{var}}`を置き換えるオブジェクト |
| `enabled` | いいえ | 既定値は`true`。 |
| `max_fires_per_day` | いいえ | 1日あたりの提案件数の上限 |

<span id="preview"></span>

### プレビュー

```json
POST /v1/me/substrate/attention-rules/preview
{ <same shape as rule body, name optional> }
```

応答：

```json
{
  "bindings_count": 3,
  "sample_proposals": [
    { "binding": { "entity_count": 12 }, "rendered_payload": { … }, "would_require_approval": false }
  ],
  "skip_reason": null
}
```

スナップショットがない、または条件を評価できない場合、`skip_reason`を設定し、`bindings_count`は0です。

<span id="outbox-targets"></span>

## Outboxの送信先

`capability X`のアクションを実行すると、登録済みのOutboxの送信先へ本文をPOSTします。HMAC署名を付け、失敗時は間隔を延ばしながら再試行します。

| メソッド | パス | 用途 |
|--------|------|---------|
| GET | /v1/me/substrate/outbox-targets | 全送信先の一覧を取得 |
| PUT | /v1/me/substrate/outbox-targets/\{capability} | 送信先を登録または置換 |
| DELETE | /v1/me/substrate/outbox-targets/\{capability} | 送信先を削除 |

```json
PUT /v1/me/substrate/outbox-targets/send_email_draft
{
  "webhook_url": "https://example.com/hooks/substrate",
  "signing_secret": "min-8-chars",
  "source_app_id": "app_optional_scope"
}
```

`source_app_id`は任意です。指定すると、そのアプリが提案したアクションだけを送信します。

<span id="webhook-delivery"></span>

### Webhookの配信

```
POST https://example.com/hooks/substrate
Content-Type: application/json
X-Butterbase-Signature: sha256=<hex>
X-Butterbase-Delivery: <uuid>

{
  "action_id": "act_01…",
  "capability": "send_email_draft",
  "payload": { … the rendered action payload … },
  "executed_at": "2026-05-31T…"
}
```

`signing_secret`を使い、本文の生データに対するHMAC-SHA-256を計算して署名を検証してください。

<span id="websocket-stream"></span>

## WebSocketストリーム

呼び出し元のSubstrateのすべての変更をリアルタイム配信します。

```
GET /v1/me/substrate/stream
```

<span id="browser-flow"></span>

### ブラウザーからの接続

ブラウザーのWebSocket接続では独自のヘッダーを送信できないため、1回限りのチケットを使います。

1. チケットを発行します（Cognitoまたは`bb_sub_`のBearer）。

   ```
   POST /v1/me/substrate/ws-ticket
   ```

   ```json
   { "ticket": "wst_…", "expires_in": 60 }
   ```

2. `?ticket=`を指定して接続します。

   ```
   wss://api.butterbase.ai/v1/me/substrate/stream?ticket=wst_…
   ```

チケットは**1回限り**で、60秒で失効します。再使用や期限切れの場合、`1008 unauthenticated`で接続を閉じます。

<span id="server-side-flow"></span>

### サーバーからの接続

サーバーなどのクライアントは、WebSocket接続のAuthorizationヘッダーにSubstrate用のキーを指定できます。

```
GET /v1/me/substrate/stream
Upgrade: websocket
Authorization: Bearer bb_sub_…
```

代わりにクエリ文字列でも指定できます。

```
wss://api.butterbase.ai/v1/me/substrate/stream?token=bb_sub_…
```

<span id="app-function-flow"></span>

### アプリの関数からの接続

組織に紐付けたアプリでは、Substrateキーをブラウザーへ渡さずに、自分のユーザー用のチケットを発行できます。デプロイした関数内で次を呼び出します。

```ts
const { ticket, expires_in } = await ctx.substrate.wsTicket();
```

内部のサーバー間通信で、アプリに紐付けた組織の60秒・1回限りのチケットを返します。ブラウザーへ渡し、`?ticket=`で接続してください。エンドユーザー向けのアプリではこの方法を推奨します。[ブラウザーの例](/ja/core-concepts/substrate/#8-stream-live-updates-to-a-ui)を参照してください。

<span id="frames"></span>

### フレーム

```json
// First frame on open:
{ "type": "hello", "ts": 1780198304 }

// Subsequent frames, one per change — envelope only, no row payload:
{ "tbl": "entities",               "op": "insert", "id": "ent_…",  "org": "…" }
{ "tbl": "action_ledger",          "op": "insert", "id": "act_…",  "org": "…" }
{ "tbl": "decisions",              "op": "insert", "id": "dec_…",  "org": "…" }
{ "tbl": "commitments",            "op": "update", "id": "com_…",  "org": "…" }
{ "tbl": "learnings",              "op": "insert", "id": "lrn_…",  "org": "…" }
{ "tbl": "attention_rules",        "op": "update", "id": "rule_…", "org": "…" }
{ "tbl": "attention_rule_firings", "op": "insert", "id": "fire_…", "org": "…" }
```

変更フレームの形式は`{ org, op, tbl, id }`です。

| フィールド | 意味 |
|---|---|
| `org` | 変更が属する組織。組織単位のストリームで、チケットまたはキーに紐付いた組織の変更だけを受信します。 |
| `op` | `insert`、`update`、`delete` |
| `tbl` | 変更された実テーブル（例：`entities`、`action_ledger`、`decisions`） |
| `id` | 変更された行のID |

本文のデータは配信しません。クライアントがIDを使って変更された行を再取得してください。

<span id="close-codes"></span>

### 終了コード

| コード | 意味 |
|---|---|
| 1000 | 通常終了（クライアントから切断） |
| 1008 | チケットがない、期限切れ、再使用、またはトークンが無効 |

<span id="sdk--cli"></span>

## SDKとCLI

- **CLI**：すべてのコマンドは[`butterbase substrate`](/ja/cli/substrate/)を参照してください。
- **TypeScript SDK**：`butterbase.substrate.*`にHTTP APIと対応するメソッドがあります。
- **関数内**：`ctx.substrate.*`（`propose`、`getEntity`、`findEntities`、`searchMemory`、`listMemory`）を使います。[Substrate](/ja/core-concepts/substrate/)を参照してください。
