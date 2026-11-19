---
title: ハッカソン
description: 開催中のハッカソンにMCPでButterbaseプロジェクトを提出し、採点結果と提出内容を確認します。
---

Butterbaseのハッカソンでは、主催者から受け取ったコードで参加登録し、**`prep_and_submit_hackathon_entry`** MCPツールでプロジェクトを提出します。提出内容は[ダッシュボード](https://dashboard.butterbase.ai/hackathon)で確認できます。

<span id="before-you-submit"></span>

## 提出前の準備

1. **MCPを接続** — [MCPの設定](/ja/getting-started/mcp-setup)に従い、APIキーでアシスタントからツールを使えるようにします。
2. **提出コードを入手** — 主催者からハッカソンごとのコードを受け取ります。**初回**の提出成功時に必要で、アカウントをそのハッカソンに紐付けます。複数のハッカソンが開催中の場合は、事前確認でも対象の特定に使います。
3. **`app_id`を確認**（推奨）— **`manage_app`**に`action: "list"`を指定し、提出するアプリの`id`（例：`app_abc123`）をコピーします。後述の[app_idを指定する理由](#why-include-app_id)を参照してください。

<span id="submitting-with-mcp"></span>

## MCPで提出する

いずれかのハッカソンが`starts_at ≤ 現在時刻 ≤ submission_deadline`を満たす間、MCPツール一覧に**`prep_and_submit_hackathon_entry`**が表示されます。イベントの`ends_at`と、提出締切の**`submission_deadline`**は別です。

処理は**2段階**です。まず**prep**でハッカソンと入力項目を確認し、次に**submit**で確定した値を送ります。

<span id="step-1--action-prep"></span>

### 手順1 — `action: "prep"`

**`submission_code`**を渡すと、対象を特定して次を返します。

- **`matched`** — 対象と入力項目を示す`{ slug, name, submission_deadline, ends_at, field_schema }`。
- **`open_hackathons`** — 提出受付中の全ハッカソン。`matched`が`null`の場合は、この一覧から対象を判断します。
- **`next_call`** — `field_schema`の全項目のプレースホルダーを含む、**submit**呼び出しの例。手順2ではこの形を使い、`arguments.data`の各値をユーザーが確認した値に置き換えます。

`matched`が`null`で`open_hackathons`が複数ある場合は、ユーザーに対象を確認し、適切な`submission_code`でprepを再実行します。

<span id="step-2--action-submit"></span>

### 手順2 — `action: "submit"`

次を送信します。

- **`hackathon_slug`** — prepの**`matched.slug`**を使い、事前確認した対象へ提出します。
- **`data`** — 各`field_schema`項目の`key`に対応するオブジェクト。prepの`next_call.arguments.data`のプレースホルダーを埋めると簡単です。JSON文字列も受け付け、解析されます。
- **`app_id`** — 指定を強く推奨します。[app_idを指定する理由](#why-include-app_id)を参照してください。
- **`submission_code`** — 参加者として紐付ける**初回**の提出だけに必要です。その後はユーザーIDで紐付いているため不要です。

<span id="if-data-is-missing"></span>

### `data`を省略した場合

`data`を省略してsubmitを呼んでも、単にエラーを返すわけではありません。ハッカソンを再確認し、入力スキーマと**`next_call`**の雛形を返します。その形で再試行でき、追加の事前確認は不要です。

<span id="updates"></span>

### 提出内容の更新

提出は**upsert**です。新しい`data`でsubmitを再度呼ぶと、内容を更新して**`version`**を増やします。

<span id="why-include-app_id"></span>

## `app_id`を指定する理由

可能な限り、毎回の提出に作成したButterbaseアプリの**`app_id`**を含めてください。

**自動ランキング採点**は次の仕組みです。

- **`*.butterbase.dev`**上の有効な**デモURL**に最大**50点**。スキーマに**`is_url`**指定の項目があればその値を使い、なければ**`data`**内の**`demo_url`**を使います。
- **`app_id`**に紐付くアプリで検出した**Butterbase機能**に追加で最大**50点**。データベース、関数、公開フロントエンド、認証ユーザー、ストレージ、OAuth、リアルタイム、連携などが対象です。

**`app_id`**を省略するとデモURLだけを採点し、機能部分は**0点**です。アプリを紐付けた同等の作品より、合計点が通常低くなります。

**審査員**も、具体的なアプリへの紐付けがあれば実際のプロジェクトを確認しやすくなります。

<span id="view-your-submission"></span>

## 提出内容を確認する

ログインして**[dashboard.butterbase.ai/hackathon](https://dashboard.butterbase.ai/hackathon)**を開くと、締切、提出項目（閲覧のみ）、現在の**version**が表示されます。更新には再びMCPを使います。

<span id="related"></span>

## 関連ページ

- [MCPの設定](/ja/getting-started/mcp-setup) — アシスタントを接続。
- [MCPツール](/ja/api-reference/mcp-tools) — 受付期間中のハッカソン用ツールを含む一覧。
