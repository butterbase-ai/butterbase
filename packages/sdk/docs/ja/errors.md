# エラー処理

[SDKの日本語ガイド](../../README.ja.md)

クライアントのメソッドは`{ data, error }`を返します。バックエンドの対応するエラーを受け取ると、`error`は`ButterbaseError`のサブクラスになります。

`AuthError`・`ValidationError`・`NotFoundError`・`QuotaError`・`NetworkError`には、`code`・`status`・`remediation`・`details`が含まれます。

```typescript
import {
  ButterbaseClient, ErrorCodes,
  AuthError, NotFoundError, QuotaError,
} from '@butterbase/sdk';

const r = await client.from('posts').select('*').execute();

if (r.error instanceof NotFoundError) {
  console.error('Missing table:', r.error.remediation);
}
if (r.error?.code === ErrorCodes.AUTH_INVALID_API_KEY) {
  // rotate the key
}
if (r.error instanceof QuotaError) {
  console.error(`Quota hit (${r.error.code}): ${r.error.remediation}`);
}
```

コードの一覧は`@butterbase/shared`から再公開される`ErrorCodes`にあります。独自のfetchラッパーでも同じ型付きエラーを使う場合は、`parseApiError(status, body)`で応答を変換します。
