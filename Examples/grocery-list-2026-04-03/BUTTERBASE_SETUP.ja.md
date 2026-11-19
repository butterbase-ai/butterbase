# 買い物リストのバックエンド設定

[English](BUTTERBASE_SETUP.md) | 日本語

原文の環境のapp_idは`app_xcycntxmff44`、API例は`http://api.butterbase.local/v1/app_xcycntxmff44`です。自分の`init_app`の結果を全routeと`VITE_APP_ID`へ設定します。

## 1. アプリを作成

`init_app`へ`name: "grocery-list-2026-04-03"`を渡します。

## 2. スキーマを適用

`manage_schema`へ`action: "apply"`・app_id・[スキーマJSON](docs/ja/schema.md)を渡します。任意のmigration名は`grocery_items_initial`です。テーブルとindexが作られます。

## 3. RLS

`manage_rls`へ`action: "create_user_isolation"`、app_id、`table_name: "grocery_items"`、`user_column: "user_id"`を渡します。

既存policyがあってエラーになる場合は、`list`で確認します。原文のpolicy名は`grocery_items_user_isolation`です。

## 4. CORS

`manage_app`へ`action: "update_cors"`、app_id、`allowed_origins: ["http://localhost:5173"]`を渡します。開発用port・hostが違えばoriginも変更します。

## 5. レシピアシスタント

MCPの`deploy_function`で[functions/grocery-recipe-chat.ts](functions/grocery-recipe-chat.ts)を配置します。

| パラメーター | 値 |
|---|---|
| `app_id` | 自分のアプリID |
| `name` | `grocery-recipe-chat` |
| `description` | 例：`AI recipe assistant: reads grocery_items, calls OpenAI chat completions` |
| `timeoutMs` | `60000`。LLM呼び出しは既定時間を超える場合があります |
| `memoryLimitMb` | 任意。例：`256` |
| `trigger` | `{ "type": "http", "config": {} }` |
| `code` | 関数ファイルの内容。control-plane validationには`export`と`handler`が必要です |
| `envVars` | `{ "OPENAI_API_KEY": "<your key>" }`。コミットせず、漏洩したら更新します |

原文の呼び出し例は`POST http://localhost/v1/app_xcycntxmff44/fn/grocery-recipe-chat`です。自分のapp_id・gatewayのhost・portへ合わせます。

コードやキーの更新は、同じnameと新しい`code`・`envVars`で`deploy_function`を再実行します。API一覧は[APIと動作確認](docs/ja/api-and-test.md)を参照してください。
