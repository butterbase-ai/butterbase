// services/docs/src/docs-sidebar.ts
import type { StarlightUserConfig } from '@astrojs/starlight/types';

export const sidebar: StarlightUserConfig['sidebar'] = [
  {
    label: 'Getting Started',
    items: [
      { label: 'Introduction', slug: 'getting-started/introduction' },
      { label: 'Before You Start', slug: 'getting-started/before-you-start' },
      { label: 'Quickstart', slug: 'getting-started/quickstart' },
      { label: 'Agents Quickstart', slug: 'getting-started/agents-quickstart' },
      { label: 'MCP Setup', slug: 'getting-started/mcp-setup' },
      { label: 'Dashboard', slug: 'getting-started/dashboard' },
      { label: 'Hackathon', slug: 'hackathon' },
    ],
  },
  {
    label: 'Core Concepts',
    items: [
      { label: 'Database & Schema', slug: 'core-concepts/database' },
      { label: 'Regions', slug: 'core-concepts/regions' },
      { label: 'Authentication', slug: 'core-concepts/authentication' },
      { label: 'Row-Level Security', slug: 'core-concepts/row-level-security' },
      { label: 'File Storage', slug: 'core-concepts/storage' },
      { label: 'Serverless Functions', slug: 'core-concepts/functions' },
      { label: 'Agents', slug: 'core-concepts/agents' },
      { label: 'Frontend Deployment', slug: 'core-concepts/frontend-deployment' },
      { label: 'Durable Objects', slug: 'core-concepts/durable-objects' },
      { label: 'Edge SSR Deployment', slug: 'core-concepts/edge-ssr-deployment' },
      { label: 'AI Integration', slug: 'core-concepts/ai-integration' },
      { label: 'RAG (Native)', slug: 'core-concepts/rag' },
      { label: 'Key-Value Store', slug: 'core-concepts/kv' },
      { label: 'Realtime', slug: 'core-concepts/realtime' },
      { label: 'Substrate', slug: 'core-concepts/substrate' },
      { label: 'Billing & Plans', slug: 'core-concepts/billing' },
      { label: 'Integrations', slug: 'core-concepts/integrations' },
    ],
  },
  {
    label: 'SDKs & Tools',
    items: [
      { label: 'TypeScript SDK', slug: 'sdks-and-tools/typescript-sdk' },
      { label: 'CLI', slug: 'sdks-and-tools/cli' },
      { label: 'CLI: bb repo', slug: 'cli/repo' },
      { label: 'CLI: bb substrate', slug: 'cli/substrate' },
      { label: 'Claude Code Plugin', slug: 'sdks-and-tools/plugin' },
      { label: 'REST API', slug: 'sdks-and-tools/rest-api' },
    ],
  },
  {
    label: 'Guides',
    items: [
      { label: 'React', slug: 'guides/react' },
      { label: 'Next.js', slug: 'guides/nextjs' },
      { label: 'Monetization', slug: 'guides/monetization' },
      { label: 'KV Recipes', slug: 'guides/kv-recipes' },
      { label: 'Clone from a template', slug: 'guides/clone-from-template' },
    ],
  },
  {
    label: 'API Reference',
    autogenerate: { directory: 'api-reference' },
  },
  {
    label: 'Reference',
    items: [
      { label: 'Error Reference', slug: 'errors' },
    ],
  },
];
