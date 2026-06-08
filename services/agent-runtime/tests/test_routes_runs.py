# tests/test_routes_runs.py
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI
from httpx import ASGITransport

from agent_runtime.config import Config
from agent_runtime.routes.runs import router


def _make_app(*, run_agent_fn: AsyncMock | None = None, token: str = "") -> FastAPI:
    """Build a stripped-down ASGI app that satisfies routes/runs.py's
    app.state contract: pool, config, redis.client, run_tasks,
    encryption_key, control_api, run_agent_fn override."""
    app = FastAPI()
    app.state.pool = AsyncMock()
    app.state.config = SimpleNamespace(
        openrouter_api_key="sk-test",
        openrouter_base_url="https://example.invalid",
        internal_service_token=token,
    )
    app.state.redis = SimpleNamespace(client=AsyncMock())
    app.state.run_tasks = set()
    app.state.encryption_key = b""
    app.state.control_api = None
    app.state.run_agent_fn = run_agent_fn or AsyncMock(return_value=None)
    app.include_router(router)
    return app


async def _drain_background_tasks(app: FastAPI) -> None:
    """Wait for any tasks _schedule_run created so we can assert on the
    runner mock after the route's fire-and-forget 202 has returned."""
    pending = list(app.state.run_tasks)
    if pending:
        await asyncio.gather(*pending, return_exceptions=True)


@pytest.mark.asyncio
async def test_start_calls_run_agent_with_run_id():
    runner = AsyncMock(return_value=None)
    app = _make_app(run_agent_fn=runner)

    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        response = await c.post("/internal/runs/abc-123/start")

    assert response.status_code == 202
    assert response.json() == {"run_id": "abc-123", "status": "queued"}

    await _drain_background_tasks(app)
    runner.assert_awaited_once()
    call_kwargs = runner.await_args.kwargs
    assert call_kwargs["run_id"] == "abc-123"


@pytest.mark.asyncio
async def test_start_swallows_runner_errors_into_background_log():
    """The route is fire-and-forget — it returns 202 even when the
    runner raises, and the exception is logged inside the background
    task rather than surfaced to the caller."""
    runner = AsyncMock(side_effect=RuntimeError("boom"))
    app = _make_app(run_agent_fn=runner)

    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        response = await c.post("/internal/runs/abc-123/start")

    assert response.status_code == 202
    assert response.json() == {"run_id": "abc-123", "status": "queued"}

    await _drain_background_tasks(app)
    runner.assert_awaited_once()


@pytest.mark.asyncio
async def test_start_run_requires_token():
    app = FastAPI()
    app.state.pool = AsyncMock()
    app.state.config = Config(
        pool_urls={"local": "postgresql://test"},
        internal_service_token="t1",
    )
    app.state.run_agent_fn = AsyncMock(return_value=None)
    app.include_router(router)

    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        r = await c.post("/internal/runs/abc/start")
        assert r.status_code == 401
