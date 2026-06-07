"""Tests for run lifecycle HTTP routes: start, cancel, resume (Task 10).

Uses httpx AsyncClient with a minimal FastAPI app that has the runs router
wired up and app.state pre-populated with live pg_pool / redis_pool fixtures.
"""

import asyncio
import json
import uuid

import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import AsyncClient, ASGITransport

from agent_runtime.routes import runs


# ---------------------------------------------------------------------------
# Test app fixture
# ---------------------------------------------------------------------------

TOKEN = "test-internal-token"


class _FakeConfig:
    internal_service_token = TOKEN
    openrouter_api_key = "sk-test"
    openrouter_base_url = "https://openrouter.ai/api/v1"


class _FakeRedis:
    """Wraps the live redis_pool so .client is accessible."""
    def __init__(self, redis_pool):
        self._pool = redis_pool

    @property
    def client(self):
        return self._pool.client


def _make_app(pg_pool, redis_pool, run_agent_fn=None):
    app = FastAPI()
    app.include_router(runs.router)
    app.state.config = _FakeConfig()
    app.state.pool = pg_pool
    app.state.redis = _FakeRedis(redis_pool)
    app.state.control_api = None
    app.state.encryption_key = b""
    app.state.run_tasks = set()
    if run_agent_fn is not None:
        app.state.run_agent_fn = run_agent_fn
    return app


# ---------------------------------------------------------------------------
# Seed helpers
# ---------------------------------------------------------------------------

async def _seed_run(pg_pool, *, status="queued", with_graph=True):
    """Insert a minimal run row; return run_id (str)."""
    run_id = str(uuid.uuid4())

    graph_spec = json.dumps({
        "spec_version": "1",
        "entry": "done",
        "nodes": {"done": {"type": "end", "output_template": "ok"}},
        "edges": [],
        "tools": {"builtin": [], "mcp_servers": [], "functions": []},
        "limits": {
            "max_steps": 5,
            "max_tool_calls": 5,
            "max_parallel_tools": 1,
            "timeout_seconds": 60,
            "human_timeout_seconds": 86400,
            "heartbeat_seconds": 5,
        },
    }) if with_graph else "{}"

    async with pg_pool.acquire() as c:
        await c.execute(
            "INSERT INTO apps "
            "(id, owner_id, name, db_name, region, provisioning_status, deployment_backend, access_mode) "
            "VALUES ($1, $2, $3, $4, $5, $6, $7, $8) "
            "ON CONFLICT (id) DO NOTHING",
            "app_lifecycle_test",
            "00000000-0000-0000-0000-000000000001",
            "Lifecycle Test App",
            f"lc_test_{uuid.uuid4().hex[:8]}",
            "local",
            "ready",
            "pages",
            "public",
        )
        agent_id = await c.fetchval(
            "INSERT INTO agents (app_id, name, graph_spec) "
            "VALUES ($1, $2, $3::jsonb) "
            "ON CONFLICT (app_id, name) DO UPDATE SET graph_spec=EXCLUDED.graph_spec "
            "RETURNING id",
            "app_lifecycle_test",
            f"agent_{uuid.uuid4().hex[:8]}",
            graph_spec,
        )
        await c.execute(
            "INSERT INTO agent_runs (id, app_id, agent_id, caller_kind, input, status) "
            "VALUES ($1, $2, $3, 'function', '{}'::jsonb, $4)",
            uuid.UUID(run_id),
            "app_lifecycle_test",
            agent_id,
            status,
        )

    return run_id


async def _cleanup_run(pg_pool, run_id: str):
    async with pg_pool.acquire() as c:
        await c.execute("DELETE FROM agent_runs WHERE id = $1", uuid.UUID(run_id))


# ---------------------------------------------------------------------------
# Test 1: start returns 202 immediately (fire-and-forget)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_start_returns_202_immediately(pg_pool, redis_pool):
    """POST /start should return 202 without waiting for the runner to finish."""
    started = asyncio.Event()
    finished = asyncio.Event()

    async def slow_runner(**kwargs):
        started.set()
        await asyncio.sleep(0.2)
        finished.set()

    run_id = await _seed_run(pg_pool)
    try:
        app = _make_app(pg_pool, redis_pool, run_agent_fn=slow_runner)
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post(
                f"/internal/runs/{run_id}/start",
                headers={"x-internal-service-token": TOKEN},
            )

        assert resp.status_code == 202
        data = resp.json()
        assert data["run_id"] == run_id
        assert data["status"] == "queued"

        # Response returned before runner finished
        assert not finished.is_set()

        # Let background tasks drain
        if app.state.run_tasks:
            await asyncio.gather(*app.state.run_tasks, return_exceptions=True)

        assert started.is_set()
        assert finished.is_set()
    finally:
        await _cleanup_run(pg_pool, run_id)


# ---------------------------------------------------------------------------
# Test 2: cancel sets DB flag and publishes Redis message
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_cancel_sets_db_flag_and_publishes(pg_pool, redis_pool):
    """POST /cancel should set cancel_requested=TRUE and publish to Redis."""
    run_id = await _seed_run(pg_pool)
    # Move to 'running' so cancel actually transitions to 'cancelling'.
    async with pg_pool.acquire() as c:
        await c.execute(
            "UPDATE agent_runs SET status='running' WHERE id=$1",
            uuid.UUID(run_id),
        )
    try:
        app = _make_app(pg_pool, redis_pool)

        # Subscribe before cancelling so we catch the message
        pubsub = redis_pool.client.pubsub()
        channel = f"agent_runs:{run_id}:cancel"
        await pubsub.subscribe(channel)
        # Drain the subscribe confirmation message
        await pubsub.get_message(ignore_subscribe_messages=True, timeout=0.1)

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post(
                f"/internal/runs/{run_id}/cancel",
                headers={"x-internal-service-token": TOKEN},
            )

        assert resp.status_code == 202
        data = resp.json()
        assert data["run_id"] == run_id
        assert data["status"] == "cancelling"

        # Verify DB flag
        async with pg_pool.acquire() as c:
            row = await c.fetchrow(
                "SELECT cancel_requested FROM agent_runs WHERE id = $1",
                uuid.UUID(run_id),
            )
        assert row["cancel_requested"] is True

        # Wait for pubsub message
        msg = None
        for _ in range(20):
            msg = await pubsub.get_message(ignore_subscribe_messages=True, timeout=0.1)
            if msg is not None:
                break
        assert msg is not None, "No cancel message received on pubsub channel"
        assert msg["data"] in (b"1", "1")

        await pubsub.unsubscribe(channel)
        await pubsub.aclose()
    finally:
        await _cleanup_run(pg_pool, run_id)


# ---------------------------------------------------------------------------
# Test 3: resume rejects when run is not paused
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_resume_rejects_when_not_paused(pg_pool, redis_pool):
    """POST /resume on a queued (not paused) run should return 404."""
    run_id = await _seed_run(pg_pool, status="queued")
    try:
        app = _make_app(pg_pool, redis_pool)
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post(
                f"/internal/runs/{run_id}/resume",
                json={"input": {"approved": True}},
                headers={"x-internal-service-token": TOKEN},
            )
        assert resp.status_code == 404
        assert "not paused" in resp.json()["detail"]
    finally:
        await _cleanup_run(pg_pool, run_id)


# ---------------------------------------------------------------------------
# Bonus Test: resume succeeds when run is paused
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_resume_succeeds_when_paused(pg_pool, redis_pool):
    """POST /resume on a paused run should set status=queued, increment attempt,
    and set resume_input, then spawn the runner."""
    called = asyncio.Event()

    async def capturing_runner(**kwargs):
        called.set()

    run_id = await _seed_run(pg_pool, status="paused")
    try:
        app = _make_app(pg_pool, redis_pool, run_agent_fn=capturing_runner)
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post(
                f"/internal/runs/{run_id}/resume",
                json={"input": {"approved": True}},
                headers={"x-internal-service-token": TOKEN},
            )

        assert resp.status_code == 202
        data = resp.json()
        assert data["run_id"] == run_id
        assert data["status"] == "queued"

        # Drain background tasks
        if app.state.run_tasks:
            await asyncio.gather(*app.state.run_tasks, return_exceptions=True)

        # Verify DB was updated
        async with pg_pool.acquire() as c:
            row = await c.fetchrow(
                "SELECT status, resume_input, attempt FROM agent_runs WHERE id = $1",
                uuid.UUID(run_id),
            )
        # The runner stub doesn't update status to 'running', so it stays 'queued'
        # (claim query updates status, but our stub doesn't call the real runner).
        # We verify resume_input and attempt were set by the route.
        resume_input = row["resume_input"]
        if isinstance(resume_input, str):
            resume_input = json.loads(resume_input)
        assert resume_input == {"approved": True}
        assert row["attempt"] >= 1

        assert called.is_set()
    finally:
        await _cleanup_run(pg_pool, run_id)
