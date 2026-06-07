"""Live e2e driver for Plan 2, Task 17: built-in / MCP / function tool layer.

Seeds a platform_user, app, agent_mcp_server, app_function, agent, and queued
run via direct SQL, hits agent-runtime's /internal/runs/:id/start, polls until
completed, then asserts:
  - agent_runs.status = 'completed'
  - agent_tool_audits has 3 rows: one per source (builtin, mcp, function)
    all with status='ok'
  - agent_usage has cumulative token totals (14 prompt / 10 completion)

Token math:
  fake_openrouter emits 7 prompt + 5 completion per LLM call.
  Turn 1: CALL_TOOLS directive → parallel tool_calls response (7/5).
  Turn 2: tool results arrive → "done: ok" response (7/5).
  Total: 14 prompt / 10 completion.

Launch sequence (each in a separate terminal):
  python services/agent-runtime/tests/live/fake_openrouter.py 7141 &
  python services/agent-runtime/tests/live/fake_mcp_server.py 7142 &
  python services/agent-runtime/tests/live/fake_control_api.py 4001 &
  # Start agent-runtime locally with env overrides:
  #   CONTROL_API_URL=http://localhost:4001
  #   OPENROUTER_BASE_URL=http://localhost:7141
  #   INTERNAL_SERVICE_TOKEN=   (empty)
  #   DATABASE_URL=postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control
  python services/agent-runtime/tests/live/e2e_tools.py

Exits 0 on success, non-zero on failure.
"""

import asyncio
import json
import os
import sys
import time
import uuid

import asyncpg
import httpx


CONTROL_PLANE_URL = os.environ.get(
    "CONTROL_PLANE_URL",
    "postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control",
)
AGENT_RUNTIME_URL = os.environ.get("AGENT_RUNTIME_URL", "http://localhost:7140")

# The fake MCP server must be reachable from agent-runtime at this URL.
# If agent-runtime runs in Docker, use http://host.docker.internal:7142/mcp.
FAKE_MCP_URL = os.environ.get("FAKE_MCP_URL", "http://localhost:7142/mcp")


async def seed(conn, suffix):
    """Insert all required rows and return (app_id, mcp_server_id, run_id)."""
    owner = await conn.fetchval(
        """
        INSERT INTO platform_users (id, email)
        VALUES (gen_random_uuid(), $1)
        ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
        RETURNING id
        """,
        f"e2e-tools-{suffix}@example.com",
    )

    app_id = f"e2e-tools-{suffix}"
    await conn.execute(
        "INSERT INTO apps (id, name, owner_id, db_name) VALUES ($1, $2, $3, $4)",
        app_id, "e2e-tools", owner, f"db_{suffix}",
    )

    # MCP server pointing at the fake MCP server on localhost.
    mcp_server_id = await conn.fetchval(
        """
        INSERT INTO agent_mcp_servers (app_id, name, transport, url, status)
        VALUES ($1, 'fake-echo', 'streamable_http', $2, 'active')
        RETURNING id
        """,
        app_id, FAKE_MCP_URL,
    )

    # app_function row that the function tool loader will find.
    await conn.execute(
        """
        INSERT INTO app_functions
            (app_id, name, code, trigger_type,
             agent_tool, agent_tool_description, agent_tool_mode, agent_tool_exposed_to)
        VALUES ($1, 'summarize', '', 'http', true,
                'Summarize text', 'read_only', 'developer_only')
        """,
        app_id,
    )

    mcp_server_id_str = str(mcp_server_id)

    graph_spec = {
        "spec_version": "1",
        "entry": "a",
        "nodes": {
            "a": {
                "type": "llm",
                "model": "anthropic/claude-sonnet-4.6",
                "system_prompt": "Use tools as instructed.",
                "input_template": "{{ state.user_input }}",
                "output_key": "reply",
                "tools": [
                    {"source": "builtin", "name": "auth_user_lookup"},
                    {"source": "mcp", "server_id": mcp_server_id_str, "name": "echo"},
                    {"source": "function", "name": "summarize"},
                ],
            },
            "z": {"type": "end", "output_template": "{{ state.reply }}"},
        },
        "edges": [{"from": "a", "to": "z"}],
        "tools": {
            "builtin": ["auth_user_lookup"],
            "mcp_servers": [{"server_id": mcp_server_id_str, "tools": ["echo"]}],
            "functions": ["summarize"],
        },
        "limits": {
            "max_steps": 20,
            "max_tool_calls": 5,
            "max_parallel_tools": 3,
            "timeout_seconds": 60,
            "human_timeout_seconds": 86400,
        },
    }

    agent_id = await conn.fetchval(
        "INSERT INTO agents (app_id, name, graph_spec) VALUES ($1, $2, $3::jsonb) RETURNING id",
        app_id, "tools-agent", json.dumps(graph_spec),
    )

    # The user_input encodes the CALL_TOOLS directive so fake_openrouter issues
    # all three tool calls in parallel on the first LLM turn.
    user_input = (
        'CALL_TOOLS:[{"name":"auth_user_lookup","arguments":{"sub":"test-user"}},'
        '{"name":"echo","arguments":{"text":"hello"}},'
        '{"name":"summarize","arguments":{"text":"hello"}}]'
    )

    run_id = await conn.fetchval(
        """
        INSERT INTO agent_runs (app_id, agent_id, caller_kind, input, status)
        VALUES ($1, $2, 'function', $3::jsonb, 'queued')
        RETURNING id
        """,
        app_id, agent_id, json.dumps({"user_input": user_input}),
    )

    return app_id, mcp_server_id, run_id


async def cleanup(conn, app_id):
    await conn.execute(
        "DELETE FROM agent_tool_audits WHERE run_id IN (SELECT id FROM agent_runs WHERE app_id = $1)",
        app_id,
    )
    await conn.execute(
        "DELETE FROM agent_usage WHERE run_id IN (SELECT id FROM agent_runs WHERE app_id = $1)",
        app_id,
    )
    await conn.execute("DELETE FROM agent_runs WHERE app_id = $1", app_id)
    await conn.execute("DELETE FROM agents WHERE app_id = $1", app_id)
    await conn.execute("DELETE FROM app_functions WHERE app_id = $1", app_id)
    await conn.execute("DELETE FROM agent_mcp_servers WHERE app_id = $1", app_id)
    await conn.execute("DELETE FROM apps WHERE id = $1", app_id)


async def poll_until_done(conn, run_id, deadline):
    while time.monotonic() < deadline:
        row = await conn.fetchrow(
            "SELECT status, output, error FROM agent_runs WHERE id = $1",
            run_id,
        )
        if row and row["status"] in ("completed", "failed"):
            return row
        await asyncio.sleep(0.2)
    raise TimeoutError(f"run {run_id} did not terminate in time")


async def main():
    suffix = uuid.uuid4().hex[:8]
    pool = await asyncpg.create_pool(CONTROL_PLANE_URL)
    failures: list[str] = []
    app_id = None

    try:
        async with pool.acquire() as conn:
            app_id, mcp_server_id, run_id = await seed(conn, suffix)
            print(f"seeded app={app_id} mcp_server={mcp_server_id} run={run_id}")

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(f"{AGENT_RUNTIME_URL}/internal/runs/{run_id}/start")
            print(f"start -> {resp.status_code} {resp.text}")
            if resp.status_code != 202:
                failures.append(f"expected 202, got {resp.status_code}: {resp.text}")

        async with pool.acquire() as conn:
            row = await poll_until_done(conn, run_id, time.monotonic() + 60)
            print(f"final status={row['status']} output={row['output']} error={row['error']}")

            if row["status"] != "completed":
                failures.append(
                    f"expected status=completed, got {row['status']} error={row['error']}"
                )

            # ----- audit assertions -----
            audit_rows = await conn.fetch(
                "SELECT tool_source, tool_name, status FROM agent_tool_audits "
                "WHERE run_id = $1 ORDER BY tool_source",
                run_id,
            )
            print(f"audit rows: {[dict(r) for r in audit_rows]}")

            sources = sorted(r["tool_source"] for r in audit_rows)
            if sources != ["builtin", "function", "mcp"]:
                failures.append(f"want all 3 sources, got {sources}")

            bad_status = [r for r in audit_rows if r["status"] != "ok"]
            if bad_status:
                failures.append(
                    f"some audits not ok: {[dict(r) for r in bad_status]}"
                )

            # ----- usage assertions -----
            # 2 LLM turns × (7 prompt + 5 completion) = 14 / 10
            usage = await conn.fetchrow(
                "SELECT prompt_tokens, completion_tokens FROM agent_usage WHERE run_id = $1",
                run_id,
            )
            print(f"usage row={usage}")
            if usage is None:
                failures.append("agent_usage row missing")
            else:
                if usage["prompt_tokens"] != 14 or usage["completion_tokens"] != 10:
                    failures.append(
                        f"usage mismatch: got prompt={usage['prompt_tokens']} "
                        f"completion={usage['completion_tokens']}, want 14/10"
                    )

    finally:
        if app_id is not None:
            async with pool.acquire() as conn:
                await cleanup(conn, app_id)
        await pool.close()

    if failures:
        print("\nFAILED:")
        for f in failures:
            print(f"  - {f}")
        sys.exit(1)
    print("\nOK")


if __name__ == "__main__":
    asyncio.run(main())
