"""Shared pytest fixtures. The full-app fixture requires Postgres + the
runs route, so individual tests build their own stripped-down ASGI apps
where appropriate."""

import os
import uuid

import pytest

import asyncpg

from agent_runtime.redis_client import RedisPool

REDIS_URL = os.environ.get("TEST_REDIS_URL", "redis://localhost:6379")
PG_DSN = os.environ.get(
    "TEST_CONTROL_DB_URL",
    "postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control",
)


@pytest.fixture(autouse=True)
def _stub_env(monkeypatch):
    monkeypatch.setenv(
        "CONTROL_PLANE_URL",
        os.environ.get(
            "CONTROL_PLANE_URL_TEST",
            "postgres://postgres:postgres@localhost:5432/butterbase_control_test",
        ),
    )
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-test")


@pytest.fixture
async def pg_pool():
    pool = await asyncpg.create_pool(PG_DSN, min_size=1, max_size=2)
    try:
        yield pool
    finally:
        await pool.close()


@pytest.fixture
async def redis_pool():
    pool = RedisPool(REDIS_URL)
    await pool.start()
    try:
        yield pool
    finally:
        await pool.close()


@pytest.fixture
async def seed_run(pg_pool):
    run_id = str(uuid.uuid4())
    async with pg_pool.acquire() as c:
        # Need a real app + agent for FK; use existing test fixtures or create.
        await c.execute(
            "INSERT INTO apps "
            "(id, owner_id, name, db_name, region, provisioning_status, deployment_backend, access_mode) "
            "VALUES ($1, $2, $3, $4, $5, $6, $7, $8) "
            "ON CONFLICT (id) DO NOTHING",
            "app_evt_test",
            "00000000-0000-0000-0000-000000000001",
            "Test Event Emitter App",
            f"evt_test_{uuid.uuid4().hex[:8]}",
            "local",
            "ready",
            "pages",
            "public",
        )
        agent_id = await c.fetchval(
            "INSERT INTO agents (app_id, name, graph_spec) "
            "VALUES ($1, $2, '{}'::jsonb) "
            "ON CONFLICT (app_id, name) DO UPDATE SET name=EXCLUDED.name "
            "RETURNING id",
            "app_evt_test", f"agent_{uuid.uuid4().hex[:8]}",
        )
        await c.execute(
            "INSERT INTO agent_runs (id, app_id, agent_id, caller_kind, input) "
            "VALUES ($1, $2, $3, 'function', '{}'::jsonb)",
            uuid.UUID(run_id), "app_evt_test", agent_id,
        )
    try:
        yield run_id
    finally:
        async with pg_pool.acquire() as c:
            await c.execute("DELETE FROM agent_runs WHERE id = $1", uuid.UUID(run_id))
