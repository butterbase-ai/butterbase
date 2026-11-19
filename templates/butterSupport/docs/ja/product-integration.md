# 製品データと操作の接続

[日本語README](../../README.ja.md) · [英語の原文](../../README.md#deep-tier-incremental--opt-in-when-ready)

拡張構成には、主製品アプリからsubstrateへシグナルを投影する実装が必要です。操作ハンドラーの追加は任意です。基本構成だけでも利用できます。

## substrateを共有する

主製品アプリで次を実行します。

```bash
butterbase apps link-substrate <main_app_id>
```

サポートアプリと主製品が同じエンティティグラフを参照できるようになります。

## シグナルを投影する

| シグナル | 投影方法 | 用途 |
|---|---|---|
| 人・会社 | `ctx.substrate.propose('upsert_entity', {type:'person', canonical_keys:{email}, attrs:{plan, mrr_usd, is_trial, …}})` | 顧客の識別とアカウント状態。機密フィールドは`{_internal_only: true}`を指定 |
| 認証失敗 | `ctx.substrate.propose('upsert_source_artifact', {kind:'failed_auth_event', content, related_entity_ids:[…]})` | ログイン失敗の診断 |
| 決済失敗 | `kind: 'failed_payment'` | 更新・請求失敗の診断 |
| Webhook失敗 | `kind: 'webhook_failure'` | 外部連携の障害診断 |
| 製品イベント | `kind: 'product_event'`（サンプリング） | 最近の操作状況 |

投影は応答を待たずに送る方式です。サポートエージェントは問い合わせの連絡先からエンティティを自動作成せず、製品アプリが投影した情報を読みます。

## 操作を有効にする

管理画面のSettings → Action capabilitiesで設定します。

| 能力 | 有効にする条件 | 製品側の実装 |
|---|---|---|
| `support.resend_verification_email` | メール確認を使う | 認証メールを再送するAPI |
| `support.retry_failed_webhook` | Webhookを送る | キューからの再送 |
| `support.flag_as_bug` | 不具合管理を使う | Linear・GitHubなどへの登録 |
| `support.apply_account_credit` | 顧客へ課金する | クレジット付与API。常に承認が必要で、上書き不可 |

有効にすると、1度だけ表示する署名用シークレットと、製品アプリへ追加するアダプターが表示されます。登録にCLIコマンドはなく、substrate REST APIの`PUT /v1/me/substrate/outbox-targets/<capability>`を使います。

   ```
   { "webhook_url": "https://<your-main-app>.butterbase.dev/fn/support-resend-verification",
     "signing_secret": "<from console>" }
   ```

署名用シークレットをコードやリポジトリへ書かないでください。outboxの受信側でHMACと冪等性を扱います。
