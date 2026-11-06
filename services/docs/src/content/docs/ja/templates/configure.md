---
title: 複製先の設定
description: 引き継いだ設定と、公開前に自分で設定する項目を確認します。
---

複製でバックエンドは動きますが、製品の準備が終わるわけではありません。元の所有者のシークレット、本人や課金に紐付く設定は引き継ぎません。必要な設定をこのページで確認してください。

<span id="what-transferred"></span>

## 引き継ぐもの

| | |
|---|---|
| **スキーマ** | テーブル、列、型、インデックス |
| **セキュリティ** | RLSポリシー、アクセスモード |
| **関数** | コードを新しいアプリに公開 |
| **Durable Objects** | クラスを新しい名前空間へ公開 |
| **リポジトリ** | 最後にpushしたスナップショット |
| **設定** | ストレージ、CORS、OAuth一覧とリダイレクト、AI既定モデル |
| **アプリ環境変数** | アプリ共通の変数（値を含む） |
| **シードデータ** | `_seed: true`を指定したテーブルの行 |
| **フロントエンド** | 最後の公開出力。アプリIDを書き換え、自分のバックエンドへ接続 |

<span id="what-did-not-transfer"></span>

## 引き継がないもの

| 項目 | 理由 |
|---|---|
| ユーザーとセッション | 元アプリのユーザーに属する |
| OAuthクライアントシークレット | 元の所有者の認証情報 |
| 関数環境変数の値 | シークレット。キー名だけを取得 |
| DO環境変数の値 | アプリ固有のシークレット |
| BYOK AIキー | 元の所有者の課金情報 |
| [カスタムドメイン](/ja/core-concepts/custom-domains/) | 自分が管理しないDNS |
| Stripe Connect、プラン、商品 | 元の所有者のStripeアカウント |
| 呼び出し履歴・監査ログ | 元アプリの記録 |

<span id="the-checklist"></span>

## 設定手順

<span id="1-read-the-clone-jobs-warnings"></span>

### 1. ジョブの警告を読む

```
manage_app action: "get_clone_job", job_id: "<job_id>"
```

最初に確認してください。再現できなかった設定、特にNULLのままの**認証フック**と、**1回だけ表示するWebhookシークレット**を通知します。

<span id="2-fill-in-the-remaining-function-env-vars"></span>

### 2. 関数の環境変数を埋める

事前確認のuser_requiredで、複製時に渡さなかったキーは空です。公開時ではなく実行時に失敗します。

```
manage_function action: "update_env"
  app_id: "<your_new_app_id>"
  function_name: "send-invite"
  env: { "RESEND_API_KEY": "re_..." }
```

ダッシュボードのApp → Functions → 関数 → Environmentでも設定できます。

ジョブのunfilled_env_varsか、各関数のmanage_function getで不足を確認します。

<span id="3-re-set-durable-object-env-vars"></span>

### 3. DOの環境変数を再設定

DOの値は引き継ぎません。自動設定の規約キー以外を再設定します。

```
manage_durable_objects action: "set_env"
  app_id: "<your_new_app_id>"
  name: "<do_class_name>"
  key: "OPENAI_API_KEY"
  value: "sk-..."
```

1回に1キーを設定し、各キーで繰り返します。list_envで名前を確認できます。

<span id="4-add-your-own-oauth-client-credentials"></span>

### 4. 自分のOAuth認証情報を設定

一覧とリダイレクトURLはコピーしますが、client id／secretはコピーしません。各プロバイダーに自分のアプリを登録して設定します。

```
manage_oauth action: "configure"
  app_id: "<your_new_app_id>"
  provider: "google"
  client_id: "..."
  client_secret: "..."
  redirect_uris: ["https://api.butterbase.ai/auth/<your_new_app_id>/oauth/google/callback"]
```

リダイレクト先を**自分のドメイン**へ変更してください。コピーした値は元のドメインです。[認証](/ja/core-concepts/authentication/)を参照してください。

<span id="5-rebind-the-auth-hook-if-the-warning-said-so"></span>

### 5. 警告があれば認証フックを再接続

接続できなかった警告がある場合、関数の用意が済んだら設定します。

```
manage_auth_config action: "configure_auth_hook", app_id: "<app_id>", post_auth_function: "<fn>"
```

<span id="6-add-ai-keys-if-the-template-uses-ai"></span>

### 6. AIキーを設定

既定モデルは引き継ぎますがBYOKキーは引き継ぎません。Butterbaseクレジットを使うか、自分のキーを設定します。

```
manage_ai action: "update_config", app_id: "<app_id>", config: { byokKey: "sk-ant-..." }
```

[AI連携](/ja/core-concepts/ai-integration/)を参照してください。

<span id="7-update-cors-for-your-frontend"></span>

### 7. CORSを変更

allowed_originsは元のドメインなので置き換えます。

```
manage_app action: "update_cors"
  app_id: "<app_id>"
  allowed_origins: ["https://myapp.com", "http://localhost:5173"]
```

<span id="8-check-the-frontend"></span>

### 8. フロントエンドを確認

通常、複製後は**フロントエンドも公開済み**です。元の最新出力のアプリIDを書き換え、新しいバックエンドへ接続します。概要にURLが表示されます。

次の2点に注意してください。

- **未公開の場合。** 元が公開していないか、再作成が失敗しています。複製全体は止めず警告を記録します。自分でビルドして[公開](/ja/core-concepts/frontend-deployment/)してください。
- **元のアプリIDが見つからなかった警告。** 書き換えられず、**元のアプリへ接続している可能性**があります。データを入れる前に自分のビルドを公開してください。

VITE_*／NEXT_PUBLIC_*などのビルド変数は関数とは別で、引き継ぎません。必要な場合は新しいアプリに設定して再公開します。

<span id="9-add-a-custom-domain"></span>

### 9. 独自ドメインを追加

任意で、Launch以上が対象です。[カスタムドメイン](/ja/core-concepts/custom-domains/)を参照してください。

<span id="10-set-up-charging-if-youre-selling"></span>

### 10. 販売用の課金を設定

Stripe Connectは引き継ぎません。ペイウォール、プラン、商品を使う場合は自分のConnectと各データを用意します。[ユーザーへの課金](/ja/core-concepts/billing/)を参照してください。

<span id="11-review-the-security-posture-before-you-go-live"></span>

### 11. 公開前にセキュリティを確認

引き継いだ設定が自分の用途にも安全とは限りません。

- manage_app get_configでアクセスモードを確認。
- 全RLSを確認。[行レベルセキュリティ](/ja/core-concepts/row-level-security/)の診断を参照。
- シードに公開したくない情報がないことを確認。
- デモ用テンプレートでは意図的に許可範囲が広い場合があります。

<span id="12-bind-your-local-checkout"></span>

### 12. ローカルの作業先を接続

ダッシュボードかMCPで複製して、ローカルでも編集する場合：

```bash
butterbase repo init <your_new_app_id>
butterbase repo pull
```

CLIのbutterbase cloneはこの設定も行います。

<span id="verifying-the-clone-works"></span>

## 動作確認

1. manage_schema getで必要なテーブルを確認。
2. シード対象にselect_rowsしてデータを確認。
3. 全関数をinvoke_functionで確認。500は多くの場合、環境変数不足。
4. 認証でテストユーザーを登録。
5. フロントエンドを公開し、主な操作を実行。

:::caution
statusがerrorでも、後の公開で解消済みの場合があります。状態を判断する前に関数を呼んでください。
:::
