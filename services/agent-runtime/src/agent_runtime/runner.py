"""DB-backed run lifecycle for Plan 2.

Loads the run + agent rows, builds a ToolRegistry from spec.tools
(builtin / mcp_servers / functions), compiles the graph, executes it,
writes back status/output/error.  MCPPool is always torn down in finally.
"""

import asyncio
import json
from datetime import datetime, timezone
from typing import Any, Protocol

import asyncpg

from agent_runtime.cancel import CancelToken
from agent_runtime.checkpoint import Checkpointer
from agent_runtime.compiler import Interrupted, compile_graph
from agent_runtime.crypto import decrypt
from agent_runtime.events import EventEmitter
from agent_runtime.heartbeat import Heartbeat
from agent_runtime.spec import GraphSpec
from agent_runtime.tools.audit import write_audit
from agent_runtime.tools.base import ToolRegistry
from agent_runtime.tools.builtin import make_builtin_tool
from agent_runtime.tools.functions import load_function_tools
from agent_runtime.tools.mcp_client import MCPPool, MCPServerSpec
from agent_runtime.webhooks import enqueue_webhook


class _OpenRouterLike(Protocol):
    async def chat_completion(self, **kwargs) -> dict[str, Any]: ...


async def _load_mcp_specs(
    pool: asyncpg.Pool,
    app_id: str,
    entries,                # list[McpServerEntry] from spec
    encryption_key: bytes,
) -> list[MCPServerSpec]:
    """Fetch active MCP server rows and return MCPServerSpec objects.

    Decrypts auth_header if present using the supplied key.
    """
    if not entries:
        return []
    server_ids = [e.server_id for e in entries]
    rows = await pool.fetch(
        """
        SELECT id, name, transport, url, auth_header, tool_acl, status
        FROM agent_mcp_servers
        WHERE app_id = $1 AND id = ANY($2::uuid[])
        """,
        app_id, server_ids,
    )
    by_id = {str(r["id"]): r for r in rows}
    out: list[MCPServerSpec] = []
    for entry in entries:
        row = by_id.get(entry.server_id)
        if row is None:
            raise RuntimeError(
                f"mcp server {entry.server_id} not found for app {app_id}"
            )
        if row["status"] not in ("active", "healthy"):
            raise RuntimeError(
                f"mcp server {entry.server_id} not usable (status={row['status']})"
            )
        auth_header = (
            decrypt(row["auth_header"], encryption_key)
            if row["auth_header"] else None
        )
        tool_acl = row["tool_acl"]
        if isinstance(tool_acl, str):
            tool_acl = json.loads(tool_acl)
        out.append(MCPServerSpec(
            server_id=str(row["id"]),
            name=row["name"],
            transport=row["transport"],
            url=row["url"],
            auth_header=auth_header,
            tool_acl=tool_acl or {},
            allow_tools=list(entry.tools),
            spec_overrides={
                k: v.model_dump(exclude_none=True)
                for k, v in (entry.tool_overrides or {}).items()
            },
        ))
    return out


async def run_agent(
    *,
    pool: asyncpg.Pool,
    run_id: str,
    openrouter: _OpenRouterLike,
    redis=None,             # redis client (e.g. app.state.redis.client)
    control_api=None,
    encryption_key: bytes = b"",
) -> None:
    # ------------------------------------------------------------------ claim
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            WITH claimed AS (
                UPDATE agent_runs
                SET status = 'running', started_at = now()
                WHERE id = $1 AND status = 'queued'
                RETURNING id, app_id, agent_id, caller_kind, caller_user_id,
                          input, webhook_url, resume_input
            )
            SELECT c.id, c.app_id, c.caller_kind, c.caller_user_id,
                   c.input, c.webhook_url, c.resume_input, a.graph_spec
            FROM claimed c
            JOIN agents a ON a.id = c.agent_id
            """,
            run_id,
        )
        if row is None:
            raise RuntimeError(
                f"run {run_id} not claimable (not found or not queued)"
            )

    app_id: str = row["app_id"]
    caller_kind: str = row["caller_kind"]
    caller_user_id: str | None = row["caller_user_id"]
    webhook_url: str | None = row["webhook_url"]

    graph_spec = row["graph_spec"]
    if isinstance(graph_spec, str):
        graph_spec = json.loads(graph_spec)
    run_input = row["input"]
    if isinstance(run_input, str):
        run_input = json.loads(run_input)
    resume_input = row["resume_input"]
    if isinstance(resume_input, str):
        resume_input = json.loads(resume_input)

    spec = GraphSpec.model_validate(graph_spec)

    # -------------------------------------------- build durability components
    emitter = EventEmitter(pool=pool, redis=redis, run_id=run_id) if redis else None
    checkpointer = Checkpointer(pool=pool, run_id=run_id)
    heartbeat = Heartbeat(
        pool=pool, run_id=run_id,
        interval_seconds=spec.limits.heartbeat_seconds,
    )
    cancel_token = CancelToken(redis=redis, run_id=run_id) if redis else None

    await heartbeat.start()
    if cancel_token is not None:
        await cancel_token.start()

    # --------------------------------------------------- checkpoint / resume
    checkpoint = await checkpointer.load_latest()
    if checkpoint is not None:
        resume_step, _node_id, initial_state = checkpoint
    else:
        resume_step = 0
        initial_state = run_input

    # Merge resume_input (from /resume route) into state as human_input.
    if resume_input is not None:
        if not isinstance(initial_state, dict):
            initial_state = {}
        initial_state = dict(initial_state)
        initial_state["human_input"] = resume_input

    # --------------------------------------------------------- build registry
    mcp_pool = MCPPool(caller_kind=caller_kind)
    try:
        registry = ToolRegistry()

        for name in spec.tools.builtin:
            registry.add(make_builtin_tool(
                name,
                client=control_api,
                app_id=app_id,
                run_id=str(run_id),
                caller_kind=caller_kind,
                caller_user_id=caller_user_id,
            ))

        if spec.tools.mcp_servers:
            mcp_specs = await _load_mcp_specs(
                pool, app_id, spec.tools.mcp_servers, encryption_key,
            )
            try:
                for tool in await mcp_pool.open(mcp_specs):
                    registry.add(tool)
            finally:
                # Hygiene: clear decrypted auth_header from local frame.
                for s in mcp_specs:
                    s.auth_header = None

        if spec.tools.functions:
            for tool in await load_function_tools(
                client=control_api,
                pool=pool,
                app_id=app_id,
                run_id=str(run_id),
                caller_kind=caller_kind,
                caller_user_id=caller_user_id,
                allow_names=spec.tools.functions,
                spec_overrides={},
            ):
                registry.add(tool)

        async def audit_fn(**kwargs):
            await write_audit(pool, run_id=str(run_id), app_id=app_id, **kwargs)

        runner = compile_graph(
            spec,
            openrouter=openrouter,
            registry=registry,
            caller_kind=caller_kind,
            audit=audit_fn,
            emitter=emitter,
            checkpointer=checkpointer,
            cancel_token=cancel_token,
            resume_step=resume_step,
        )

        result = await runner(initial_state)

        # ------------------------------------------------------- write result
        async with pool.acquire() as conn:
            await conn.execute(
                """
                UPDATE agent_runs
                SET status = 'completed',
                    output = $2::jsonb,
                    finished_at = now()
                WHERE id = $1
                """,
                run_id,
                json.dumps({"value": result["output"]}),
            )
            usage = result.get("usage") or {}
            prompt_tokens = usage.get("prompt_tokens", 0)
            completion_tokens = usage.get("completion_tokens", 0)
            await conn.execute(
                """
                INSERT INTO agent_usage
                  (run_id, prompt_tokens, completion_tokens)
                VALUES ($1, $2, $3)
                ON CONFLICT (run_id) DO UPDATE SET
                  prompt_tokens = EXCLUDED.prompt_tokens,
                  completion_tokens = EXCLUDED.completion_tokens
                """,
                run_id,
                prompt_tokens,
                completion_tokens,
            )

        # Webhook delivery for completed
        if webhook_url is not None:
            await enqueue_webhook(pool, run_id, webhook_url, {
                "run_id": run_id,
                "status": "completed",
                "output": result["output"],
            })

    except Interrupted as exc:
        async with pool.acquire() as conn:
            await conn.execute(
                """
                UPDATE agent_runs
                SET status = 'paused',
                    interrupt_payload = $2::jsonb,
                    finished_at = NULL
                WHERE id = $1 AND status = 'running'
                """,
                run_id,
                json.dumps(exc.payload),
            )
        if emitter is not None:
            await emitter.emit("run_paused", {"payload": exc.payload})

    except asyncio.CancelledError:
        now = datetime.now(timezone.utc)
        async with pool.acquire() as conn:
            await conn.execute(
                """
                UPDATE agent_runs
                SET status = 'cancelled',
                    finished_at = $2
                WHERE id = $1 AND status IN ('running', 'cancelling')
                """,
                run_id, now,
            )
        if emitter is not None:
            await emitter.emit("run_cancelled", {})
        if webhook_url is not None:
            await enqueue_webhook(pool, run_id, webhook_url, {
                "run_id": run_id,
                "status": "cancelled",
                "error": "run cancelled",
            })

    except Exception as exc:
        now = datetime.now(timezone.utc)
        async with pool.acquire() as conn:
            await conn.execute(
                """
                UPDATE agent_runs
                SET status = 'failed',
                    error = $2::jsonb,
                    finished_at = $3
                WHERE id = $1 AND status = 'running'
                """,
                run_id,
                json.dumps({"message": str(exc), "type": type(exc).__name__}),
                now,
            )
        if emitter is not None:
            await emitter.emit("run_failed", {
                "error": str(exc),
                "type": type(exc).__name__,
            })
        if webhook_url is not None:
            await enqueue_webhook(pool, run_id, webhook_url, {
                "run_id": run_id,
                "status": "failed",
                "error": str(exc),
            })
        raise

    finally:
        await asyncio.shield(heartbeat.stop())
        if cancel_token is not None:
            await asyncio.shield(cancel_token.close())
        await asyncio.shield(mcp_pool.close())
