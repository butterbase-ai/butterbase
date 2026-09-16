# INDIE HACKERS — Post #1: Origin Story
# Publish this 2 weeks before the HN launch

**Title:**
> Why I built an AI-native BaaS instead of using Supabase for my agent app

---

I've been building on Supabase for a while. It's genuinely good — the Postgres experience is solid, the DX is clean, the ecosystem is mature.

But then I started building AI-native apps. Not "apps with a chatbot." Apps where the AI is the core runtime — agent loops, RAG pipelines, stateful workflows. And I kept hitting the same wall.

**The wall: my AI tools could see my data but couldn't operate my backend.**

When I used Claude Code or Cursor with Supabase's MCP server, the AI could query tables and inspect my schema. But the moment I needed it to deploy a function, configure auth, ingest documents into a knowledge base, or spin up a stateful actor for an agent loop — I was back to doing it myself. Copy-pasting outputs. Running CLI commands. Leaving the AI context entirely.

The AI was the co-pilot. I was still flying the plane.

I started wondering: what would a BaaS look like if it was designed from the start to be operated by agents, not just queried by them?

---

## What I built

Butterbase is an open-source BaaS (Apache 2.0) with a built-in MCP server that covers your full backend — not just the database.

When you connect it to Claude Code, Cursor, VS Code, or any MCP-compatible client, your AI gets tools for:

- **Schema management** — declarative schema with dry-run preview before any DDL runs
- **Serverless functions** — TypeScript functions with `ctx.db`, `ctx.user`, `ctx.env` injected at runtime
- **Durable Objects** — stateful per-key actors for agent state, chat rooms, rate limiters
- **RAG** — ingest documents, semantic search, LLM synthesis
- **Auth** — email, OAuth (Google, GitHub, Apple, X), JWT config, Row Level Security
- **Storage + KV** — S3-compatible storage and key-value with TTL
- **Deployments** — static sites, SPAs, edge SSR, frontend hosting with custom domains

The install is two commands:

```bash
npm install -g @butterbase/cli
butterbase mcp install
```

It detects every AI client you have and wires them all up at once.

---

## Where it stands

We launched publicly a few months ago. The codebase is on GitHub, Docker Compose self-host works, and the managed version at butterbase.ai is live.

We've got a Discord community growing, and the thing developers keep saying when they first try it is some variation of: *"I didn't realize how much time I was spending on backend setup until I didn't have to."*

That's the signal I was looking for.

---

## What's hard about this

Building a BaaS is not a small project. The surface area is enormous — every feature you add is a surface you have to maintain, document, secure, and keep backward-compatible. We've made hard scope decisions along the way (Deno for functions, Cloudflare Workers for Durable Objects, S3-compatible for storage).

The hardest part isn't the infrastructure. It's the positioning. "AI-native BaaS" is a thing people nod at but don't immediately feel. The moment it clicks is when someone asks their AI to deploy a function and it just... does it. That demo is worth more than any copy.

---

## What's next

We're working on hardening the self-host experience further, expanding the SDK (Python and Go are next), and building out observability. The MCP server is already the primary interface most users reach for.

If you're building anything with AI agents that needs a backend, I'd love to hear what your stack looks like. Specifically: what's the moment you realized your current backend wasn't built for this?

GitHub: https://github.com/butterbase-ai/butterbase
Discord: https://discord.gg/Aq7q5mqbrt

---

*I'm posting updates here as we go — the next one will be what we learned from talking to developers who are currently on Supabase and why they haven't switched yet.*
