# INDIE HACKERS — Post #2
# Publish 1 week before distribution push

**Title:** Supabase just went all-in on MCP. We've been here since day one. Here's the difference.

---

Supabase raised $200M at a $5B valuation and immediately started pushing "MCP server for your database."

It's a smart move. MCP is hot. Developers want AI that can interact with their backend.

Here's the thing: their MCP server covers database operations. Tables, queries, schema inspection. That's it.

We've had full-stack MCP since we launched. And the gap is bigger than people realize.

---

## What Supabase's MCP can do

- Read and write database tables
- Inspect schema
- Run SQL queries

Genuinely useful. If your backend is primarily a database, this covers a lot.

---

## What Butterbase's MCP can do (that theirs can't)

Your AI connected to Butterbase can:

- **Deploy serverless functions** — not just write them. Actually deploy them.
- **Configure auth and OAuth** — tell Claude "add Google sign-in" and it's done
- **Manage RAG pipelines** — ingest documents, run semantic search, get synthesized answers
- **Create and manage Durable Objects** — stateful per-key actors for agent loops
- **Set up billing** — your AI can configure how you charge users
- **Schedule cron jobs** — "every Monday at 9am, do this" — created and managed by the agent
- **Deploy frontends** — static sites, SPAs, edge SSR

That's 35+ tools covering the same surface as the 17-page dashboard at dashboard.butterbase.ai. If you can click it in the UI, your AI can do it through MCP.

---

## Why this gap exists

Supabase is a database platform with services layered on top. A database-first MCP is the right center of gravity for what they are.

Butterbase was designed around a different assumption from day one: **the agent is the operator, not the assistant.** The MCP server isn't something we added to an existing product. It's how the platform was meant to be used.

That's a design difference, not a feature race.

---

## What this looks like in practice

You ask Claude Code: *"Build a support bot that answers questions from our docs, deploy it, and set up subscriptions so users can pay for it."*

1. `init_app` → live database, API, frontend URL. Ten seconds.
2. `manage_rag_content` → docs ingested and indexed.
3. `deploy_function` → handler deployed, `ctx.db` / `ctx.user` / `ctx.env` injected automatically.
4. `invoke_function` → tested immediately.
5. Billing configured. Users can pay.

No terminal. No switching tools. The agent closes the full loop.

---

## The window is open right now

In 18 months, every BaaS will claim "full-stack MCP." Right now, most of them mean "database MCP."

The developers who figure out the difference today are the ones who'll have working AI-native backends before this becomes table stakes.

If you've been on Supabase and hit the moment where Claude described what you needed but couldn't do it — that's the ceiling we removed.

Try it: butterbase.ai

GitHub: https://github.com/butterbase-ai/butterbase
Discord: https://discord.gg/Aq7q5mqbrt
