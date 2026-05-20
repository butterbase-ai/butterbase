// services/docs/src/data/changelog.ts
import type { RoadmapCategory } from './changelog-categories';

export interface RoadmapItem {
  /** ISO date string (YYYY-MM-DD). */
  date: string;
  category: RoadmapCategory;
  /** Short, capitalized feature title. */
  title: string;
  /** 1–2 line public-facing description. No internal jargon. */
  description: string;
  /** Path to the relevant docs page. Optional. */
  href?: string;
  /** Emoji shown on the timeline dot. Optional; defaults to a filled dot. */
  icon?: string;
}

/**
 * Changelog entries. Newest first.
 * To add a new shipped feature, prepend an entry here.
 */
export const changelog: RoadmapItem[] = [
  {
    date: '2026-05-04',
    category: 'compute',
    title: 'Durable Object env vars',
    description: 'Inject encrypted config into Durable Objects with `butterbase do env set/list/unset`. Available as `env.KEY` inside any DO class for the app.',
    href: '/core-concepts/durable-objects#environment-variables',
    icon: '🔐',
  },
  {
    date: '2026-05-04',
    category: 'deploy',
    title: 'Server-Side Build',
    description: 'Push your source — Butterbase runs `npm install` and the framework build in a container. Skip the local `@cloudflare/next-on-pages` toolchain (especially useful on Windows).',
    href: '/core-concepts/server-side-build',
    icon: '🏗️',
  },
  {
    date: '2026-05-03',
    category: 'compute',
    title: 'Durable Objects',
    description: 'Stateful per-key actors with built-in storage and WebSocket support. Build chat rooms, multiplayer games, rate limiters, and long-running AI agents — no infra to run.',
    href: '/core-concepts/durable-objects',
    icon: '🎭',
  },
  {
    date: '2026-05-03',
    category: 'deploy',
    title: 'Edge SSR for Next.js & Remix',
    description: 'Deploy server-rendered Next.js (App Router, Server Actions, RSC) and Remix apps directly to Cloudflare Workers. One CLI command, no Node.js host to run.',
    href: '/core-concepts/edge-ssr-deployment',
    icon: '🌍',
  },
  {
    date: '2026-05-01',
    category: 'integrations',
    title: 'Partner API Proxy',
    description: 'Call third-party APIs from your app without exposing API keys. Butterbase manages key pools, rotation, and failover — your frontend just hits a single proxy route.',
    icon: '🔀',
  },
  {
    date: '2026-05-01',
    category: 'tooling',
    title: 'Partners SDK, CLI & MCP Support',
    description: 'Discover and call partner APIs from the TypeScript SDK (`PartnersClient`), CLI (`butterbase partners list`, `partners curl`), and MCP (`list_partner_apis`).',
    icon: '🤝',
  },
  {
    date: '2026-04-30',
    category: 'ops',
    title: 'Hackathon Submissions & Scoring',
    description: 'Public submission API for hackathons with async judging. Scores evaluate demo URLs and platform feature usage. Leaderboard and rescore endpoints included.',
    href: '/hackathon',
    icon: '🏆',
  },
  {
    date: '2026-04-29',
    category: 'ai',
    title: 'Multimodal Chat Completions',
    description: 'Pass images alongside text in chat completion requests. The AI config API now accepts multimodal message content.',
    href: '/core-concepts/ai-integration',
    icon: '🖼️',
  },
  {
    date: '2026-04-29',
    category: 'ops',
    title: 'Performance Improvements',
    description: 'Faster response times across authentication, quota enforcement, and API key validation — all with no changes required to your app.',
    icon: '⚡',
  },
  {
    date: '2026-04-26',
    category: 'auth',
    title: 'Magic Link Authentication',
    description: "Passwordless sign-in for your app's users. Drop into any auth flow.",
    href: '/core-concepts/authentication',
    icon: '🔑',
  },
  {
    date: '2026-04-26',
    category: 'deploy',
    title: 'Custom Domains',
    description: 'Bring your own domain with automatic HTTPS, configured per app.',
    href: '/core-concepts/frontend-deployment',
    icon: '🌐',
  },
  {
    date: '2026-04-25',
    category: 'auth',
    title: 'Post-Auth Hooks',
    description: 'Run custom logic after a user signs in — provision data, sync to external systems, send a welcome email.',
    href: '/core-concepts/authentication',
    icon: '⚡',
  },
  {
    date: '2026-04-25',
    category: 'functions',
    title: 'Function Logs with Console Capture',
    description: 'Stdout, stderr, and timing surfaced per invocation, viewable in the dashboard.',
    href: '/core-concepts/functions',
    icon: '📝',
  },
  {
    date: '2026-04-25',
    category: 'functions',
    title: 'Function Environment Variables',
    description: 'Per-function secrets and config, encrypted at rest, hot-reloaded on deploy.',
    href: '/core-concepts/functions',
    icon: '🔐',
  },
  {
    date: '2026-04-23',
    category: 'ai',
    title: 'Native RAG',
    description: 'Ingest PDFs, DOCX, TXT, and more. Query with natural language in two API calls. Vector search built in.',
    href: '/core-concepts/rag',
    icon: '📚',
  },
  {
    date: '2026-04-23',
    category: 'integrations',
    title: 'Third-Party Integrations',
    description: 'First-class connectors so your functions can call external services with managed auth.',
    href: '/core-concepts/integrations',
    icon: '🔌',
  },
  {
    date: '2026-04-23',
    category: 'database',
    title: 'Foreign-Key Referential Actions',
    description: 'Declare ON DELETE and ON UPDATE behaviors directly in your schema.',
    href: '/core-concepts/database',
    icon: '🔗',
  },
  {
    date: '2026-04-22',
    category: 'ops',
    title: 'Per-App Audit Log',
    description: 'Unified, queryable activity log for every app event.',
    icon: '📋',
  },
  {
    date: '2026-04-22',
    category: 'ops',
    title: 'Plan Quotas + Limit Notifications',
    description: 'Free / Pro / Enterprise tiers with usage metering. Email alerts at 80% and at the hard limit.',
    href: '/core-concepts/billing',
    icon: '📊',
  },
  {
    date: '2026-04-20',
    category: 'ops',
    title: 'App Overview Dashboard',
    description: 'Health status, quota usage bars, weekly growth deltas, and recent activity in one place.',
    href: '/getting-started/dashboard',
    icon: '📈',
  },
  {
    date: '2026-04-17',
    category: 'deploy',
    title: 'Edge Frontend Hosting',
    description: 'Deploy a React, Next.js, or static frontend to a global URL with one tool call. SPA routing and HTTPS handled.',
    href: '/core-concepts/frontend-deployment',
    icon: '🚀',
  },
  {
    date: '2026-04-15',
    category: 'realtime',
    title: 'Cross-Region Realtime',
    description: 'WebSocket data-change notifications with RLS-aware filtering, presence tracking, and custom event triggers.',
    href: '/core-concepts/realtime',
    icon: '⚡',
  },
  {
    date: '2026-04-13',
    category: 'ai',
    title: 'Claude Code Plugin',
    description: 'Six AI-coding skills installed via `butterbase plugin setup`: build-app, schema-design, function-dev, debug-rls, deploy-frontend, contributing.',
    href: '/sdks-and-tools/plugin',
    icon: '🧩',
  },
  {
    date: '2026-04-04',
    category: 'tooling',
    title: 'TypeScript SDK',
    description: '@butterbase/sdk with full API coverage and typed responses.',
    href: '/sdks-and-tools/typescript-sdk',
    icon: '📦',
  },
  {
    date: '2026-04-04',
    category: 'tooling',
    title: 'Command-Line Interface',
    description: '@butterbase/cli with init, integrations, and project-management commands.',
    href: '/sdks-and-tools/cli',
    icon: '⌨️',
  },
  {
    date: '2026-04-04',
    category: 'ai',
    title: 'MCP Server',
    description: 'Connect any AI assistant — Claude, Cursor, Windsurf — to Butterbase via MCP. Tools tuned for agents: predictable responses, structured errors, next-action hints.',
    href: '/getting-started/mcp-setup',
    icon: '🤖',
  },
  {
    date: '2026-04-03',
    category: 'functions',
    title: 'Serverless Functions',
    description: 'Deploy TypeScript / JavaScript functions to a managed Deno runtime. HTTP triggers and cron schedules.',
    href: '/core-concepts/functions',
    icon: '⚙️',
  },
  {
    date: '2026-04-02',
    category: 'database',
    title: 'Row-Level Security',
    description: 'One tool call to restrict rows so each signed-in user only accesses their own data.',
    href: '/core-concepts/row-level-security',
    icon: '🔒',
  },
  {
    date: '2026-04-01',
    category: 'database',
    title: 'Isolated Postgres per App',
    description: 'Every app gets its own Postgres database, identifier, and API base URL.',
    href: '/core-concepts/database',
    icon: '🗄️',
  },
  {
    date: '2026-04-01',
    category: 'auth',
    title: 'Managed Authentication',
    description: 'Email/password, OAuth (any provider), password reset, email verification, and rate limiting — configurable per app.',
    href: '/core-concepts/authentication',
    icon: '👤',
  },
  {
    date: '2026-04-01',
    category: 'storage',
    title: 'File Storage',
    description: 'S3-compatible storage with presigned URLs. Per-app and per-user organization, configurable size and content-type limits, RLS-aware.',
    href: '/core-concepts/storage',
    icon: '📁',
  },
  {
    date: '2026-03-31',
    category: 'database',
    title: 'Declarative Schema + Auto-API',
    description: 'Describe tables in JSON; the platform diffs and applies. Full CRUD over HTTP appears automatically — no code generation, no manual route setup.',
    href: '/core-concepts/database',
    icon: '✨',
  },
  {
    date: '2026-03-30',
    category: 'ops',
    title: 'Foundations',
    description: 'Control API, app provisioning, API key management, and the platform skeleton.',
    icon: '🏗️',
  },
];
