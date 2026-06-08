import os, uuid, pytest
import asyncpg
from agent_runtime.tools.audit import write_audit, args_hash


pytestmark = pytest.mark.skipif(
    os.environ.get("RUN_DB_TESTS") != "1",
    reason="RUN_DB_TESTS not set",
)


@pytest.mark.asyncio
async def test_write_audit_inserts_row():
    pool = await asyncpg.create_pool(os.environ["CONTROL_PLANE_URL"])
    try:
        async with pool.acquire() as conn:
            owner = await conn.fetchval(
                "INSERT INTO platform_users (id, email) VALUES (gen_random_uuid(),$1) "
                "ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id",
                f"audit-{uuid.uuid4().hex[:6]}@example.com",
            )
            app_id = f"audit-{uuid.uuid4().hex[:8]}"
            await conn.execute(
                "INSERT INTO apps (id, name, owner_id, db_name) VALUES ($1,$2,$3,$4)",
                app_id, "audit", owner, f"db_{app_id}",
            )
            agent_id = await conn.fetchval(
                "INSERT INTO agents (app_id, name, graph_spec) "
                "VALUES ($1,$2,'{}'::jsonb) RETURNING id",
                app_id, "a",
            )
            run_id = await conn.fetchval(
                "INSERT INTO agent_runs (app_id, agent_id, caller_kind, input, status) "
                "VALUES ($1,$2,'function','{}'::jsonb,'running') RETURNING id",
                app_id, agent_id,
            )
            await write_audit(
                pool, run_id=str(run_id), app_id=app_id,
                tool_source="builtin", tool_name="query_table", server_id=None,
                args={"table": "t"}, duration_ms=12, status="ok", error=None,
            )
            row = await conn.fetchrow(
                "SELECT tool_name, status, args_hash FROM agent_tool_audits WHERE run_id = $1",
                run_id,
            )
            assert row["tool_name"] == "query_table"
            assert row["status"] == "ok"
            assert row["args_hash"] == args_hash({"table": "t"})
            await conn.execute("DELETE FROM agent_tool_audits WHERE run_id = $1", run_id)
            await conn.execute("DELETE FROM agent_runs WHERE app_id = $1", app_id)
            await conn.execute("DELETE FROM agents WHERE app_id = $1", app_id)
            await conn.execute("DELETE FROM apps WHERE id = $1", app_id)
    finally:
        await pool.close()
