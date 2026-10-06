# CLAUDE.md — services/agent-runtime

This service compiles declarative agent graph specs and executes them
with LangGraph. It is reached only by control-api over the internal
service-token channel; it has no public ingress.

## When modifying

- The graph spec model is in `src/agent_runtime/spec.py`. Adding a node
  type means: Pydantic model, compiler case in `compiler.py`, executor
  branch in `executor.py`, JSON example in `services/docs/.../agent-graph-spec.md`.
- Tool handlers live under `src/agent_runtime/tools/{builtin,mcp,functions}/`.
  Every new tool needs a default ACL (`mode`, `exposed_to`).
- The OpenAI tool-name regex is `^[a-zA-Z0-9_-]{1,64}$`. Function tools
  whose names violate this fail at LLM-call time, not at registration.
  Validate at registration if you can.
- `args_schema` for any tool must include a `properties` key — even if
  empty `{}`. OpenAI rejects schemas without it.
- `AUTH_ENCRYPTION_KEY` (64 hex chars) must match control-api's. MCP
  auth headers are AES-256-GCM-encrypted at rest.

## Tests

Run from `services/agent-runtime/` after `pip install -e '.[dev]'` (pytest
config lives in `pyproject.toml`: `asyncio_mode = "auto"`, `testpaths = ["tests"]`,
`pythonpath = ["src"]`). There is no Makefile target for this service.

- `pytest` runs the unit suite. Use `pytest -k <fragment>` to scope.
- Tests that need Postgres or Redis (`tests/conftest.py` fixtures `pg_pool` /
  `redis_pool`) connect to `TEST_CONTROL_DB_URL` (default
  `postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control`) and
  `TEST_REDIS_URL` (default `redis://localhost:6379`). Those match the
  `control-plane-db` (5433) and `redis` services in the repo-root
  `docker-compose.local.yml`; start them yourself, e.g.
  `docker compose -f docker-compose.local.yml up -d control-plane-db redis`.
- `tests/test_e2e_smoke.py` is skipped unless `RUN_DB_TESTS=1` and
  `CONTROL_PLANE_URL` points at a control-plane DB with the agent migrations applied.
- `tests/live/e2e_*.py` are standalone scripts, not pytest tests; they need a
  running agent-runtime plus `tests/live/fake_openrouter.py` (see README).

## Local boot

There is no agent-runtime service in `docker-compose.local.yml`. Run it by
hand with uvicorn, using the env vars and command in `README.md` ("Local
development"): `CONTROL_PLANE_URL`, `OPENROUTER_API_KEY`, `AUTH_ENCRYPTION_KEY`,
`INTERNAL_SERVICE_TOKEN`, `CONTROL_API_URL`, `REDIS_URL`, then
`uvicorn agent_runtime.app:app --reload --port 7140`. The `Dockerfile` runs the
same app on port 7140 for deploys (`fly.toml`).
