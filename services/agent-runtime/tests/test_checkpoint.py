"""Test the Checkpointer save/load round-trip."""
import pytest

from agent_runtime.checkpoint import Checkpointer


@pytest.mark.asyncio
async def test_save_and_load_latest(pg_pool, seed_run):
    cp = Checkpointer(pool=pg_pool, run_id=seed_run)
    await cp.save(step=1, node_id="triage", state={"x": 1})
    await cp.save(step=2, node_id="done", state={"x": 1, "result": "ok"})
    latest = await cp.load_latest()
    assert latest == (2, "done", {"x": 1, "result": "ok"})


@pytest.mark.asyncio
async def test_load_latest_none_when_empty(pg_pool, seed_run):
    cp = Checkpointer(pool=pg_pool, run_id=seed_run)
    assert await cp.load_latest() is None


@pytest.mark.asyncio
async def test_save_overwrites_same_step(pg_pool, seed_run):
    cp = Checkpointer(pool=pg_pool, run_id=seed_run)
    await cp.save(step=1, node_id="a", state={"v": "first"})
    await cp.save(step=1, node_id="b", state={"v": "second"})
    latest = await cp.load_latest()
    assert latest == (1, "b", {"v": "second"})
