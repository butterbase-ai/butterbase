import json
import os
import uuid

import asyncpg
import pytest

from agent_runtime.runner import run_agent
from agent_runtime.spec import GraphSpec


pytestmark = pytest.mark.skipif(
    os.environ.get("RUN_DB_TESTS") != "1",
    reason="set RUN_DB_TESTS=1 with a running control-plane DB",
)


_GRAPH_SPEC = {
    "spec_version": "1",
    "entry": "answer",
    "nodes": {
        "answer": {
            "type": "llm",
            "model": "anthropic/claude-3.5-sonnet",
            "system_prompt": "Be brief.",
            "input_template": "Echo: {{ state.user_input }}",
            "output_key": "reply",
        },
        "done": {"type": "end", "output_template": "{{ state.reply }}"},
    },
    "edges": [{"from": "answer", "to": "done"}],
    "tools": {"builtin": [], "mcp_servers": [], "functions": []},
    "limits": {
        "max_steps": 10, "max_tool_calls": 0, "max_parallel_tools": 1,
        "timeout_seconds": 60, "human_timeout_seconds": 86400,
    },
}


class FakeOpenRouter:
    async def chat_completion(self, **_kwargs):
        return {
            "message": {"role": "assistant", "content": "echoed: hi"},
            "finish_reason": "stop",
            "usage": {"prompt_tokens": 1, "completion_tokens": 1},
        }


async def _seed(pool):
    app_id = f"agt-test-{uuid.uuid4().hex[:8]}"
    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO platform_users (id, email)
            VALUES (gen_random_uuid(), $1)
            ON CONFLICT (email) DO NOTHING
            """,
            f"{app_id}@example.com",
        )
        owner = await conn.fetchval(
            "SELECT id FROM platform_users WHERE email = $1",
            f"{app_id}@example.com",
        )
        await conn.execute(
            """
            INSERT INTO apps (id, name, owner_id, db_name)
            VALUES ($1, $2, $3, $4)
            """,
            app_id, "test app", owner, f"db_{app_id}",
        )
        agent_id = await conn.fetchval(
            """
            INSERT INTO agents (app_id, name, graph_spec)
            VALUES ($1, $2, $3::jsonb)
            RETURNING id
            """,
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
        return run_id


@pytest.mark.asyncio
async def test_runner_completes_a_simple_run():
    pool = await asyncpg.create_pool(os.environ["CONTROL_PLANE_URL"])
    try:
        run_id = await _seed(pool)
        await run_agent(pool=pool, run_id=run_id, openrouter=FakeOpenRouter())

        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT status, output, error FROM agent_runs WHERE id = $1",
                run_id,
            )
        assert row["status"] == "completed"
        assert json.loads(row["output"]) == {"value": "echoed: hi"}
        assert row["error"] is None
    finally:
        await pool.close()
