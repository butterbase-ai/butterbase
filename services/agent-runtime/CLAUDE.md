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

`pytest`. Use `pytest -k <fragment>` to scope. Integration tests need a
running Postgres; the `Makefile` `test-integration` target boots one.

## Local boot

Use the docker-compose service rather than running uvicorn by hand —
the compose file already wires every required env var, including the
ones you will forget.
