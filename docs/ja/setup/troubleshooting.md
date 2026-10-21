# 問題の切り分けと追加連携

[導入ガイド](../../../SETUP.ja.md) · [前：開発](./development.md)

## よくある起動・認証の問題

| 症状 | 確認・対応 |
|---|---|
| `Missing KV_REDIS_URL_US_EAST_1` で終了する | `BUTTERBASE_REGIONS` の各リージョンにRedis URLがあるか確認する。Composeでは `docker compose -f docker-compose.local.yml up -d control-api` で環境変数を反映する。ホストでは `KV_REDIS_URL_US_EAST_1=redis://localhost:6379` を設定する |
| `/init` や `/apps` が401 / `User not found` | マイグレーション後に `npm run seed:dev` を実行し、開発所有者の `platform_users` 行を登録する |
| `/init` や `/apps` がDBエラー | マイグレーションを実行し、`docker compose -f docker-compose.local.yml ps` でDBの状態を確認する |
| `up` 後にControl APIが不健康 | KV設定、DBの準備、LocalStackの起動を確認する。下のコマンドでログを見る |
| JWT / APIキーが無効 | 認証有効時のCognito pool / client IDを環境変数と合わせる。APIキーは作成時に一度だけ表示され、失効済みのキーは401を返す |

```bash
docker compose -f docker-compose.local.yml logs control-api --tail 100
```

## 全データを初期化する

次の操作はボリューム内のデータを削除します。削除する環境を確認し、必要なデータを保存してから実行してください。

```bash
docker compose -f docker-compose.local.yml down -v
docker compose -f docker-compose.local.yml up -d
```

再起動後に [マイグレーションと開発ユーザー登録](./database.md)を繰り返します。

## ブラウザーからアップロードできない

署名付きURLはブラウザーが接続できるホスト名を使う必要があります。ローカルComposeは `S3_PUBLIC_ENDPOINT=http://localhost:4566` を設定します。別の端末から使う場合は公開LocalStack / R2のアドレスに合わせ、バケットのCORSも設定してください。

## NeonなどのDB権限エラー

アプリDBの所有者権限が必要なDDLには、プール接続先ではなく直接接続先を使います。PG 15以上でプロビジョニングがスキーマ権限の設定を省いていた場合は、必要な権限を付けます。

```sql
GRANT ALL ON SCHEMA public TO butterbase;
```

アプリ別マイグレーションを後から適用する例です。

```bash
CONTROL_DB_URL=postgresql://... npx tsx scripts/backfill-migrations.ts app_abc123
```

## 任意の外部連携

`.env.example` に設定名があります。OSS版のAI上流アダプターや課金プロバイダーは、[README.ja.md](../../../README.ja.md)と [貢献ルール](../../../CONTRIBUTING.ja.md)の範囲に従って接続します。

| 機能 | 環境変数など |
|---|---|
| OpenRouterによるAI | `OPENROUTER_API_KEY`、`AI_MARKUP_PERCENT` |
| AWS / R2ストレージ | `AWS_*`、`S3_*`。LocalStack用接続先を外す |
| SESによるメール | `SES_*`、`SES_FROM_EMAIL` |
| Stripeの課金 | `STRIPE_*`。OSSのローカル構成では課金プロバイダーは何もしない |
| Cloudflare WfPへのデプロイ | `CLOUDFLARE_DISPATCH_*`、`DEPLOYMENT_DEFAULT_BACKEND` |

OSS版では `No cloud overlays found, running in OSS mode (Noop billing, Unlimited quotas)` とログに出ます。

## 次に試すこと

- [Examples](../../../Examples)を調べ、[CLI](../../../packages/cli/README.md)でデプロイする。
- [TypeScript SDK](../../../packages/sdk/README.md)を使う。
- MCPサーバー、または `services/mcp-server/src/docs/user-documentation.ts` でツールの文書を読む。
- 実運用前に [セキュリティ方針](../../../SECURITY.ja.md)を確認する。

解決しない場合は [Bug report](https://github.com/butterbase-ai/butterbase/issues/new?template=bug.yml)へ、`docker compose ps` の結果と関連ログを添えて報告してください。ログにキーや認証付きURLが含まれていないか確認します。
