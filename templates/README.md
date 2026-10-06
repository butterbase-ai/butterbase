# Templates

Full, production-shaped applications built on Butterbase. Unlike [`Examples/`](../Examples) — which are small, single-concept demos — each template here is a complete product you can clone, configure, and use.

These aren't starting points you build on top of. They're finished apps. Clone one and you have a working product with a real database, auth, deployed functions, and a React frontend — on day one.

---

## [`butterbaseCRM`](./butterbaseCRM) — open-source CRM for founders

A CRM with Gmail and Calendar sync, automatic contact and company enrichment, deals, meetings, notes, email campaigns, social publishing, and a workspace AI agent. Built for founders who want a CRM that reflects their actual communication — not one that requires manual data entry to stay current.

The AI agent lets you ask questions about your pipeline and propose actions; you approve before anything is written. Social publishing lets you post to X, LinkedIn, Reddit, and TikTok directly from a deal or contact record.

**[→ See what you get](./butterbaseCRM/README.md) · [Quickstart](./butterbaseCRM/QUICKSTART.md)**

---

## [`butterSupport`](./butterSupport) — AI support agent that knows your product

An embeddable support widget and founder console. Customers submit tickets through a widget on your site; an AI agent diagnoses each one and drafts a reply for you to approve. Nothing reaches the customer without your sign-off.

What makes it different: the agent can read your actual product data — account state, failed payments, recent errors — not just your help docs. That's what lets it write replies that already know what happened to a specific customer, rather than pointing them back to documentation.

Works for any company out of the box (paste a help-center URL, done). Connects to real product data if you're running on Butterbase.

**[→ See what you get](./butterSupport/README.md)**

---

## How to use a template

Each template's backend runs on the Butterbase platform. The folders here are a readable mirror — schema, functions, RLS policies — so you can review the code before committing.

To get a running backend you own, clone the Butterbase app. That forks everything (schema, functions, auth config, storage config) into a new app under your account:

```bash
butterbase clone <source_app_id> my-app
```

Then follow the template's own README for frontend setup.

> `butterbase clone` is a managed-platform operation and requires an account at [butterbase.ai](https://butterbase.ai). If you're self-hosting, the `backend/` folder in each template contains the schema, RLS policies, and function code to deploy against your own stack.

## Configuration

Every template reads credentials from environment variables and ships a `.env.example`. Copy it to `.env` (and `frontend/.env.example` to `frontend/.env.local`), fill in your app ID and service key. Never commit a `bb_sk_*` key or an OAuth client secret.

## License

Apache-2.0, same as the rest of this repository — see the [root LICENSE](../LICENSE).
