# ローカル開発

[日本語README](../../README.ja.md)

## 方法1：ホストのNodeでMiniflareを起動

```
npm run dev:serve
```

`http://localhost:8787`で`./local-assets/`を配信します。

| 環境変数 | 既定値 | 用途 |
|---|---|---|
| `LOCAL_FRONTEND_ASSETS_DIR` | `./local-assets` | 配信するdistのパス |
| `LOCAL_FRONTEND_PORT` | `8787` | ポート |
| `LOCAL_FRONTEND_HOST` | `0.0.0.0` | localhostのみにする場合は`127.0.0.1` |
| `LOCAL_FRONTEND_HTML_HANDLING` | `none` | 本番と同じ処理 |

次のリクエストでトップ・SPAの深いパス・`about.html`への解決を確認します。

```
curl -sI http://localhost:8787/                  # 200 + text/html (home)
curl -sI http://localhost:8787/some/deep/route   # 200 + text/html (SPA fallback)
curl -sI http://localhost:8787/about             # 200 + text/html (resolves /about.html)
```

## 方法2：管理プラットフォーム側のCompose

管理プラットフォームの親モノレポには`docker-compose.local.yml`の`miniflare-frontend`サービスがあります。Dockerfileのbuild contextも親モノレポのルートです。**このOSSリポジトリのComposeには含まれないため、OSSでは方法1を使います。**

```
docker compose -f docker-compose.local.yml up -d miniflare-frontend
curl -sI http://localhost:8787/                  # same probes as above
```

サンプルの代わりに自分のSPAの`dist/`を配信する例です。

```
docker compose -f docker-compose.local.yml run --rm \
  -v "$(pwd)/path/to/your/dist:/app/local-assets" \
  -p 8787:8787 \
  miniflare-frontend
```

コンテナーは`node:22-slim`を使います。workerdはglibcへリンクしており、muslを使うAlpineでは`symbol not found`で動かないためです。
