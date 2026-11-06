---
title: フロントエンドのデプロイ
description: 静的フロントエンドをHTTPS対応のURLへ公開し、世界各地へ配信します。
---

ローカルでビルドした出力をzipにまとめ、Butterbaseから直接アップロード・デプロイします。Cloudflare PagesのURLで公開されます。

フロントエンドはグローバル配信され、特定の[リージョン](/ja/core-concepts/regions/)に固定されません。バックエンドの場所にかかわらず、静的ファイルを利用者の近くから届けます。

<span id="how-it-works"></span>

## 仕組み

1. `create_frontend_deployment`でデプロイIDとアップロードURLを取得
2. ビルド済みフロントエンドをzipでアップロード
3. `manage_frontend`に`action: "start_deployment"`を指定して開始
4. `.pages.dev`のURLで公開

<span id="supported-frameworks"></span>

## 対応フレームワーク

| フレームワーク | 値 | 備考 |
|-----------|-------|-------|
| React（Vite） | `react-vite` | `npm run build`で作る`dist/` |
| Next.js（静的） | `nextjs-static` | `next build && next export`で作る`out/` |
| 静的HTML | `static` | HTML・CSS・JSファイル |
| その他 | `other` | 静的出力を作るフレームワーク |

<span id="deploying-via-mcp"></span>

## MCPでデプロイ

**手順1：デプロイを作成**

```
create_frontend_deployment({ app_id: "app_abc123", framework: "react-vite" })
```

**手順2：zipをアップロード**

```bash
curl -X PUT "{uploadUrl}" \
  -H "Content-Type: application/zip" \
  --data-binary @frontend.zip
```

**手順3：デプロイを開始**

```
manage_frontend({ app_id: "app_abc123", action: "start_deployment", deployment_id: "uuid-1234" })
```

<span id="deployment-statuses"></span>

## デプロイの状態

| ステータス | 意味 |
|--------|---------|
| `WAITING` | 作成済み。zip待ち |
| `UPLOADING` | ファイル処理中 |
| `BUILDING` | デプロイをビルド中 |
| `READY` | 成功。URLを割り当て済み |
| `ERROR` | 失敗。エラーメッセージを確認 |
| `CANCELED` | 中止済み |

:::note
`READY`はCloudflareが受け付けた状態で、エッジへの反映には数分かかる場合があります。更新を案内する前に公開URLへアクセスして確認してください。
:::

<span id="creating-the-zip-file-correctly"></span>

## 正しいzipの作り方

:::caution
Windows Explorerの「圧縮フォルダーに送る」、PowerShellの`Compress-Archive`、`/`区切りを明示しない`ZipFile.CreateFromDirectory`は**使わないでください**。zip内にバックスラッシュのパスができ、Cloudflare Pagesが誤ったMIMEタイプで配信する原因になります。
:::

<span id="recommended-nodejs-archiver"></span>

### 推奨：Node.js archiver

```bash
npm install archiver --save-dev
```

```javascript
// zip-dist.js
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

const output = fs.createWriteStream(path.join(__dirname, 'frontend.zip'));
const archive = archiver('zip', { zlib: { level: 9 } });

output.on('close', () => {
  console.log(`frontend.zip created (${archive.pointer()} bytes)`);
});

archive.on('error', (err) => { throw err; });
archive.pipe(output);
archive.directory('dist/', false);
archive.finalize();
```

<span id="alternative-git-bash--wsl"></span>

### 代替：Git Bash・WSL

```bash
cd dist && zip -r ../frontend.zip .
```

<span id="environment-variables"></span>

## 環境変数

フロントエンドビルドの環境変数を設定します。

```json
PUT /v1/{app_id}/frontend/env

{
  "VITE_API_URL": "https://api.butterbase.ai/v1/app_abc123",
  "VITE_APP_NAME": "My App"
}
```

フレームワークごとの接頭辞：
- **Vite：** `VITE_`（例：`VITE_API_URL`）
- **Next.js：** `NEXT_PUBLIC_`（例：`NEXT_PUBLIC_API_URL`）
- **Create React App：** `REACT_APP_`（例：`REACT_APP_API_URL`）

<span id="spa-routing"></span>

## SPAのルーティング

SPAでは全経路を`index.html`へ向ける`_redirects`を自動で追加します。クライアント側ルーティングをすぐに利用できます。独自の`_redirects`がzipにあれば、その内容を保持します。

<span id="redeployment"></span>

## 再デプロイ

各デプロイはプランの上限まで個別に保持します。不要な古いデプロイは削除してください。

<span id="custom-domains"></span>

## カスタムドメイン

`*.pages.dev`の代わりに`app.example.com`などの独自ホスト名を使え、SSLは自動発行・更新します。**Launch以上**のプランが必要です。

```bash
butterbase domains add app.example.com
butterbase domains status <domain-id>
```

DNS、検証方法、ルートドメイン、問題の対処は[カスタムドメイン](/ja/core-concepts/custom-domains/)を参照してください。

<span id="limits"></span>

## 制限

| 項目 | 値 |
|-------|-------|
| デプロイの最大サイズ | 100 MB（圧縮後） |
| アップロードURLの期限 | 15分 |
| アプリごとのデプロイ数 — Playground | 2 |
| アプリごとのデプロイ数 — Launch | 10 |
| アプリごとのデプロイ数 — Certified | 25 |
| アプリごとのデプロイ数 — Enterprise | 無制限 |
