# butterbaseCRM — クイックスタート

[English](QUICKSTART.md) | 日本語

Butterbase上で動く共同利用のCRMです。会社・連絡先・商談・メモ・会議・活動を扱います。

この文書の「複製」はButterbaseアプリの複製です。MCPの`manage_app action=clone`または`butterbase clone`で、スキーマ・RLS・関数・認証・ストレージ・realtime・AI設定・コードのスナップショットを、新しいアプリへコピーします。元アプリは変更せず、自分のDB・URL・APIキーとローカルのコードを取得します。

## 手順を選ぶ

- 既存の共有バックエンドへ接続する：導入と共有接続を行い、複製後の設定は省略します。共有アプリへのアクセス資格が必要です。
- 自分のアプリを持つ：Butterbaseアプリを複製し、共有接続の代わりに複製後の設定を行います。

## 手順の一覧

1. [前提・コード取得・起動](docs/ja/quickstart-run.md)
2. [複製後の環境変数・OAuth・接続](docs/ja/quickstart-clone.md)
3. [ファイル構成・変更する場所・コマンド](docs/ja/quickstart-development.md)
4. [コードのスナップショット同期](docs/ja/repo-sync.md)
5. [作業例・構成・問題の切り分け](docs/ja/quickstart-reference.md)

## 日本語表示

ログイン画面とアプリ上部の言語欄で「日本語」を選びます。初期値は英語です。選択はブラウザーに保存し、入力途中の値は切り替え時も保持します。顧客が入力した文面・名前、API識別子・送信値、サーバー側のエラーは翻訳しません。

## 次に読む資料

- [製品の構想](docs/butterbase/01-idea.md)
- [データ構造・RLS・関数の設計](docs/butterbase/02-plan.md)
- [日本語バックエンドREADME](backend/README.ja.md)
- `frontend/src/pages/`の各画面

原文の関数数・モデル・スナップショットは設計記録です。実環境で使う設定は、接続先の出力と現行のJSONを確認してください。
