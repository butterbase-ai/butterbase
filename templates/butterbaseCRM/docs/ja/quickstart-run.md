# 前提・コード取得・起動

[クイックスタート](../../QUICKSTART.ja.md) · [英語の原文](../../QUICKSTART.md#1-prerequisites)

## 前提

原文の前提はNode.js 20以上、npm 10以上、Butterbase CLI 0.5以上です。現在のフロントエンドのViteが要求するNode.jsバージョンも満たしてください。`node -v`・`npm -v`・`butterbase --version`で確認します。

バックエンドを読む・変更する場合は、対象アプリへのアクセス、`BUTTERBASE_API_KEY`、同期用の`jq`・`curl`が必要です。キーはシェルかルートの`.env`へ設定します。既存バックエンドへのフロントエンド接続だけなら、バックエンド用ツールは不要です。

## アプリとコードを取得する

CLIで新しいアプリを複製します。スキーマ・RLS・関数・設定をコピーし、コードをローカルへ取得します。

```bash
butterbase clone app_44zjayftl7b3 butterbaseCRM
# Optional flags:
#   --name "My CRM"        Name for the new app (default: "Clone of app_44zjayftl7b3")
#   --region us-east-1     Region for the new app (default: source's region)
cd butterbaseCRM
```

AIエージェントのMCPから複製する場合は、処理IDをポーリングし、`ready`で新しいアプリIDを取得します。

```
manage_app  action=clone  source_app_id=app_44zjayftl7b3  name="My CRM"
# returns { job_id }; poll with:
manage_app  action=get_clone_job  job_id=<id>
# when status=ready, returns { dest_app_id }
```

取得したアプリへフォルダーを紐づけ、コードを取得します。

```bash
butterbase init --app <dest_app_id>        # bind the folder to the new app
butterbase repo pull                       # download the snapshot into this folder
```

既にアプリがある場合は、複製せず紐づけと取得だけを行います。

```bash
mkdir butterbaseCRM && cd butterbaseCRM
butterbase init --app <your_app_id>        # bind to an existing app
butterbase repo pull                       # download the latest snapshot
```

原文の「3通り」は、複製方法と既存アプリのコード取得を含みます。`repo pull`だけでは新しいアプリを作りません。

```bash
cd frontend
npm install
```

## 共有バックエンドへ接続する

自分の複製を使う場合は、ここを省き[複製後の設定](quickstart-clone.md)へ進みます。

```bash
# frontend/.env.local
VITE_BUTTERBASE_APP_ID=app_44zjayftl7b3
VITE_BUTTERBASE_API_URL=https://api.butterbase.ai
```

API URLへアプリIDを付けないでください。SDKが`/v1/<app_id>`・`/auth/<app_id>`・`/storage/<app_id>`を追加します。

## 起動

```bash
npm run dev
```

Viteが表示したURL（通常`http://localhost:5173`）を開きます。設定済みのGoogle OAuthか、メール・パスワードで登録・ログインします。初回はワークスペースを作成・選択します。メンバー資格がないデータはRLSで隠します。
