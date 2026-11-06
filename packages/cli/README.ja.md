# @butterbase/cli 日本語ガイド

[English](README.md) | 日本語

Butterbaseのプロジェクト作成とバックエンド管理を行うCLIです。

## 表示言語

`--lang ja` または `BUTTERBASE_LANG=ja` で、ヘルプ・入力案内・進捗・結果表示を日本語にできます。指定がなければ英語を使い、`--lang` を環境変数より優先します。

```bash
butterbase --lang ja --help
butterbase functions deploy --lang ja --help
BUTTERBASE_LANG=ja butterbase apps list
butterbase --lang en --help
```

コマンド名・オプション名・APIの値・JSON・関数のソースコードはそのままです。利用者が入力した文言や、バックエンド・外部ツールのメッセージも保持します。

## インストール

```bash
npm install -g @butterbase/cli
```


## クイックスタート

```bash
# Login with your API key
butterbase login

# Create a new app
butterbase apps create my-app

# Set as current app
butterbase apps use app_abc123

# Get current schema
butterbase schema get --output schema.json

# Apply schema changes
butterbase schema apply schema.json

# Deploy a function
butterbase functions deploy ./functions/hello.ts

# Upload a file
butterbase storage upload ./image.png
```

## コマンドと使い方

- [認証・アプリ・スキーマ](docs/ja/basic.md)
- [関数・ファイル保存・AI](docs/ja/runtime.md)
- [アプリの運用：リージョン移行・課金・RLS](docs/ja/operations.md)
- [共通オプションと設定](docs/ja/configuration.md)
- [一連の操作と複数アプリの使用例](docs/ja/examples.md)
- [外部連携](docs/ja/integrations.md)
- [開発とエラーの表示](docs/ja/development.md)

個別のオプションは `butterbase <command> --help --lang ja` で確認できます。

## ライセンス

Apache-2.0。リポジトリの [LICENSE](https://github.com/butterbase-ai/butterbase/blob/main/LICENSE) を参照してください。
