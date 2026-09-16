# INDIE HACKERS — Post #2: Learning Post
# Publish this 1 week before the HN launch

**Title:**
> What developers told me when I asked why they haven't left Supabase yet

---

Last week I posted about why I built Butterbase — an open-source BaaS with a full-stack MCP server for AI-native apps. A bunch of people reached out. Some tried it. Some had questions. Some just told me why they're staying on Supabase.

That last group was the most useful.

Here's what I heard, and what I think it means.

---

## "Supabase has way more ecosystem"

This came up most often. Supabase has client libraries in every language, hundreds of third-party integrations, a massive community, and years of docs. It's the known quantity.

This is fair. We're earlier. The TypeScript SDK is solid; Python and Go are in progress. The docs are honest about what's stable and what isn't.

What I've noticed is that this concern matters a lot less when an AI agent is the primary integrator. The agent reads the docs, writes the client code, and handles the integration. The human-hours saved from not having to hand-write boilerplate offset the ecosystem gap faster than you'd expect.

---

## "I don't want to maintain another service"

Several people said some version of: the self-host complexity is the blocker. They're already managing too much infrastructure.

This is legitimate. Docker Compose gets you running locally. Production self-hosting requires more — you need to think about the Postgres instance, the control API, the storage backend, the worker runtime.

The managed version at butterbase.ai exists precisely for this. But I also heard this as a product signal: we need the self-host story to be simpler. One-command production deploy. That's on the roadmap.

---

## "What does AI-native actually mean"

A few engineers pushed back on the positioning. "Every BaaS is going to add MCP support. What makes Butterbase's different?"

This is the question I find most interesting. Here's my honest answer:

Most BaaS MCP integrations are database proxies. They expose SELECT, INSERT, schema inspection. That's useful, but it means your AI can query your data — it can't operate your backend. It can't deploy a function, configure auth, manage a RAG collection, or spin up a stateful actor.

Butterbase's MCP server was built to cover the full backend surface because we believe the agent should be able to close the loop — not just advise. When an agent identifies that you need a new table, it should be able to create it. When it writes a function, it should be able to deploy it. When it builds a knowledge base, it should be able to ingest the documents.

That's a different assumption about what "AI-native" means. Not AI-assisted. AI-operated.

---

## What surprised me

The developers who tried Butterbase and came back weren't the ones I expected. I assumed early adopters would be solo builders hacking on side projects.

The ones who engaged most were small teams — 2-5 people — building AI agent products where the entire backend needs to be iterable quickly. They described their current workflow as: write some code, switch to the terminal, run migrations, switch back. Butterbase + Claude Code collapsed that loop. The AI stays in the loop for the whole cycle.

That's the ICP I'm now optimizing for: small teams building agent-first products who are paying a high context-switching cost to maintain their backend separately from their AI workflow.

---

## This week

We're launching on Hacker News on Tuesday. If you want to support — an upvote in the first hour makes a real difference. I'll post the link here when it goes live.

The Dev.to write-up on how the MCP + RAG + Durable Objects combination works in practice is live if you want to dig into the technical details: [link]

GitHub: https://github.com/butterbase-ai/butterbase
Discord: https://discord.gg/Aq7q5mqbrt
