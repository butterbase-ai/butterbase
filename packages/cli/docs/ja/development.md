# 開発とエラーの表示

[日本語READMEに戻る](../../README.ja.md)

## 開発

```bash
# Install dependencies
npm install

# Build
npm run build

# Test locally
node dist/bin/butterbase.js --help
```


## エラーの表示

CLIのエラーには、`@butterbase/sdk` の `ButterbaseError` を使います。
クラス名・メッセージと、バックエンドの `code`・`status`・`remediation` を表示します。
認証されていない呼び出しの英語表示の例：

```
AuthError: Invalid API key
  code:        AUTH_INVALID_API_KEY
  status:      401
  remediation: Rotate the key with `butterbase keys generate` and update ~/.butterbase/config.json.
```

エラーコードは `@butterbase/shared` の `ErrorCodes` で定義しています。
一覧はSDKのREADMEを参照してください。


## ライセンス

Apache-2.0
