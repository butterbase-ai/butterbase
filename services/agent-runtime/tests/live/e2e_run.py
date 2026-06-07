"""Live e2e driver for Plan 1.

Seeds platform_user / app / agent / queued run via direct SQL, hits
agent-runtime's /internal/runs/:id/start, polls until completed, asserts
output and usage rows. Requires:

  - control-plane DB at localhost:5433 with migration 047 applied
  - agent-runtime at localhost:7140 with OPENROUTER_BASE_URL pointed at the
    fake server (e.g. http://host.docker.internal:7141)
  - fake_openrouter.py running on the host

Run: python services/agent-runtime/tests/live/e2e_run.py
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


GRAPH_SPEC = {
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
        "max_steps": 10,
        "max_tool_calls": 0,
        "max_parallel_tools": 1,
        "timeout_seconds": 60,
        "human_timeout_seconds": 86400,
    },
}


async def seed(conn, suffix):
    owner = await conn.fetchval(
        """
        INSERT INTO platform_users (id, email)
        VALUES (gen_random_uuid(), $1)
        ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
        RETURNING id
        """,
        f"e2e-{suffix}@example.com",
    )
    app_id = f"e2e-{suffix}"
    await conn.execute(
        "INSERT INTO apps (id, name, owner_id, db_name) VALUES ($1, $2, $3, $4)",
        app_id, "e2e", owner, f"db_{suffix}",
    )
    agent_id = await conn.fetchval(
        "INSERT INTO agents (app_id, name, graph_spec) VALUES ($1, $2, $3::jsonb) RETURNING id",
        app_id, "echo", json.dumps(GRAPH_SPEC),
    )
    run_id = await conn.fetchval(
        """
        INSERT INTO agent_runs (app_id, agent_id, caller_kind, input, status)
        VALUES ($1, $2, 'function', $3::jsonb, 'queued')
        RETURNING id
        """,
        app_id, agent_id, json.dumps({"user_input": "hi"}),
    )
    return app_id, agent_id, run_id


async def cleanup(conn, app_id):
    await conn.execute("DELETE FROM agent_usage WHERE run_id IN (SELECT id FROM agent_runs WHERE app_id = $1)", app_id)
    await conn.execute("DELETE FROM agent_runs WHERE app_id = $1", app_id)
    await conn.execute("DELETE FROM agents WHERE app_id = $1", app_id)
    await conn.execute("DELETE FROM apps WHERE id = $1", app_id)


async def poll_until_done(conn, run_id, deadline):
    while time.monotonic() < deadline:
        row = await conn.fetchrow(
            "SELECT status, output, error, started_at, finished_at FROM agent_runs WHERE id = $1",
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
            app_id, agent_id, run_id = await seed(conn, suffix)
            print(f"seeded app={app_id} agent={agent_id} run={run_id}")

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(f"{AGENT_RUNTIME_URL}/internal/runs/{run_id}/start")
            print(f"start -> {resp.status_code} {resp.text}")
            if resp.status_code != 202:
                failures.append(f"expected 202, got {resp.status_code}: {resp.text}")

        async with pool.acquire() as conn:
            row = await poll_until_done(conn, run_id, time.monotonic() + 30)
            print(f"final status={row['status']} output={row['output']} error={row['error']}")
            if row["status"] != "completed":
                failures.append(f"expected status=completed, got {row['status']} error={row['error']}")
            else:
                output = json.loads(row["output"]) if isinstance(row["output"], str) else row["output"]
                if output != {"value": "echoed: Echo: hi"}:
                    failures.append(f"unexpected output: {output}")
                if row["started_at"] is None or row["finished_at"] is None:
                    failures.append("started_at/finished_at not populated")

            usage = await conn.fetchrow(
                "SELECT prompt_tokens, completion_tokens FROM agent_usage WHERE run_id = $1",
                run_id,
            )
            print(f"usage row={usage}")
            if usage is None:
                failures.append("agent_usage row missing")
            else:
                if usage["prompt_tokens"] != 7 or usage["completion_tokens"] != 5:
                    failures.append(f"usage mismatch: {dict(usage)}")

        # Idempotency check — re-posting start on a non-queued run should not corrupt state.
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp2 = await client.post(f"{AGENT_RUNTIME_URL}/internal/runs/{run_id}/start")
            print(f"second start -> {resp2.status_code} {resp2.text}")
            if resp2.status_code not in (202, 500):
                failures.append(f"second start unexpected status {resp2.status_code}")
            async with pool.acquire() as conn:
                row2 = await conn.fetchrow(
                    "SELECT status FROM agent_runs WHERE id = $1", run_id
                )
                if row2["status"] != "completed":
                    failures.append(f"second start clobbered status: {row2['status']}")

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
