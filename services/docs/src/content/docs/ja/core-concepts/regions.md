---
title: リージョン
description: ユーザーに近い場所でデータと処理を動かし、共通のAPI URLから利用します。
---

アプリを作成するときにリージョンを選びます。データベース、ファイル、関数はその場所に置き、利用者に近い環境で処理します。クライアントは共通のAPI URLを使い続け、Butterbaseが自動で振り分けます。

<span id="available-regions"></span>

## 対応リージョン

| リージョン | コード |
|---|---|
| 米国東部 | `us-east-1` |
| 米国西部 | `us-west-2` |

今後リージョンを追加予定です。希望する地域があれば[ご連絡ください](mailto:hello@butterbase.ai)。

<span id="fetching-the-live-list"></span>

### 最新の一覧を取得

対応リージョンはAPIから取得できます。選択画面の作成や、`init_app`または`manage_app`（action：`"move"`）前のスラッグ検証に使えます。

**MCP**

```
list_regions()
```

**REST**

```bash
curl https://api.butterbase.ai/v1/regions
# → { "regions": ["us-east-1", "us-west-2"] }
```

このエンドポイントは公開されており、APIキーは不要です。

<span id="picking-a-region-when-you-create-an-app"></span>

## アプリ作成時に選ぶ

リージョンの指定は任意です。省略すると既定のリージョンに作成します。

**MCP**

```
init_app({ name: "my-app", region: "us-west-2" })
```

**CLI**

```bash
butterbase apps create my-app --region us-west-2
```

**REST**

```bash
curl -X POST https://api.butterbase.ai/init \
  -H "Authorization: Bearer $BUTTERBASE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-app", "region": "us-west-2"}'
```

<span id="what-lives-in-a-region"></span>

## リージョン内に置くもの

各アプリは拠点となるリージョンを1つ持ち、次を保存・実行します。

- データベース
- サーバーレス関数
- ファイルストレージ
- エンドユーザーのアカウントとセッション

次はグローバルで、リージョン選択の影響を受けません。

- API URL：`https://api.butterbase.ai`をどこからでも利用
- フロントエンド：グローバルのエッジネットワークから配信
- Butterbaseのアカウント、課金、ダッシュボード

<span id="one-url-anywhere"></span>

## どこでも1つのURL

フロントエンドとSDKは常に`https://api.butterbase.ai`を使います。リージョン固有URLを指定する必要はなく、移動時も変更不要です。適切なリージョンへリクエストを振り分けます。

<span id="moving-an-app-to-another-region"></span>

## 別リージョンへ移動

利用者の地域が変わった場合や、別の地域へ近づけたい場合はアプリを移動できます。

**MCP**

```
manage_app({ action: "move", app_id: "app_abc123", dest_region: "us-east-1" })
```

**CLI**

```bash
butterbase apps move app_abc123 --to us-east-1
```

移動中も読み取りは可能です。切り替え時に書き込みを短時間停止し、完了後に自動再開します。通常は数分で終わりますが、データ量によって変わります。

進捗はいつでも確認できます。

```
manage_app({ action: "move_status", app_id: "app_abc123", migration_id: "<id from move>" })
```

同じアプリの移動が進行中の場合、別の移動は開始できません。

<span id="choosing-a-region"></span>

## 選ぶときの考え方

次を検討してください。

- **利用者の所在地。** 多数のユーザーに最も近いリージョンを選びます。ユーザーとデータベース間の往復遅延は、体感速度に大きく影響します。
- **データの保存地域。** 特定の法域に保存する必要があれば、その地域を選びます。未提供の地域が必要ならお問い合わせください。
- **後から変更可能。** 最初のリージョンに固定されません。用途が変われば移動できます。

迷う場合は指定を省略すると、Butterbaseが既定値を選びます。後から移動できます。
