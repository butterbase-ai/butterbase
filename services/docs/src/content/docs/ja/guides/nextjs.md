---
title: Next.js
description: TypeScript SDKを使い、Butterbaseと連携するNext.jsアプリを作ります。
---

TypeScript SDKを使い、Butterbaseと連携するNext.jsアプリを作ります。

<span id="setup"></span>

## セットアップ

```bash
npx create-next-app@latest my-app --typescript --app
cd my-app
npm install @butterbase/sdk
```

クライアントを作成します。

```typescript
// src/lib/butterbase.ts
import { createClient } from '@butterbase/sdk';
export const butterbase = createClient({
  appId: process.env.NEXT_PUBLIC_BUTTERBASE_APP_ID!,
  apiUrl: process.env.NEXT_PUBLIC_BUTTERBASE_API_URL!,
});
```

環境変数（`.env.local`）：

```
NEXT_PUBLIC_BUTTERBASE_APP_ID=app_abc123
NEXT_PUBLIC_BUTTERBASE_API_URL=https://api.butterbase.ai
```

<span id="static-export-for-deployment"></span>

## デプロイ用の静的エクスポート

`next.config.js`に追加します。

```js
/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
};
module.exports = nextConfig;
```

ビルドしてデプロイします。

```bash
npm run build
cd out && zip -r ../frontend.zip .
```

`framework: "nextjs-static"`でデプロイしてください。
