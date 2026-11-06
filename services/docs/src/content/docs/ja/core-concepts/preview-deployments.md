---
title: プレビューデプロイ
description: 実データを含む本番アプリのコピーで変更を試し、準備ができたら本番へ反映します。
---

プレビューデプロイは、変更を試すための本番アプリのコピーです。

専用のデータベース、ファイル、ユーザー登録、URLを持ちます。プレビューの操作が本番アプリへ直接反映されることはありません。変更を確認してから本番へ反映します。

本番と同じ環境やデータで、利用者へ影響する前に試せます。

:::note[フロントエンドだけでなくアプリ全体のコピー]
フロントエンドのデプロイは既存のアプリのファイルを更新します。プレビューデプロイはバックエンドを含むアプリ全体を別に作成する機能です。
:::

<span id="whats-in-a-preview"></span>

## プレビューに含まれるもの

本番アプリの**実データ**も複製します。

- すべてのテーブルのすべての行。
- 登録済みの全アカウントとパスワード情報。本番と同じパスワードでログインできます。
- アップロードした全ファイル。

:::caution[ユーザーの実データのコピーを含みます]
本番で個人情報を保存している場合、プレビューにもそのコピーが含まれます。プレビューへアクセスを許可する相手や権限を、本番と同じように慎重に管理してください。
:::

<span id="what-deliberately-doesnt-come-along"></span>

### 意図的に複製しないもの

本番の外部サービスに影響する操作を避けるため、次の情報や機能は引き継ぎません。

| 引き継がないもの | 理由 |
|---|---|
| シークレットとAPIキーの**値** | テストで本番の課金を行うことを防ぎます。キー名は作りますが値は**空**です。[プレビューのシークレット](#preview-secrets)を設定してください。 |
| 接続済みアカウント（Stripe、Googleなど） | 複製後に接続を解除します。必要ならプレビューで再接続してください。 |
| 定期実行と外部連携 | **無効**にします。複製した課金ジョブなどが自動で動くことを防ぎます。 |
| 課金と分析の履歴 | 本番アプリの履歴として保持します。 |

アップロードしたファイルのIDはプレビューで新しくなります。独自のテーブルにファイルIDを保存している場合、その列は本番のファイルを指したままです。

<span id="creating-a-preview"></span>

## プレビューの作成

1つのアプリに**1つ**作成でき、本番と同じリージョンに配置します。

**AIアシスタントへ「このアプリのプレビューデプロイを作成して」と依頼**するか、次の方法を使います。

**MCP**

```
manage_preview({ app_id: "app_abc123", action: "create" })
```

**REST**

```bash
curl -X POST https://api.butterbase.ai/v1/apps/app_abc123/staging \
  -H "Authorization: Bearer $BUTTERBASE_API_KEY"
```

**ダッシュボード**：アプリを開き、サイドバーの**Preview**を選択します。

作成すると`job_id`を返します。データ量に応じて時間がかかり、すぐには完了しません。

```
manage_preview({ app_id: "app_abc123", action: "status" })
```

ジョブが`completed`になるまで利用できません。その間は`status`に表示されず、本番との紐付けも未完了です。

<span id="preview-secrets"></span>

## プレビューのシークレット

シークレットのキー名だけを複製し、値は複製しません。プレビュー専用の値を設定してください。通常はテスト用の認証情報を使い、本番のキーと分けます。

```
manage_preview({
  app_id: "app_abc123",
  action: "set_env_overrides",
  env_overrides: { PAYMENT_PROVIDER_KEY: "sk_test_..." }
})
```

次の2点に注意してください。

- 設定は**本番**アプリに関連付けて保存します。プレビューの作成前に設定でき、リセットや削除後の再作成でも維持します。
- 取得できるのはキー名だけです。値は読み出せません。

設定時は全体を置き換えます。空のオブジェクトで全削除します。

<span id="pushing-a-preview-live"></span>

## 本番への反映

プレビューの**構造**を本番へ反映します。テーブルと列、アクセスルール、関数、設定、コードを対象とし、フロントエンドもデプロイします。実際の本番へのデプロイです。

**本番の行データは維持します。** 上書きや削除はしません。プレビューで追加したテーブルは、本番では空のテーブルとして作成します。

まず変更内容を確認してください。

```
promote_preview({ app_id: "app_abc123", action: "check" })
```

```json
{
  "can_promote": true,
  "additive": ["ALTER TABLE orders ADD COLUMN refunded_at timestamptz"],
  "blocked": [],
  "ignored_removals": []
}
```

`additive`は適用可能な追加変更です。`blocked`が空で`can_promote`がtrueなら実行できます。

```
promote_preview({ app_id: "app_abc123", action: "run" })
```

<span id="what-gets-blocked-and-why"></span>

### 反映を制限する変更

本番のデータを失うおそれがある型変更や必須化は制限します。禁止された変更が含まれると、反映全体を中止して何も適用しません。削除の扱いは下の節を参照してください。

| プレビューの変更 | 本番への反映時の扱い |
|---|---|
| 列を削除 | `ignored_removals`に記録し、本番の列を維持します。 |
| テーブルを削除 | `ignored_removals`に記録し、本番のテーブルを維持します。 |
| 列の型を変更（例：文字列から数値） | 既存の値を変換できないおそれがあるため制限します。 |
| 既存の列を必須に変更 | 空の値がある行で失敗するため制限します。 |

禁止された変更と安全な変更が混在しても、全体を中止します。一部だけ適用した状態は作りません。

制限の原因となる変更を具体的に示します。必要な変更であることを確認したうえで、本番側で直接変更してから再試行してください。

似ている2つの変更でも扱いが異なります。

- **既定値のある必須列の追加**：既存の行に既定値を設定できるため、行があっても反映できます。
- **既存列の必須化**：本番に空の値があると失敗するため、制限します。

<span id="deleting-things-is-ignored-not-applied"></span>

### 削除は反映せず無視する

プレビューでテーブルや列を削除しても、本番では**維持**します。`ignored_removals`に表示し、削除自体は反映もブロックもしません。

本番から削除する場合は、本番に対して明示的に操作してください。

<span id="starting-a-preview-over"></span>

## プレビューのリセット

プレビューの内容を破棄し、本番から新しく複製します。変更をやり直したい場合に使います。

```
manage_preview({ app_id: "app_abc123", action: "reset" })
```

**構造**も本番に合わせるため、プレビューだけに追加したテーブルなどを削除したり、列やルールの変更を戻したりします。破棄した内容を具体的に知らせます。

> リセットでプレビューを本番と同じ構造に戻しました。プレビューだけに存在した、または異なっていた2つの変更を破棄しました："orders"."currency"を削除し、"orders"."status"を本番と同じ任意列に戻しました。本番は変更していません。

破棄するのは**プレビュー**の内容だけです。リセットで本番へ書き込むことはありません。

プレビューのシークレットはリセット後も維持します。

<span id="previews-you-stop-using-get-paused"></span>

## 未使用プレビューの一時停止

30日間アクセスのないプレビューは**一時停止**します。削除せず、データも保持します。Previewページから再開できます。

削除は手動で明示的に行います。

<span id="what-it-costs-and-what-it-counts-against"></span>

## 料金と利用枠

- **Launch以上のプランが必要**です。無料のPlaygroundでは、作成ボタンの代わりにアップグレードの案内を表示します。
- **1プロジェクトとして数えます。** Launchの上限が3なら、本番とプレビューで2を使い、残りは1です。上限に達している場合は作成に失敗します。
- **1アプリあたり1つ。**
- **本番と同じリージョン**に配置し、同じリージョン内で紐付けます。
- **プレビューのあるアプリは別リージョンへ移動できません。** 先に削除または紐付けを解除します。プレビュー側だけの移動もできません。
- **通常のアプリと同様に課金します。** 専用のデータベースと使用量を持ち、プランの利用枠に含まれます。Billingページでは本番と分けて表示します。

<span id="disconnecting-a-preview"></span>

## 紐付けの解除

両方のアプリを削除せずに紐付けだけを解除します。元のプレビューは独立したアプリとして残り、新しいプレビューを作成できます。

```bash
curl -X DELETE https://api.butterbase.ai/v1/apps/app_abc123/staging \
  -H "Authorization: Bearer $BUTTERBASE_API_KEY"
```

完全に削除する場合は、通常のアプリと同じ削除操作を行います。

<span id="reference"></span>

## リファレンス

RESTのパスは内部名の`staging`を使います。プレビューデプロイと同じ機能で、パスは変わっていません。

<span id="mcp-tools"></span>

### MCPツール

| ツール | 操作 |
|---|---|
| `manage_preview` | `create`, `status`, `reset`, `get_env_overrides`, `set_env_overrides` |
| `promote_preview` | `check`, `run` |

:::caution[ツール名が変わりました]
以前の`manage_staging`と`promote_staging`は廃止しました。読み取り専用の`preview`操作は`check`へ変わりました。保存したプロンプトやスクリプトを更新してください。
:::

<span id="rest-endpoints"></span>

### RESTエンドポイント

| メソッド | パス |
|---|---|
| `POST` | `/v1/apps/:app_id/staging` |
| `GET` | `/v1/apps/:app_id/staging` |
| `DELETE` | `/v1/apps/:app_id/staging` |
| `POST` | `/v1/apps/:app_id/staging/reset` |
| `GET` | `/v1/apps/:app_id/staging/promote/preview` |
| `POST` | `/v1/apps/:app_id/staging/promote` |
| `GET` | `/v1/apps/:app_id/staging/env-overrides` |
| `PUT` | `/v1/apps/:app_id/staging/env-overrides` |

`GET /v1/clone-jobs/:job_id`でジョブを確認できます。
