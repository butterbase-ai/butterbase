"""Live e2e: multi-node workflow (llm -> llm -> llm -> end).

Three llm nodes each call OpenRouter, chain via state keys, and an end
node templates the final output from accumulated state.

Requires the same setup as e2e_run.py (fake_openrouter on :7141, agent-runtime
on :7140 pointed at it, control-plane DB on :5433).
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


GRAPH_SPEC = {
    "spec_version": "1",
    "entry": "extract",
    "nodes": {
        "extract": {
            "type": "llm",
            "model": "anthropic/claude-sonnet-4.6",
            "system_prompt": "You extract topics.",
            "input_template": "TOPIC: {{ state.user_input }}",
            "output_key": "topic",
        },
        "expand": {
            "type": "llm",
            "model": "anthropic/claude-sonnet-4.6",
            "system_prompt": "You expand topics into bullets.",
            "input_template": "EXPAND[{{ state.topic }}]",
            "output_key": "bullets",
        },
        "summarize": {
            "type": "llm",
            "model": "anthropic/claude-sonnet-4.6",
            "system_prompt": "You summarize bullets.",
            "input_template": "SUMMARIZE[{{ state.bullets }}]",
            "output_key": "summary",
        },
        "done": {
            "type": "end",
            "output_template": "topic={{ state.topic }} | summary={{ state.summary }}",
        },
    },
    "edges": [
        {"from": "extract", "to": "expand"},
        {"from": "expand", "to": "summarize"},
        {"from": "summarize", "to": "done"},
    ],
    "tools": {"builtin": [], "mcp_servers": [], "functions": []},
    "limits": {
        "max_steps": 10,
        "max_tool_calls": 0,
        "max_parallel_tools": 1,
        "timeout_seconds": 60,
        "human_timeout_seconds": 86400,
    },
}


async def main():
    suffix = uuid.uuid4().hex[:8]
    pool = await asyncpg.create_pool(CONTROL_PLANE_URL)
    failures: list[str] = []
    app_id = None
    try:
        async with pool.acquire() as conn:
            owner = await conn.fetchval(
                """
                INSERT INTO platform_users (id, email)
                VALUES (gen_random_uuid(), $1)
                ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
                RETURNING id
                """,
                f"wf-{suffix}@example.com",
            )
            app_id = f"wf-{suffix}"
            await conn.execute(
                "INSERT INTO apps (id, name, owner_id, db_name) VALUES ($1, $2, $3, $4)",
                app_id, "wf", owner, f"db_{suffix}",
            )
            agent_id = await conn.fetchval(
                "INSERT INTO agents (app_id, name, graph_spec) VALUES ($1, $2, $3::jsonb) RETURNING id",
                app_id, "chain", json.dumps(GRAPH_SPEC),
            )
            run_id = await conn.fetchval(
                """
                INSERT INTO agent_runs (app_id, agent_id, caller_kind, input, status)
                VALUES ($1, $2, 'function', $3::jsonb, 'queued')
                RETURNING id
                """,
                app_id, agent_id, json.dumps({"user_input": "octopus cognition"}),
            )
            print(f"seeded app={app_id} agent={agent_id} run={run_id}")

        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(f"{AGENT_RUNTIME_URL}/internal/runs/{run_id}/start")
            print(f"start -> {resp.status_code} {resp.text}")
            if resp.status_code != 202:
                failures.append(f"start status {resp.status_code}: {resp.text}")

        async with pool.acquire() as conn:
            deadline = time.monotonic() + 30
            row = None
            while time.monotonic() < deadline:
                row = await conn.fetchrow(
                    "SELECT status, output, error FROM agent_runs WHERE id = $1",
                    run_id,
                )
                if row and row["status"] in ("completed", "failed"):
                    break
                await asyncio.sleep(0.2)
            print(f"final status={row['status']} error={row['error']}")
            print(f"output={row['output']}")

            if row["status"] != "completed":
                failures.append(f"expected completed, got {row['status']}: {row['error']}")
            else:
                output = json.loads(row["output"]) if isinstance(row["output"], str) else row["output"]
                value = output["value"]
                # Each llm node prepends "echoed: " (fake). The chain produces:
                #   topic    = echoed: TOPIC: octopus cognition
                #   bullets  = echoed: EXPAND[echoed: TOPIC: octopus cognition]
                #   summary  = echoed: SUMMARIZE[echoed: EXPAND[echoed: TOPIC: octopus cognition]]
                expected_topic = "echoed: TOPIC: octopus cognition"
                expected_summary = (
                    "echoed: SUMMARIZE[echoed: EXPAND[echoed: TOPIC: octopus cognition]]"
                )
                expected = f"topic={expected_topic} | summary={expected_summary}"
                if value != expected:
                    failures.append(f"output mismatch:\n  got:  {value}\n  want: {expected}")

            usage = await conn.fetchrow(
                "SELECT prompt_tokens, completion_tokens FROM agent_usage WHERE run_id = $1",
                run_id,
            )
            print(f"usage row={usage}")
            if usage is None:
                failures.append("agent_usage row missing")
            elif usage["prompt_tokens"] != 21 or usage["completion_tokens"] != 15:
                # 3 llm calls × (7, 5) = (21, 15) accumulated
                failures.append(f"usage mismatch: {dict(usage)}; want prompt=21 completion=15")

    finally:
        if app_id is not None:
            async with pool.acquire() as conn:
                await conn.execute(
                    "DELETE FROM agent_usage WHERE run_id IN (SELECT id FROM agent_runs WHERE app_id = $1)",
                    app_id,
                )
                await conn.execute("DELETE FROM agent_runs WHERE app_id = $1", app_id)
                await conn.execute("DELETE FROM agents WHERE app_id = $1", app_id)
                await conn.execute("DELETE FROM apps WHERE id = $1", app_id)
        await pool.close()

    if failures:
        print("\nFAILED:")
        for f in failures:
            print(f"  - {f}")
        sys.exit(1)
    print("\nOK")


if __name__ == "__main__":
    asyncio.run(main())
