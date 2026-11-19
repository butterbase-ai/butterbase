# Butter Support — フロントエンド

[English](README.md) | 日本語

Vite・React・TypeScriptのプロジェクトから、サポートチーム向けの管理画面SPAと、顧客サイト向けの単一ファイルIIFEウィジェットを生成します。

## セットアップ

```bash
cd frontend
cp .env.example .env.local
npm install
npm run dev          # http://localhost:5173
```

ビルド時に`VITE_BUTTERBASE_APP_ID`、`VITE_BUTTERBASE_API_URL`、`VITE_BUTTERBASE_SUBDOMAIN`を設定します。例はそれぞれ`app_0ycj4ad7odud`、`https://api.butterbase.ai`、`butter-support`です。導入先の値へ置き換えてください。

## ビルド

```bash
npm run build        # tsc --noEmit + vite build → dist/
npm run zip          # archiver-based zip → ../frontend.zip (forward-slash entries)
npm run deploy       # both
```

`deploy`は`VITE_BUTTERBASE_SUBDOMAIN`と`DEPLOY_APP_ID`が必要です。`dist/`には`index.html`、ハッシュ付きJS/CSSの`assets/`、`widget.js`、SPA用の`_redirects`を出力します。ZIPのエントリはスラッシュ区切りです。

## Butterbaseへの配置

原文の配置コマンド例です。自分のアプリIDとアップロードURLを使います。

```
mcp__butterbase__create_frontend_deployment app_id=app_0ycj4ad7odud framework=react-vite
# → returns { upload_url, deployment_id }
curl -X PUT "<upload_url>" -H "Content-Type: application/zip" --data-binary @frontend.zip
mcp__butterbase__manage_frontend action=start_deployment deployment_id=<id>
mcp__butterbase__manage_frontend action=set_env vars='{"VITE_BUTTERBASE_APP_ID":"app_0ycj4ad7odud", ...}'
```

配置後、オーナーが`manage_app update_cors`にサブドメインを登録します。

## 埋め込みと言語

```html
<script async src="https://butter-support.butterbase.dev/widget.js" data-app-id="app_0ycj4ad7odud"></script>
```

ウィジェットはアプリIDから匿名の訪問者トークンを生成します。サーバー側の署名は不要です。`window.ButterSupport.identify({ user_id, email, name })`、または読み込み前の`window.ButterSupport.q`でユーザー情報を追加できます。これはクライアントの自己申告で、署名を検証しません。

言語欄は初期状態でEnglishです。「日本語」を選ぶとブラウザーに保存します。`data-lang="ja"`は未選択時の初期値で、保存済み選択を上書きしません。ウィジェットだけに`lang`を付け、ホストページの言語は変更しません。切り替えても入力は保持します。

## ローカル確認と構成

`npm run dev`、または`npm run build && npm run preview`の後に`test-widget.html`を開きます。有効な`data-app-id`を使う環境でAPIの動作を確認してください。

`src/console/`はReact Router v7・React Query v5・Tailwind v3・SDKを使います。`src/widget/`はSDKを使わず、`fetch`で通信します。
