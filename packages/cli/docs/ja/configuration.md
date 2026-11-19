# 共通オプションと設定

[日本語READMEに戻る](../../README.ja.md)

## 共通オプション

多くのコマンドでは `--app` でアプリIDを指定できます。

```bash
butterbase schema get --app app_abc123
butterbase functions list --app app_abc123
butterbase storage list --app app_abc123
```

`--app` を省略すると、`butterbase apps use` で設定した現在のアプリを使います。


## 設定

CLIの設定は次の2か所に保存します。

1. **全体の設定**：`~/.butterbase/config.json`
   - APIキー
   - 既定のエンドポイント
   - 現在のアプリ

2. **プロジェクトの設定**：プロジェクト内の `.butterbase/config.json`
   - アプリID
   - エンドポイントの上書き

プロジェクトの設定を、全体の設定より優先します。


## 環境変数

表示言語は `BUTTERBASE_LANG=en|ja` で設定します。`--lang` の指定を優先します。

APIキーとエンドポイントは、上記の設定ファイルから読み取ります。`BUTTERBASE_API_KEY` は `butterbase plugin setup` / `butterbase mcp install` が生成するMCPクライアント設定で使います（`Authorization: Bearer ${BUTTERBASE_API_KEY}`）。`butterbase integrations configure|rotate` は、省略した認証情報を `<TOOLKIT>_CLIENT_ID` / `<TOOLKIT>_CLIENT_SECRET` の環境変数から読み取ることもできます。
