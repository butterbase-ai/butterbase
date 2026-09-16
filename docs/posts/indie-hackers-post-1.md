# INDIE HACKERS — Post #1
# Publish 2 weeks before distribution push

**Title:** We've been heads-down building Butterbase for months. Here's what we actually learned.

---

I'm going to tell you something most BaaS founders won't say out loud.

Building a backend platform is not a product. It's twenty products. Every feature you ship — auth, functions, storage, cron jobs, billing — is a surface you have to maintain, document, version, and keep from breaking for everyone who's already using it. The surface area compounds. Fast.

We learned this the hard way.

---

## Where we actually are

[Butterbase](https://butterbase.ai) is live. We have active users. We're funded. The product works.

What we built: a full backend platform you access through a dashboard at dashboard.butterbase.ai. Sign up, and within seconds you have a live database, auth system, serverless functions, RAG pipeline, Durable Objects for stateful agent loops, cron jobs for automated workflows, and built-in billing — meaning you can charge your users the same day you launch, without wiring up Stripe yourself.

That last part keeps surprising developers when they first see it. "I can just... charge people? Right now?" Yes. That's the point.

---

## The thing that surprised us about what users actually want

We built Butterbase as an AI-native platform. The headline feature is the MCP server — 35+ tools that let AI agents operate your entire backend, not just query the database. We thought that's what people would get excited about.

They do get excited about it. But the things they come back to us about?

**The cron jobs.** Developers love that they can set up "every Monday at 9am, check which customers haven't done X, send them a reminder" without signing up for another service. It sounds simple. But it's the kind of thing you're always cobbling together from three different tools.

**The billing.** "From day one I can charge people" is a bigger deal than we realized. The mental overhead of wiring Stripe — webhooks, payment intents, subscription state, testing mode — is enough to delay a lot of projects. Removing it means people actually ship the monetization instead of deferring it.

**The templated apps.** We have ready-to-deploy CRM, customer support tool, lead finder, and campaign manager. People come in thinking they need to build from scratch and realize they're 80% there before writing a line of code.

---

## What's been hard

The production self-hosting story. Docker Compose works great locally. But "I want to run Butterbase on my own infrastructure in production" means you're managing Postgres, storage backend, worker runtime, networking, and backups yourself. We don't have a clean one-command path for that yet. It's the most common reason someone evaluates Butterbase and then waits.

Explaining what we are in one sentence. "AI-native BaaS" makes developers nod without clicking. What makes them click is the concrete version: *your AI agent can deploy the function it just wrote, configure the OAuth provider you just described, and set up the cron job you just asked about — without you leaving the chat window.* That's the pitch. We're still working on making it the first sentence.

---

## What we haven't done well: telling the story

We've been shipping. We haven't been talking. That changes this month.

If you're building something with agents, automation, or AI at the core and you've been duct-taping five services together — we built Butterbase for you. Come try it.

GitHub: https://github.com/butterbase-ai/butterbase
Discord: https://discord.gg/Aq7q5mqbrt
butterbase.ai
