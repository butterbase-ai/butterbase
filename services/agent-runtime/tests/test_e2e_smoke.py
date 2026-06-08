"""End-to-end Plan 1 smoke test.

Inserts an app + agent + run directly, calls the internal start endpoint,
asserts the run row reaches `completed`. OpenRouter is mocked via the
app.state.run_agent_fn override hook.
"""

import json
import os
import uuid

import asyncpg
import httpx
import pytest
from httpx import ASGITransport

from agent_runtime.app import app


pytestmark = pytest.mark.skipif(
    os.environ.get("RUN_DB_TESTS") != "1",
    reason="set RUN_DB_TESTS=1 with a running control-plane DB",
)


_GRAPH_SPEC = {
    "spec_version": "1",
    "entry": "a",
    "nodes": {
        "a": {
            "type": "llm",
            "model": "anthropic/claude-sonnet-4.6",
            "system_prompt": "Be brief.",
            "input_template": "Echo: {{ state.user_input }}",
            "output_key": "reply",
        },
        "z": {"type": "end", "output_template": "{{ state.reply }}"},
    },
    "edges": [{"from": "a", "to": "z"}],
    "tools": {"builtin": [], "mcp_servers": [], "functions": []},
    "limits": {
        "max_steps": 10, "max_tool_calls": 0, "max_parallel_tools": 1,
        "timeout_seconds": 60, "human_timeout_seconds": 86400,
    },
}


@pytest.mark.asyncio
async def test_smoke_run_lifecycle_end_to_end(monkeypatch):
    # Stub the runner so it doesn't actually call OpenRouter.
    async def fake_run(*, pool, run_id, openrouter):
        async with pool.acquire() as conn:
            await conn.execute(
                """
                UPDATE agent_runs
                SET status = 'completed',
                    output = $2::jsonb,
                    started_at = now(),
                    finished_at = now()
                WHERE id = $1
                """,
                run_id,
                json.dumps({"value": "echoed: hi"}),
            )

    pool = await asyncpg.create_pool(os.environ["CONTROL_PLANE_URL"])
    try:
        suffix = uuid.uuid4().hex[:8]
        async with pool.acquire() as conn:
            owner = await conn.fetchval(
                """
                INSERT INTO platform_users (id, email)
                VALUES (gen_random_uuid(), $1)
                ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
                RETURNING id
                """,
                f"smoke-{suffix}@example.com",
            )
            app_id = f"smoke-{suffix}"
            await conn.execute(
                "INSERT INTO apps (id, name, owner_id, db_name) VALUES ($1, $2, $3, $4)",
                app_id, "smoke", owner, f"db_{suffix}",
            )
            agent_id = await conn.fetchval(
                "INSERT INTO agents (app_id, name, graph_spec) VALUES ($1, $2, $3::jsonb) RETURNING id",
                app_id, "echo", json.dumps(_GRAPH_SPEC),
            )
            run_id = await conn.fetchval(
                """
                INSERT INTO agent_runs (app_id, agent_id, caller_kind, input, status)
                VALUES ($1, $2, 'function', $3::jsonb, 'queued')
                RETURNING id
                """,
                app_id, agent_id, json.dumps({"user_input": "hi"}),
            )

        async with app.router.lifespan_context(app):
            app.state.run_agent_fn = fake_run
            transport = ASGITransport(app=app)
            async with httpx.AsyncClient(
                transport=transport, base_url="http://test"
            ) as client:
                response = await client.post(f"/internal/runs/{run_id}/start")
                assert response.status_code == 202

        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT status, output FROM agent_runs WHERE id = $1",
                run_id,
            )
        assert row["status"] == "completed"
        assert json.loads(row["output"]) == {"value": "echoed: hi"}
    finally:
        await pool.close()
