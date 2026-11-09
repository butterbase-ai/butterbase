# APIと動作確認

[買い物リストの日本語README](../../README.ja.md)

## 構成

Postgresの`grocery_items`テーブル、JWT認証、Auto-API、ストレージ、利用者を分離するRLSを使います。フロントエンドはVite・React Router・`@butterbase/sdk`で認証・データ・ストレージを呼び、Contextで認証状態を管理します。

## エンドポイント

以下の`{app_id}`は自分の`init_app`の結果です。Todo原文の`todo-2026-04-02`というURL例はプレースホルダーで、実際のIDではありません。ベースURLは`VITE_API_BASE_URL`の値です。Todo原文の例は`http://localhost:4000`、買い物リストは`http://localhost`なので、自分の公開経路へ合わせます。

| 対象 | メソッドとパス |
|---|---|
| 登録 | `POST /auth/{app_id}/signup` |
| ログイン | `POST /auth/{app_id}/login` |
| 利用者情報 | `GET /auth/{app_id}/me` |
| 一覧・追加 | `GET`・`POST /v1/{app_id}/grocery_items` |
| 更新・削除 | `PATCH`・`DELETE /v1/{app_id}/grocery_items/{id}` |
| アップロード | `POST /storage/{app_id}/upload` |
| ダウンロード | `GET /storage/{app_id}/download/{object_id}` |

`image_url`にはURLではなく、アップロード結果のobjectIdを保存します。画面表示時にダウンロードURLを取得します。

## 手動の確認

1. 新しいアカウントで登録・ログインします。
2. 画像のある項目とない項目を作成します。
3. 完了・購入済みを切り替え、項目を削除します。
4. ログアウトして、再度ログインします。
5. 別のアカウントを作り、他利用者のデータが表示されないことを確認します。

## トラブル対応

- **Failed to fetch**：`docker compose -f docker-compose.local.yml ps`でサービスを確認し、`VITE_API_BASE_URL`のgateway・portを照合します。
- **App not found・認証404**：バックエンドを作成済みか、`VITE_APP_ID`が実際のIDかを確認します。
- **CORS**：開発元origin（例：`http://localhost:5173`）を許可します。portを変えたら許可値も変えます。
- **画像の失敗**：10MB以下か、ローカルのストレージ（原文ではLocalStack）が動いているか、browser consoleを確認します。

## レシピ関数

`POST /v1/{app_id}/fn/grocery-recipe-chat`へ、利用者JWTと`{ "messages": [ { "role": "user"|"assistant", "content": "..." } ] }`を渡します。応答は`{ "reply": "..." }`で、Markdownのテキストです。関数はリクエストごとにログイン利用者の`grocery_items`を読み直します。

503の場合は、`OPENAI_API_KEY`を`envVars`に設定して関数を配置・更新します。キーはブラウザーやコミットへ含めません。
