# マイグレーションと起動確認

[導入ガイド](../../../SETUP.ja.md) · [前：サービス起動](./environment.md) · [次：認証](./authentication.md)

## DBスキーマを適用する

コンテナの起動時にマイグレーションは自動実行されません。DBが起動している状態で、リポジトリ直下から実行します。

```bash
export NEON_PLATFORM_PRIMARY_URL=postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control
export NEON_RUNTIME_PROJECT_ID_US_EAST_1=postgresql://butterbase:butterbase_dev@localhost:5437/butterbase_runtime_us
export BUTTERBASE_REGIONS=us-east-1
npm run migrate:control
npm run migrate:runtime
# まとめて実行する場合：npm run migrate:all
```

SQLは `db/control-plane/`、`db/runtime-plane/`、`db/data-plane/` にあります。適用先を示すscopeヘッダーを理解せず、`psql` で直接適用しないでください。通常はマイグレーションスクリプトを使います。ボリュームを消して初期化した後は再実行します。

## 開発ユーザーを登録する

ローカルの `AUTH_ENABLED=false` では、認証なしのリクエストを `DEV_OWNER_ID` に割り当てます。既定値は `11111111-1111-1111-1111-111111111111` です。使用量制限の処理も `platform_users` の行を参照するので、空のDBには一度登録が必要です。

```bash
export NEON_PLATFORM_PRIMARY_URL=postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control
npm run seed:dev
```

`dev@butterbase.local` と `dev-admin@butterbase.local` を `playground` プランで登録します。繰り返し実行できます。IDは `DEV_OWNER_ID` / `DEV_ADMIN_USER_ID`、プランは `DEV_SEED_PLAN_ID` で変更できます。

## 起動を確認する

```bash
curl -sf http://localhost:4000/health/ready
curl -sf http://localhost:7133/health
curl -sf -o /dev/null -w "%{http_code}\n" http://localhost:4321/
```

ローカル構成では認証なしでアプリを作成できます。

```bash
curl -X POST http://localhost:4000/init \
  -H "Content-Type: application/json" \
  -d '{"name": "test-app"}'
curl http://localhost:4000/apps
```

次に [認証とMCPクライアント](./authentication.md)を設定します。ローカルで使う上記のDB認証値を、公開環境へ流用しないでください。
