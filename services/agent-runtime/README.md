# agent-runtime

## What this service does

agent-runtime compiles declarative graph specs (expressed as Pydantic models) into runnable LangGraph graphs and executes them. It is an internal service: control-api calls it over the `INTERNAL_SERVICE_TOKEN` channel, and it is never reachable from the public internet. Each run persists its checkpoint state to Postgres and emits incremental events to Redis so control-api can stream them to clients.

## Architecture

```
control-api
    │  (internal-service-token, HTTP)
    ▼
agent-runtime
    ├── Pydantic spec model  →  LangGraph compiler
    │       └── tool sources: built-in | MCP | function
    ├── Postgres checkpointer  (agent_runtime schema, same DB as control-plane)
    └── Redis event bus        (run events streamed back to control-api)
```

The compiler resolves tools from three sources: built-in tools bundled in this service, remote MCP servers (auth headers decrypted with `AUTH_ENCRYPTION_KEY`), and user-defined function tools. All tool calls are logged through the audit layer before dispatch.

## Local development

Create a virtualenv and install dependencies:

```bash
cd services/agent-runtime
python3.12 -m venv .venv
source .venv/bin/activate
pip install -e '.[dev]'
```

Required environment variables:

```bash
# Postgres connection string for the control-plane DB
CONTROL_PLANE_URL=postgres://postgres:postgres@localhost:5432/butterbase_control

# OpenRouter credentials
OPENROUTER_API_KEY=sk-or-...
OPENROUTER_BASE_URL=          # optional; override to point at a local mock

# 64 hex-char key — MUST match the value used by control-api.
# Without this, MCP auth-header decryption throws a confusing AESGCM error.
AUTH_ENCRYPTION_KEY=<64-hex-chars>

# Shared secret between control-api and agent-runtime
INTERNAL_SERVICE_TOKEN=<token>

# Base URL control-api uses to call back into itself (e.g. for HITL callbacks)
CONTROL_API_URL=http://localhost:3000
```

Start the server:

```bash
CONTROL_PLANE_URL=postgres://postgres:postgres@localhost:5432/butterbase_control \
OPENROUTER_API_KEY=sk-or-... \
AUTH_ENCRYPTION_KEY=<64-hex-chars> \
INTERNAL_SERVICE_TOKEN=<token> \
CONTROL_API_URL=http://localhost:3000 \
uvicorn agent_runtime.app:app --reload --port 7140
```

## Running with the local docker-compose

```bash
docker compose -f docker-compose.local.yml up agent-runtime
```

All required env vars are mapped in `docker-compose.local.yml`; no extra configuration is needed beyond what you set there.

## Running with a fake OpenRouter

Set `OPENROUTER_BASE_URL` to a local mock server and `OPENROUTER_API_KEY` to any non-empty string. The `tests/live/` helpers include `fake_openrouter.py` which can serve as a drop-in:

```bash
OPENROUTER_BASE_URL=http://localhost:9000 \
OPENROUTER_API_KEY=fake \
uvicorn agent_runtime.app:app --reload --port 7140
```

This is useful for offline development and CI runs that should not hit the real API.

## Tests

```bash
pytest
```

Tests live directly under `tests/` (flat layout). The `tests/live/` subdirectory contains end-to-end scripts that require a running stack (`fake_control_api.py`, `fake_mcp_server.py`, `fake_openrouter.py`, and scenario runners). Flat tests cover individual units such as the compiler, spec model, tool sources, crypto, events, checkpointing, and HTTP routes.

## Checkpointer schema

LangGraph's `PostgresSaver` bootstraps the `agent_runtime` schema in the control-plane database on first startup — no manual migration needed. The schema lives in the same database as `agents`, `agent_runs`, and `agent_run_events` (transactional sanity) but in a dedicated `agent_runtime` schema to limit blast radius if LangGraph internals change.

## Deployment

Fly app: `butterbase-agent-runtime` (`services/agent-runtime/fly.toml`). The service is internal-only and not exposed via a public hostname. The `fly.toml` sets the same env keys as local; secrets (`AUTH_ENCRYPTION_KEY`, `INTERNAL_SERVICE_TOKEN`, `OPENROUTER_API_KEY`, `CONTROL_PLANE_URL`) are stored as Fly secrets. CI builds the Docker image and deploys to Fly on every push to `main`.

## Troubleshooting

**Run stuck in `queued` state** — the background task that picks up the run likely crashed on startup. Check `fly logs -a butterbase-agent-runtime` (or local container logs) for a Python traceback. Common causes: missing env var, DB connection failure, import error.

**`AESGCM` decryption error** — `AUTH_ENCRYPTION_KEY` is missing or does not match the value configured in control-api. Every MCP connection whose auth headers were encrypted by control-api will fail to decrypt. Set the same 64-hex-char key in both services.

**OpenAI 400 "schema" error on function tool** — function tool `args_schema` must include `"properties": {}` even when the function takes no arguments. A bare `{"type": "object"}` is rejected by the OpenAI-compatible schema validator.
