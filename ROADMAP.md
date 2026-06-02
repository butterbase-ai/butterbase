# Roadmap

Butterbase is open source under Apache-2.0. This roadmap is a living sketch of
where the project is heading — not a contract. Priorities shift as we hear from
the community.

## Where to share input

- **Feature requests** — open a [Feature request issue](https://github.com/butterbase-ai/butterbase/issues/new?template=feature.yml).
- **Questions / show-and-tell** — start a [Discussion](https://github.com/butterbase-ai/butterbase/discussions).
- **Bugs** — open a [Bug report](https://github.com/butterbase-ai/butterbase/issues/new?template=bug.yml).

## Now (in flight)

- Stabilize the self-host experience: `docker compose -f docker-compose.local.yml up` to a working stack.
- Harden the public SDK and CLI surfaces; publish to npm under `@butterbase/*`.
- Round out docs for schema DSL, RLS, serverless functions, and deploys.

## Next (under consideration)

- First-class Postgres extensions story (pgvector, postgis, pg_cron).
- Pluggable storage backends beyond S3-compatible.
- More language SDKs (Python, Go) generated from a shared spec.
- Production-grade observability hooks (OpenTelemetry traces, structured logs).

## Later (signals welcome)

- Self-hostable cron / queue surface that maps cleanly to the cloud version.
- Multi-region replication recipes for self-hosters.
- Plugin / extension marketplace for custom MCP tools.

If something on this list matters to you — or if something important is missing —
please open a discussion or issue. We weight community signal heavily when
deciding what to work on next.
