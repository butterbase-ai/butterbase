# React・Deno・型

[SDKの日本語ガイド](../../README.ja.md)

## React

復元されたセッションを確認し、以降の認証イベントを購読します。`useEffect`の終了時に購読を解除します。

```typescript
import { useEffect, useState } from 'react';
import { butterbase } from './lib';

function App() {
  const [user, setUser] = useState(null);

  useEffect(() => {
    // Session is auto-restored — check current state
    const session = butterbase.sessionManager.getSession();
    if (session) setUser(session.user);

    // React to future auth changes
    const { unsubscribe } = butterbase.onAuthStateChange((event, session) => {
      setUser(session?.user ?? null);
    });
    return unsubscribe;
  }, []);
}
```

## Deno

`npm:@butterbase/sdk`から読み込みます。環境変数には利用するアプリとAPIの値を設定します。

```typescript
import { createClient } from 'npm:@butterbase/sdk';

const butterbase = createClient({
  appId: Deno.env.get('BUTTERBASE_APP_ID')!,
  apiUrl: Deno.env.get('BUTTERBASE_API_URL')!,
});

// Use in serverless functions
export async function handler(req: Request, ctx: any) {
  const { data } = await butterbase.from('posts').select('*');
  return Response.json({ data });
}
```

## TypeScript

SDKのメソッドは型付きの`ButterbaseResponse<T>`を返します。クエリへ型を渡すと、取得したデータの型を推論できます。

```typescript
interface Post {
  id: string;
  title: string;
  content: string;
  status: 'draft' | 'published';
}

const { data, error } = await butterbase
  .from<Post>('posts')
  .select('*')
  .eq('status', 'published');

// data is typed as Post[] | null
// error is typed as Error | null
```
