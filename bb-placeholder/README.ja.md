# bb-placeholder

[English](README.md) | 日本語

`bb-frontends`のdispatch namespaceへ、スクリプト名`__placeholder__`で一度デプロイする共有Workerです。実際のフロントエンドをまだ配置していない、新規WfPアプリの初期表示ページを配信します。

## 表示言語

既定は英語です。ページの「日本語」リンクまたは`?lang=ja`で日本語へ切り替え、`?lang=en`で英語へ戻します。未対応の値は英語になります。言語はURLで指定し、Cookieは使いません。

アプリの識別子・API URL・コード例は両言語で共通です。このWorkerにはapp_idが渡らないため、API例の`<your-app-id>`は実際のIDへ置き換えてください。

## デプロイ

```bash
cd bb-placeholder
npx wrangler deploy --dispatch-namespace bb-frontends
```

`wrangler.json`にdispatch namespaceの設定がないため、CLI flagが必要です。リポジトリはWrangler 4.xを使いますが、ここで`dispatch_namespace`設定キーを使えるかは原文でも未検証です。

`index.js`を変更したときは再デプロイします。

## 構成

- `init_app`（backend=wfp）がKVへ`sub:{subdomain} → __placeholder__`を保存します。
- `dispatch-worker/`がKVを読み、`env.DISPATCHER.get(scriptName).fetch(request)`を呼びます。
- このWorkerがHostヘッダーからサブドメインを取得し、初期表示ページを描画します。
- 最初の実フロントエンドのデプロイでKVの参照先が実際の`app.id`へ変わり、このWorkerはそのサブドメインへ応答しなくなります。

## ローカルの確認

リポジトリのルートで`node --test bb-placeholder/index.test.mjs`を実行します。英語・日本語の返却、言語のfallback、ホスト表示と共通コード例を確認します。
