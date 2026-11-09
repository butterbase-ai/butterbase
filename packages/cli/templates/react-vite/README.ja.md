# {{PROJECT_NAME}}

[English](README.md) | 日本語

Butterbaseを使うReactアプリです。

## セットアップ

1. 依存関係をインストールします。

```bash
npm install
```

2. `.env.example`をコピーして設定します。

```bash
cp .env.example .env
```

3. 開発サーバーを起動します。

```bash
npm run dev
```

## Butterbaseの設定

接続するアプリは`{{APP_ID}}`です。認証を含むAPI URLは`{{API_URL}}`です。

## スクリプトと言語

- `npm run dev`：開発サーバーを起動
- `npm run build`：本番向けにビルド
- `npm run preview`：本番ビルドをローカルで確認

画面の言語欄で「日本語」を選べます。初期値は英語で、選択はブラウザーに保存します。切り替えてもフォームの入力値は保持します。メール・パスワード・APIの送信値やサーバーのエラーは翻訳しません。

## 関連資料

- [Butterbase](https://docs.butterbase.ai)
- [React](https://react.dev)
- [Vite](https://vitejs.dev)
