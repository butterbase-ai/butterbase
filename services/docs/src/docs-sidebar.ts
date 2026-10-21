// services/docs/src/docs-sidebar.ts
import type { StarlightUserConfig } from '@astrojs/starlight/types';

export const sidebar: StarlightUserConfig['sidebar'] = [
  {
    label: 'Getting Started', translations: { ja: 'はじめに' },
    items: [
      { label: 'Introduction', translations: { ja: 'Butterbaseについて' }, slug: 'getting-started/introduction' },
      { label: 'Before You Start', translations: { ja: '開発前に確認すること' }, slug: 'getting-started/before-you-start' },
      { label: 'Quickstart', translations: { ja: 'クイックスタート' }, slug: 'getting-started/quickstart' },
      { label: 'Agents Quickstart', translations: { ja: 'エージェント入門' }, slug: 'getting-started/agents-quickstart' },
      { label: 'MCP Setup', translations: { ja: 'MCPの接続' }, slug: 'getting-started/mcp-setup' },
      { label: 'Dashboard', translations: { ja: 'ダッシュボード' }, slug: 'getting-started/dashboard' },
      { label: 'Hackathon', translations: { ja: 'ハッカソン' }, slug: 'hackathon' },
    ],
  },
  {
    label: 'Core Concepts', translations: { ja: '基本機能' },
    items: [
      { label: 'Database & Schema', translations: { ja: 'データベースとスキーマ' }, slug: 'core-concepts/database' },
      { label: 'Regions', translations: { ja: 'リージョン' }, slug: 'core-concepts/regions' },
      { label: 'Authentication', translations: { ja: '認証' }, slug: 'core-concepts/authentication' },
      { label: 'Row-Level Security', translations: { ja: '行レベルセキュリティ' }, slug: 'core-concepts/row-level-security' },
      { label: 'File Storage', translations: { ja: 'ファイル保存' }, slug: 'core-concepts/storage' },
      { label: 'Serverless Functions', translations: { ja: 'サーバーレス関数' }, slug: 'core-concepts/functions' },
      { label: 'Agents', translations: { ja: 'エージェント' }, slug: 'core-concepts/agents' },
      { label: 'Server-Side Build', translations: { ja: 'サーバー側でのビルド' }, slug: 'core-concepts/server-side-build' },
      { label: 'Frontend Deployment', translations: { ja: 'フロントエンドのデプロイ' }, slug: 'core-concepts/frontend-deployment' },
      { label: 'Preview Deployments', translations: { ja: 'プレビューデプロイ' }, slug: 'core-concepts/preview-deployments' },
      { label: 'Custom Domains', translations: { ja: '独自ドメイン' }, slug: 'core-concepts/custom-domains' },
      { label: 'Durable Objects', translations: { ja: 'Durable Objects' }, slug: 'core-concepts/durable-objects' },
      { label: 'Edge SSR Deployment', translations: { ja: 'Edge SSRのデプロイ' }, slug: 'core-concepts/edge-ssr-deployment' },
      { label: 'AI Integration', translations: { ja: 'AIの利用' }, slug: 'core-concepts/ai-integration' },
      { label: 'AI Meetings', translations: { ja: 'AI会議ボット' }, slug: 'core-concepts/ai-meetings' },
      { label: 'RAG (Native)', translations: { ja: '組み込みRAG' }, slug: 'core-concepts/rag' },
      { label: 'Key-Value Store', translations: { ja: 'キーと値の保存' }, slug: 'core-concepts/kv' },
      { label: 'Realtime', translations: { ja: 'リアルタイム通知' }, slug: 'core-concepts/realtime' },
      { label: 'Substrate', translations: { ja: 'Substrate' }, slug: 'core-concepts/substrate' },
      { label: 'Charging Your Users', translations: { ja: '利用者への課金' }, slug: 'core-concepts/billing' },
      { label: 'Plans & Usage', translations: { ja: 'プランと使用量' }, slug: 'core-concepts/plans-and-usage' },
      { label: 'Integrations', translations: { ja: '外部連携' }, slug: 'core-concepts/integrations' },
    ],
  },
  {
    label: 'Templates', translations: { ja: 'テンプレート' },
    items: [
      { label: 'Overview', translations: { ja: '概要' }, slug: 'templates' },
      { label: 'Available Templates', translations: { ja: '利用できるテンプレート' }, slug: 'templates/available' },
      { label: 'Butterbase CRM', translations: { ja: 'Butterbase CRM' }, slug: 'templates/butterbase-crm' },
      { label: 'Butter Support', translations: { ja: 'Butter Support' }, slug: 'templates/butter-support' },
      { label: 'Cloning a Template', translations: { ja: 'テンプレートの複製' }, slug: 'templates/cloning' },
      { label: 'Configuring Your Clone', translations: { ja: '複製後の設定' }, slug: 'templates/configure' },
      { label: 'Publishing a Template', translations: { ja: 'テンプレートの公開' }, slug: 'templates/publishing' },
    ],
  },
  {
    label: 'SDKs & Tools', translations: { ja: 'SDKとツール' },
    items: [
      { label: 'TypeScript SDK', translations: { ja: 'TypeScript SDK' }, slug: 'sdks-and-tools/typescript-sdk' },
      { label: 'CLI', translations: { ja: 'CLI' }, slug: 'sdks-and-tools/cli' },
      { label: 'CLI: bb repo', translations: { ja: 'CLI：bb repo' }, slug: 'cli/repo' },
      { label: 'CLI: bb substrate', translations: { ja: 'CLI：bb substrate' }, slug: 'cli/substrate' },
      { label: 'Claude Code Plugin', translations: { ja: 'Claude Codeプラグイン' }, slug: 'sdks-and-tools/plugin' },
      { label: 'REST API', translations: { ja: 'REST API' }, slug: 'sdks-and-tools/rest-api' },
    ],
  },
  {
    label: 'Guides', translations: { ja: '実装ガイド' },
    items: [
      { label: 'React', translations: { ja: 'React' }, slug: 'guides/react' },
      { label: 'Next.js', translations: { ja: 'Next.js' }, slug: 'guides/nextjs' },
      { label: 'Monetization', translations: { ja: '収益化' }, slug: 'guides/monetization' },
      { label: 'Lead Finder', translations: { ja: '見込み客の検索' }, slug: 'guides/lead-finder' },
      { label: 'KV Recipes', translations: { ja: 'KVの使い方' }, slug: 'guides/kv-recipes' },
    ],
  },
  {
    label: 'API Reference', translations: { ja: 'APIリファレンス' },
    autogenerate: { directory: 'api-reference' },
  },
  {
    label: 'Reference', translations: { ja: 'リファレンス' },
    items: [
      { label: 'Error Reference', translations: { ja: 'エラー一覧' }, slug: 'errors' },
    ],
  },
];
