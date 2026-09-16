# Your AI agent can now manage your entire backend

*Database, auth, storage, functions, RAG, deployments — through one MCP server. No glue code.*

---

Here's the problem with building AI-native apps on most BaaS platforms today.

Your LLM can write code. It can reason about your schema. It can debug a function. But the moment you need it to *act* on your backend — create a table, deploy a serverless function, ingest documents into a RAG collection — you're back to copy-pasting outputs and running CLI commands yourself.

The AI is the co-pilot. But you're still flying the plane.

MCP (Model Context Protocol) is changing that. Tools like Claude Code, Cursor, and VS Code can now use MCP servers to directly interact with external systems. Supabase added MCP support recently. But their server covers database operations. That's it.

Butterbase ships a built-in MCP server that covers your entire backend — **not just the database**.

Here's what that means in practice.

---

## What the Butterbase MCP server actually exposes

When you connect Butterbase to Claude Code, Cursor, or any MCP-compatible client, your AI gets 35+ tools across every layer of your stack:

**Data**
- `manage_schema` — apply a declarative schema (create tables, add indexes, foreign keys) with dry-run preview before any DDL runs
- `select_rows`, `insert_row` — query and write to any table
- `seed_database` — populate tables with realistic test data
- `manage_rls` — enable Row Level Security and create user-isolation policies
- `manage_migrations` — list and audit applied migrations

**Compute**
- `deploy_function` — deploy a TypeScript serverless function (with `ctx.db`, `ctx.user`, `ctx.env` injected at runtime)
- `invoke_function` — call it immediately to test
- `manage_durable_objects` — deploy stateful per-key actors for agent state, chat rooms, rate limiters

**AI**
- `manage_ai` — call any model through your app's AI gateway: chat, embed, image generation, video generation
- `manage_rag_content` — ingest documents into a RAG collection
- `rag_query` — semantic search with optional LLM synthesis

**Auth + Identity**
- `manage_auth_config` — configure email, OAuth providers, JWT settings
- `manage_auth_users` — list, create, delete users
- `manage_oauth` — set up Google, GitHub, Apple, X sign-in

**Storage + KV**
- `manage_storage` — create buckets, configure ACLs
- `manage_kv` — read/write the key-value store with TTL

**Deployment**
- `deploy_frontend` — deploy a static site or SPA
- `manage_edge_ssr` — deploy a Next.js or Remix edge handler
- `manage_agents` — create and run agentic workflows

**Ops**
- `query_audit_logs` — structured request history across KV and other surfaces
- `billing`, `api_keys` — manage credentials and spend

That's the entire backend surface, accessible to any AI that can speak MCP.

---

## Install in two steps

```bash
# Install the Butterbase CLI
npm install -g @butterbase/cli

# Wire up every MCP-compatible client on your machine at once
butterbase mcp install
```

The `mcp install` command detects every AI client you have — Claude Code, Cursor, VS Code, JetBrains, Windsurf, Zed — and configures each one. Then it prints the per-client instruction to complete the OAuth flow:

```
  Butterbase MCP installed.
  Server: butterbase  •  URL: https://api.butterbase.ai/mcp

  Next: each client needs a one-time browser sign-in.

  Claude Code    restart, then run /mcp
  Cursor         Settings → MCP → toggle butterbase → click "Needs Login"
  VS Code        ⌘⇧P → "MCP: List Servers" → butterbase → Authenticate
```

After the one-time sign-in, your AI client has full backend access. No tokens to manage. No environment variables to wire up.

---

## A real example: building a RAG-powered support bot from scratch

Let's say you want to build a support bot that answers questions from your docs. Here's how it goes when your AI can directly control the backend.

Open Claude Code with Butterbase connected. Type:

> Create a Butterbase app called "support-bot", ingest the docs at https://docs.example.com into a RAG collection called "docs", and deploy a serverless function that answers user questions using those docs.

Claude calls `init_app` — you get a provisioned Postgres database, API endpoint, and frontend URL in seconds:

```json
{
  "app_id": "app_abc123",
  "api_url": "https://api.butterbase.dev/v1/app_abc123",
  "url": "https://support-bot.butterbase.dev"
}
```

Then it calls `manage_rag_content` to ingest your documentation. Then it writes and deploys a function via `deploy_function`:

```typescript
export async function handler(request: Request, ctx: {
  db: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };
  env: Record<string, string>;
  user: { id: string } | null;
}): Promise<Response> {
  const { question } = await request.json();

  // Semantic search over ingested docs
  const ragRes = await fetch(`${ctx.env.API_URL}/rag/collections/docs/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ctx.env.SERVICE_KEY}` },
    body: JSON.stringify({ query: question, top_k: 5, synthesize: true }),
  });

  const { answer, chunks } = await ragRes.json();

  return new Response(JSON.stringify({ answer, sources: chunks.map(c => c.metadata?.source) }), {
    headers: { "Content-Type": "application/json" },
  });
}
```

Then it calls `invoke_function` to test it right there. You didn't touch the terminal once.

---

## The part that's different from Supabase's MCP

Supabase's MCP server gives your AI access to your database. That's genuinely useful.

But here's what it can't do:

- Deploy a serverless function with your business logic
- Ingest documents into a RAG collection and query them
- Spin up a Durable Object to hold per-user agent state across requests
- Configure OAuth providers or Row Level Security
- Deploy your frontend

Butterbase's MCP server covers the full stack because Butterbase was built — from day one — to be operated by agents, not just queried by them. The MCP server isn't an add-on. It's how the platform is designed to be used.

The instructions embedded in the server's initialize response say it plainly:

> *"These tools manage a Butterbase backend — databases, functions, storage, auth, AI, RAG, deployments."*

That's the scope. An agent that can do all of that is qualitatively different from an agent that can run a SQL query.

---

## Schema management that doesn't guess

One thing worth highlighting specifically: `manage_schema` uses a declarative diffing approach.

You describe what you want:

```json
{
  "tables": {
    "documents": {
      "columns": {
        "id": { "type": "uuid", "primaryKey": true, "default": "gen_random_uuid()" },
        "content": { "type": "text", "nullable": false },
        "embedding": { "type": "vector(1536)" },
        "metadata": { "type": "jsonb" },
        "created_at": { "type": "timestamptz", "default": "now()" }
      },
      "indexes": {
        "embedding_idx": {
          "columns": ["embedding"],
          "method": "hnsw",
          "opclass": "vector_cosine_ops"
        }
      }
    }
  }
}
```

The tool diffs that against your current schema and generates the safe DDL. You can call it with `action: "dry_run"` first — Claude shows you exactly what SQL would run before anything is executed. Then `action: "apply"` to commit.

This is how you get an AI that can confidently evolve your database schema without footguns.

---

## Stateful agents with Durable Objects

The `manage_durable_objects` tool lets your AI deploy per-key stateful actors — one WebSocket endpoint, one in-memory state, one storage namespace per key. This is the primitive you need for:

- Long-running agent loops that need to persist intermediate state
- Multiplayer features (one DO per room)
- Per-user rate limiters
- Human-in-the-loop approval flows

A deployed DO lives at:
```
https://<your-app>.butterbase.dev/_do/<class-name>/<instance-key>
```

And agent code running inside a function can call a sibling DO without auth plumbing:
```typescript
const ctx = butterbase.ctx(req, this.env, this.state);
await ctx.invokeDO("AgentState", userId, { action: "checkpoint", data });
```

---

## Open source, self-host, or cloud

Butterbase is Apache 2.0 licensed. You can run the whole stack locally:

```bash
git clone https://github.com/butterbase-ai/butterbase
docker compose -f docker-compose.local.yml up
```

The MCP server runs against your local instance. Everything in this post works the same way — your AI gets the same 35+ tools, pointed at your own infrastructure.

The managed cloud is at [butterbase.ai](https://butterbase.ai) if you'd rather not run the stack yourself.

---

## What to try first

If you want to see this work in five minutes:

1. `npm install -g @butterbase/cli`
2. `butterbase mcp install`
3. Open Claude Code (or Cursor) and say: *"Create a Butterbase app called test-app and show me its schema."*

The AI will call `init_app`, then `manage_schema` with `action: "get"`. You'll see a live database schema returned directly into the chat. From there, add tables, deploy functions, ingest documents — your AI runs the whole thing.

That's the shift. The agent isn't describing what you should do. It's doing it.

---

*Butterbase is open source under Apache 2.0. [GitHub](https://github.com/butterbase-ai/butterbase) · [Discord](https://discord.gg/Aq7q5mqbrt) · [butterbase.ai](https://butterbase.ai)*
