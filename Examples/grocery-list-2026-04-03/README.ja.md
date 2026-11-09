# 買い物リストのサンプル

[English](README.md) | 日本語

ButterbaseをバックエンドにしたVite・React・TypeScriptのアプリです。認証・RLS・Auto-API・任意の写真と、関数経由のレシピチャットを使います。OpenAIキーは関数へ設定し、ブラウザーへ渡しません。

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
cd Examples/grocery-list-2026-04-03/frontend
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

`http://localhost:5173`を開きます。レシピのAPIキーなどはfrontendの環境変数やコミットへ含めないでください。

## 表示言語と操作

既定は英語です。各画面の「Display language」で日本語を選べます。選択はブラウザーへ保存し、入力途中のフォームやチャットを保って切り替えます。利用者の投稿やサーバーのメッセージはそのまま表示します。

商品名・メモ・任意の写真を追加し、購入済みへの切り替え・削除ができます。レシピアシスタントへ献立・追加食材・レシピを相談でき、現在の購入済み・未購入リストをもとに回答します。

## 構成・API・確認

[APIと動作確認](docs/ja/api-and-test.md)に構成・エンドポイント・手動確認・トラブル対応をまとめています。

サーバー関数は[functions/grocery-recipe-chat.ts](functions/grocery-recipe-chat.ts)です。利用には関数の`OPENAI_API_KEY`設定が必要で、OpenAI利用料はそのキーへ請求されます。


日本語表示の確認は、リポジトリのルートで`node --test Examples/localization.test.mjs`を実行します。
