# Todoのバックエンド設定

[English](BUTTERBASE_SETUP.md) | 日本語

原文に記録されたMCP設定手順です。原文のapp_id `app_14obgf28uzwa`と`http://api.butterbase.local/v1/app_14obgf28uzwa`は、その環境の結果です。自分の`init_app`が返す値へ置き換えます。

## 1. アプリを作成

`init_app`へ`name: "todo-2026-04-02"`を渡します。返されたapp_idを以降の呼び出しと`VITE_APP_ID`へ設定します。

## 2. スキーマを適用

`manage_schema`へ`action: "apply"`・app_id・[スキーマJSON](docs/ja/schema.md)を渡します。`todos`テーブルと2つのindexを作ります。

## 3. RLS

`manage_rls`へ`action: "create_user_isolation"`、app_id、`table_name: "todos"`、`user_column: "user_id"`を渡します。

RLSを有効にし、自分の行だけを取得するpolicyと、INSERT時にuser_idを自動設定するtriggerを作ります。独自policyでは`enable`と`create_policy`を使います。

## 4. CORS

フロントエンドoriginの`http://localhost:5173`を許可します。原文のSQLは次のとおりです。アプリID・originは自分の環境へ合わせます。

```sql
UPDATE apps SET allowed_origins = ARRAY['http://localhost:5173'] WHERE id = 'app_14obgf28uzwa';
```

エンドポイントは[APIと動作確認](docs/ja/api-and-test.md)を参照してください。ストレージ削除は`DELETE /storage/{app_id}/{object_id}`です。
