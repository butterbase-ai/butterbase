"""Test the Heartbeat updates last_heartbeat regularly and stops cleanly."""
import asyncio
import uuid

import pytest

from agent_runtime.heartbeat import Heartbeat


@pytest.mark.asyncio
async def test_heartbeat_updates_row(pg_pool, seed_run):
    hb = Heartbeat(pool=pg_pool, run_id=seed_run, interval_seconds=0.1)
    await hb.start()
    try:
        # initial tick happened in start(); wait for at least one more.
        await asyncio.sleep(0.35)
    finally:
        await hb.stop()

    async with pg_pool.acquire() as c:
        row = await c.fetchrow(
            "SELECT last_heartbeat FROM agent_runs WHERE id = $1::uuid",
            seed_run,
        )
    assert row["last_heartbeat"] is not None


@pytest.mark.asyncio
async def test_heartbeat_initial_tick_runs_synchronously(pg_pool, seed_run):
    hb = Heartbeat(pool=pg_pool, run_id=seed_run, interval_seconds=10.0)
    # before start: last_heartbeat is null
    async with pg_pool.acquire() as c:
        row = await c.fetchrow(
            "SELECT last_heartbeat FROM agent_runs WHERE id = $1::uuid",
            seed_run,
        )
    assert row["last_heartbeat"] is None

    await hb.start()
    try:
        # immediately after start, last_heartbeat should be populated.
        async with pg_pool.acquire() as c:
            row = await c.fetchrow(
                "SELECT last_heartbeat FROM agent_runs WHERE id = $1::uuid",
                seed_run,
            )
        assert row["last_heartbeat"] is not None
    finally:
        await hb.stop()


@pytest.mark.asyncio
async def test_heartbeat_stop_is_prompt(pg_pool, seed_run):
    hb = Heartbeat(pool=pg_pool, run_id=seed_run, interval_seconds=10.0)
    await hb.start()
    # stop should not block for the full 10 seconds.
    await asyncio.wait_for(hb.stop(), timeout=2.0)
