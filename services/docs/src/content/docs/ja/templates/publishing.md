---
title: テンプレートの公開
description: 自分のアプリを公開し、他のユーザーが複製できるようにします。
---

アプリをpublicにしてスナップショットをpushするとテンプレートになります。提出や審査、別のテンプレートオブジェクトはなく、アプリ自体を使います。

<span id="why-publish"></span>

## 公開する理由

- **配布。** ダッシュボードの一覧とAIエージェントのfind_templatesに表示。
- **複製数。** 毎回fork_countを増やし、Popular順に使用。
- **簡単な導入。** 手動作成の長い手順ではなく、Cloneで動くアプリを渡す。
- **複製時の通知。** 完了Webhookで案内、導入数の計測、自分側の処理を実行。

<span id="requirements"></span>

## 条件

| 条件 | 理由 |
|---|---|
| `visibility: public` | 非公開の複製元は404 |
| repo pushを1回以上 | スナップショットがコピー元。ない場合は拒否 |
| listed: true（任意） | 複製の可否ではなく検索表示を制御 |
| 準備済みのアプリ | 未プロビジョニングは検索から除外 |

<span id="step-1--prepare-the-app-for-other-people"></span>

## 手順1 — 他の人向けに準備

公開に切り替えると、スキーマ、関数コード、ファイル、環境変数の**キー名**を誰でも読めます。先に確認してください。

- **テーブル。** 行をコピーするのは_seed: trueだけですが、全スキーマは公開します。列名に機密情報を含めない。
- **スナップショット。** pushした内容が配布されます。.env、実顧客のテストデータ、埋め込みキーを確認し、[repoの除外](/ja/cli/repo/)を設定。
- **キー名。** 値は渡しませんが、ACME_CORP_INTERNAL_TOKENのような名前も情報になります。
- **RLS。** そのまま複製します。デモ用の広い許可は先に見直し、[RLS](/ja/core-concepts/row-level-security/)を確認。
- **初回起動。** 自分で試験用アプリへ複製し、実際に使う。

<span id="step-2--add-seed-data"></span>

## 手順2 — シードを用意

初回に使える参照データや例を用意します。スキーマに_seed: trueを設定したテーブルの行をコピーします。

```json
{
  "tables": {
    "categories": {
      "_seed": true,
      "id": "uuid primary key",
      "name": "text not null"
    }
  }
}
```

未指定のテーブルはスキーマだけをコピーします。ユーザー固有のデータは指定しないでください。[データベース](/ja/core-concepts/database/#marking-tables-as-seed-data)を参照してください。

<span id="step-3--push-your-repo-snapshot"></span>

## 手順3 — スナップショットをpush

```bash
butterbase repo init <app_id>     # once, binds the folder
butterbase repo push --message "Template release"
```

内容で識別するため再pushは低コストです。**最新**を複製するので、コードを変えたら再送します。既存の複製先は変更しません。

<span id="step-4--make-it-public"></span>

## 手順4 — 公開設定

**CLI:**

```bash
butterbase visibility public --listed
butterbase visibility public --unlisted
butterbase visibility private
```

**MCP:**

```
manage_app action: "set_visibility"
  app_id: "<app_id>"
  visibility: "public"
  listed: true
```

**REST:**

```json
PATCH /v1/{app_id}/config/visibility
{ "visibility": "public", "listed": true }
```

**ダッシュボード：App → Settings → Visibility**。

<span id="public-vs-listed"></span>

### publicとlisted

| visibility | listed | 結果 |
|---|---|---|
| `private` | — | 複製不可 |
| `public` | `true` | 複製可能。一覧とfind_templatesに表示 |
| `public` | `false` | IDを知る人が複製可能。検索非表示 |

publicかつlisted: falseなら、チーム・受講者・顧客にIDを送って共有できます。一覧からは見つかりません。

:::caution
非掲載でも公開アプリです。ユーザーごとの許可リストはなく、IDを知ることはアクセス制御にはなりません。
:::

<span id="step-5--set-a-clone-webhook-optional"></span>

## 手順5 — 複製Webhook（任意）

複製完了ごとにHTTP通知を受け取ります。

**MCP:**

```
manage_app action: "set_clone_webhook"
  app_id: "<app_id>"
  webhook_url: "https://example.com/hooks/butterbase-clone"
  webhook_secret: "<16-256 chars>"
```

**REST:**

```json
PATCH /v1/{app_id}/config/clone-webhook
{ "webhook_url": "https://example.com/hooks/clone", "webhook_secret": "…" }
```

本文のclear: true、またはMCPのclear_webhook: trueで解除します。

**通知内容：**

```
POST https://example.com/hooks/clone
Content-Type: application/json
X-Butterbase-Event: clone_completed
X-Butterbase-Signature: sha256=<hex>

{
  "event": "clone_completed",
  "job_id": "…",
  "source_app_id": "app_yours",
  "dest_app_id": "app_theirs",
  "dest_region": "us-west-2",
  "completed_at": "2026-08-26T12:00:00.000Z"
}
```

**署名を検証してください。** 生の本文をシークレットでHMAC-SHA256し、sha256=<hex>で比較します。

```typescript
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(rawBody: string, header: string, secret: string) {
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const a = Buffer.from(expected), b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
}
```

再シリアライズせず**生の本文**を使います。2xxを返してください。その他は間隔を延ばして再試行し、その後破棄します。

<span id="maintaining-a-template"></span>

## 維持・更新

**更新：** 新しいスナップショットをpushし、スキーマ変更を適用します。新規の複製先は現在の状態を使い、既存は変わりません。既存の複製先は自動更新されません。

**非公開化：** visibility: privateに戻しても、独立済みの複製先は動き続けます。

**バージョン：** v1とv2を別々に複製可能にするなら、別アプリで保持します。repoは直近5スナップショットだけで、複製は最新を使います。

<span id="checklist-before-you-flip-the-switch"></span>

## 公開前の確認

- [ ] スナップショットにシークレット、実顧客データ、.envがない
- [ ] 環境変数名に機密情報がない
- [ ] 他人のアプリの既定として安全なRLS
- [ ] シードに非公開データがない
- [ ] 自分で複製し、動作を確認済み
- [ ] 複製後の設定をREADMEに記載
- [ ] listedが目的どおり（検索表示かID共有）
