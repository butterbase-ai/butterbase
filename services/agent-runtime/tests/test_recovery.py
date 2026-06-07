"""Tests for crash recovery on startup."""

import uuid
from datetime import datetime, timedelta, timezone

import pytest

from agent_runtime.recovery import recover_stale_runs


@pytest.mark.asyncio
async def test_recover_stale_runs(pg_pool):
    """Test recovery of stale runs with heartbeat timeout.

    Scenario:
    1. Create an app and agent (required for FK constraints)
    2. Create two runs:
       - stale: status='running', last_heartbeat = now() - 60 seconds, attempt=1
       - fresh: status='running', last_heartbeat = now(), attempt=1
    3. Call recover_stale_runs with stale_after_seconds=30
    4. Assert: only stale run is returned, stale has status='queued' and attempt=2,
              fresh remains status='running' and attempt=1
    """
    app_id = f"app_recovery_test_{uuid.uuid4().hex[:8]}"
    stale_id = uuid.uuid4()
    fresh_id = uuid.uuid4()

    try:
        async with pg_pool.acquire() as c:
            # Create app
            await c.execute(
                "INSERT INTO apps "
                "(id, owner_id, name, db_name, region, provisioning_status, deployment_backend, access_mode) "
                "VALUES ($1, $2, $3, $4, $5, $6, $7, $8) "
                "ON CONFLICT (id) DO NOTHING",
                app_id,
                "00000000-0000-0000-0000-000000000001",
                "Recovery Test App",
                f"recovery_test_{uuid.uuid4().hex[:8]}",
                "local",
                "ready",
                "pages",
                "public",
            )

            # Create agent
            agent_id = await c.fetchval(
                "INSERT INTO agents (app_id, name, graph_spec) "
                "VALUES ($1, $2, '{}'::jsonb) "
                "RETURNING id",
                app_id,
                f"agent_{uuid.uuid4().hex[:8]}",
            )

            # Create stale run: status='running', heartbeat 60 seconds ago, attempt=1
            await c.execute(
                """
                INSERT INTO agent_runs
                (id, app_id, agent_id, caller_kind, input, status, last_heartbeat, attempt)
                VALUES ($1, $2, $3, 'function', '{}'::jsonb, 'running',
                        now() - interval '60 seconds', 1)
                """,
                stale_id, app_id, agent_id,
            )

            # Create fresh run: status='running', heartbeat now, attempt=1
            await c.execute(
                """
                INSERT INTO agent_runs
                (id, app_id, agent_id, caller_kind, input, status, last_heartbeat, attempt)
                VALUES ($1, $2, $3, 'function', '{}'::jsonb, 'running', now(), 1)
                """,
                fresh_id, app_id, agent_id,
            )

        # Call recovery with stale_after_seconds=30
        recovered_ids = await recover_stale_runs(pg_pool, stale_after_seconds=30)

        # Verify returned list contains only stale run
        assert len(recovered_ids) == 1
        assert recovered_ids[0] == str(stale_id)

        # Verify stale run was updated: status='queued', attempt=2
        async with pg_pool.acquire() as c:
            stale_row = await c.fetchrow(
                "SELECT status, attempt FROM agent_runs WHERE id = $1",
                stale_id,
            )
            assert stale_row["status"] == "queued"
            assert stale_row["attempt"] == 2

            # Verify fresh run was NOT updated: status='running', attempt=1
            fresh_row = await c.fetchrow(
                "SELECT status, attempt FROM agent_runs WHERE id = $1",
                fresh_id,
            )
            assert fresh_row["status"] == "running"
            assert fresh_row["attempt"] == 1
    finally:
        # Clean up test data
        async with pg_pool.acquire() as c:
            await c.execute("DELETE FROM agent_runs WHERE id = $1", stale_id)
            await c.execute("DELETE FROM agent_runs WHERE id = $1", fresh_id)
            await c.execute("DELETE FROM agents WHERE app_id = $1", app_id)
            await c.execute("DELETE FROM apps WHERE id = $1", app_id)
