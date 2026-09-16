# HACKER NEWS — Show HN

## Title options

**Option A:**
> Show HN: Butterbase – BaaS with built-in billing, cron jobs, and a full-stack MCP server (not just DB)

**Option B:**
> Show HN: Butterbase – sign up, get a backend, charge users the same day — no Stripe wiring

---

## Submission body

> I built Butterbase (butterbase.ai) — a managed backend platform where you sign up, get a full
> dashboard, and can charge your users from day one. No Stripe webhook setup. Billing is built in.
>
> What you get: Postgres, REST API, email/OAuth auth, serverless functions, RAG pipeline, Durable
> Objects, KV, cron jobs (real scheduled workflows, no external service), and templated apps
> (CRM, customer support, lead finder, campaigns).
>
> The second layer: a full-stack MCP server with 35+ tools. Connect Claude Code, Cursor, or any
> MCP client and your AI can deploy functions, configure auth, run migrations, manage RAG, set up
> billing, and schedule cron jobs — not just query the database. If you can do it in the dashboard,
> the AI can do it through MCP. That's the design principle.
>
> Supabase's MCP covers database operations. That's a coherent scope for what Supabase is.
> Butterbase's MCP covers the full stack because the whole platform was built around this assumption.
>
> Plugs into whatever you're already using — Claude Code, Cursor, Windsurf. No new workflow required. No AI subscription? Butterbase ships its own assistant. GPT-6-astra, pay per usage.
>
> `npm install -g @butterbase/cli && butterbase mcp install`
>
> Apache 2.0, self-hostable. Managed cloud at butterbase.ai.

---

## Second comment (post within 2 minutes)

> More context on the full-stack MCP vs. DB-only distinction.
>
> The dashboard at dashboard.butterbase.ai has 17 management pages. The MCP server exposes
> the same operations as tools. Concrete example — building a RAG support bot:
>
> init_app → live Postgres DB + API endpoint + frontend URL. Seconds.
> manage_rag_content → docs ingested. Chunking, embedding, storage handled.
> deploy_function → TypeScript handler deployed. ctx.db, ctx.user, ctx.env injected automatically.
> invoke_function → tested immediately. No terminal. No copy-paste.
>
> Beyond functions: cron jobs (no Inngest needed), billing config, OAuth setup, schema migrations
> with dry-run preview, Durable Objects for stateful agent loops.
>
> The billing piece gets people. From day one your app can take payments. Not "wire up Stripe" —
> configured in the dashboard or via MCP, same operation.
>
> Honest about what's not perfect yet: production self-hosting needs a cleaner path.
> Docker Compose works locally. Production on your own infra is something we're actively improving.
>
> Source: https://github.com/butterbase-ai/butterbase

---

## Timing

- Post Tuesday–Thursday, 8–10am Eastern only
- Block your morning — first 2–4 hours determine everything
- Second comment within 2 minutes of submission
- Not top 30 in 2 hours = it's not happening that day. Wait 30 days, adjust title, retry
