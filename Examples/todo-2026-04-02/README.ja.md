# Todoのサンプル

[English](README.md) | 日本語

ButterbaseをバックエンドにしたVite・React・TypeScriptのアプリです。認証・RLSによる利用者ごとのデータ分離・Auto-API・任意の画像添付を使います。

## 必要な環境

Docker・Docker Compose、ローカルで動くButterbaseが必要です。原文の要件はNode.js 18以上ですが、現在のViteの依存条件に合わせ、Node.js 22.12以上を使います。リポジトリ全体の環境は[SETUP.md](../../SETUP.md)を参照してください。

## 起動

Butterbaseを起動します。

```bash
cd /path/to/butterbase
docker compose -f docker-compose.local.yml up -d
```

[バックエンドの日本語手順](BUTTERBASE_SETUP.ja.md)でMCP・スキーマ・RLS・CORSを設定します。`init_app`が返す自分のapp_idを`frontend/.env`の`VITE_APP_ID`へ設定します。

フロントエンドの依存関係を用意します。

```bash
cd Examples/todo-2026-04-02/frontend
npm install
```

設定例をコピーします。

```bash
cp .env.example .env
```

`VITE_API_BASE_URL`を自分のgatewayのhost・portへ合わせます。末尾のslashは付けません。

```bash
npm run dev
```

`http://localhost:5173`を開きます。

## 表示言語と操作

既定は英語です。各画面の「Display language」で日本語を選べます。選択はブラウザーへ保存し、入力途中のフォームを保って切り替えます。利用者の投稿やサーバーのメッセージはそのまま表示します。

タスクのタイトル・説明・任意の画像を追加し、完了状態の切り替え・削除・検索・書き出しができます。

## 構成・API・確認

[APIと動作確認](docs/ja/api-and-test.md)に構成・エンドポイント・手動確認・トラブル対応をまとめています。

```
frontend/
├── src/
│   ├── pages/          # LoginPage, SignupPage, TodosPage
│   ├── components/     # TodoList, TodoItem, TodoForm, ImageUpload
│   ├── lib/            # butterbase SDK client
│   ├── services/       # auth, functions, storage
│   ├── contexts/       # AuthContext
│   └── types/          # TypeScript definitions
├── package.json
└── vite.config.ts
```


日本語表示の確認は、リポジトリのルートで`node --test Examples/localization.test.mjs`を実行します。
