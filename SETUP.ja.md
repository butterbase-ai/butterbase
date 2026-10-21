# Butterbaseのセルフホストとローカル開発

[English](./SETUP.md) · 日本語

このガイドは `docker-compose.local.yml` を使うOSS版の導入手順です。マネージド版のダッシュボードUIはこのリポジトリに含まれていません。

| 必要なツール | バージョン |
|---|---|
| Docker | 新しいDocker DesktopまたはCompose v2対応Engine |
| Node.js | 22以上 |
| npm | 10以上（Node.jsに同梱） |

E2Eテストやアプリ移動のテストでは、必要に応じて `libpq` の `pg_dump` / `psql` も用意します。

## 手順

1. [コードの取得、環境変数、サービス起動](./docs/ja/setup/environment.md)
2. [マイグレーション、開発ユーザー、起動確認](./docs/ja/setup/database.md)
3. [認証とMCPクライアント](./docs/ja/setup/authentication.md)
4. [ホットリロード、ビルド、テスト](./docs/ja/setup/development.md)
5. [問題の切り分けと追加連携](./docs/ja/setup/troubleshooting.md)

ローカル構成は認証を無効にしています。`AUTH_ENABLED=false` のAPIをインターネットへ公開しないでください。実運用の境界は [SECURITY.ja.md](./SECURITY.ja.md)を確認してください。
