# Templates

Full, production-shaped applications built on Butterbase. Unlike [`Examples/`](../Examples) — which are small, single-concept demos — each template here is a complete app you can clone and run as your own.

| Template | What it is |
|---|---|
| [`butterSupport/`](./butterSupport) | AI support agent that diagnoses against your real product data through substrate, not just your help-center docs. Per-ticket Durable Object agent loop, founder approval on every customer-visible reply, embeddable widget. |
| [`butterbaseCRM/`](./butterbaseCRM) | Substrate-native CRM for founders — companies, people, deals and meetings stored as agent-readable substrate entities. Gmail/Calendar ingest, meeting notetaker, enrichment, campaigns, social publishing, workspace AI agent. |

## Using a template

Each template's backend lives on the Butterbase platform; the folders here mirror it so you can read and review it in git. To get a running copy, **clone the Butterbase app** — that forks the schema, RLS policies, function code and configs into a new `app_<id>` you own:

```bash
butterbase clone <source_app_id> my-app
```

Then follow the template's own README for frontend setup and configuration.

## Configuration

Every template reads its credentials from environment variables and ships a `.env.example`. Copy it to `.env` (and `frontend/.env.example` to `frontend/.env.local`), then fill in your own app ID and service key. Never commit a `bb_sk_*` key or an OAuth client secret.

## License

Apache-2.0, same as the rest of this repository — see the [root LICENSE](../LICENSE).
