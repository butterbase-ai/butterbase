---
title: Next.js
description: Build Next.js applications with Butterbase using the TypeScript SDK.
---

Build Next.js applications with Butterbase using the TypeScript SDK.

## Setup

```bash
npx create-next-app@latest my-app --typescript --app
cd my-app
npm install @butterbase/sdk
```

Create client:

```typescript
// src/lib/butterbase.ts
import { createClient } from '@butterbase/sdk';
export const butterbase = createClient({
  appId: process.env.NEXT_PUBLIC_BUTTERBASE_APP_ID!,
  apiUrl: process.env.NEXT_PUBLIC_BUTTERBASE_API_URL!,
});
```

Environment variables (`.env.local`):

```
NEXT_PUBLIC_BUTTERBASE_APP_ID=app_abc123
NEXT_PUBLIC_BUTTERBASE_API_URL=https://api.butterbase.ai
```

## Static export for deployment

Add to `next.config.js`:

```js
/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
};
module.exports = nextConfig;
```

Build and deploy:

```bash
npm run build
cd out && zip -r ../frontend.zip .
```

Deploy with `framework: "nextjs-static"`.
