# tests/test_routes_runs.py
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from httpx import ASGITransport

from agent_runtime.config import Config
from agent_runtime.routes.runs import router


@pytest.fixture
def app_with_route():
    app = FastAPI()
    app.state.pool = AsyncMock()
    app.state.config = type(
        "C", (), {"openrouter_api_key": "sk-test"}
    )
    app.state.run_agent_fn = AsyncMock(return_value=None)
    app.include_router(router)
    return app


def test_start_calls_run_agent_with_run_id(app_with_route):
    client = TestClient(app_with_route)
    response = client.post("/internal/runs/abc-123/start")
    assert response.status_code == 202
    assert response.json() == {"run_id": "abc-123", "status": "started"}
    app_with_route.state.run_agent_fn.assert_awaited_once()
    call_kwargs = app_with_route.state.run_agent_fn.await_args.kwargs
    assert call_kwargs["run_id"] == "abc-123"


def test_start_returns_500_when_runner_raises(app_with_route):
    app_with_route.state.run_agent_fn = AsyncMock(side_effect=RuntimeError("boom"))
    client = TestClient(app_with_route)
    response = client.post("/internal/runs/abc-123/start")
    assert response.status_code == 500
    assert "boom" in response.json()["error"]


@pytest.mark.asyncio
async def test_start_run_requires_token():
    app = FastAPI()
    app.state.pool = AsyncMock()
    app.state.config = Config(
        control_plane_url="postgresql://test",
        internal_service_token="t1",
    )
    app.state.run_agent_fn = AsyncMock(return_value=None)
    app.include_router(router)

    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        r = await c.post("/internal/runs/abc/start")
        assert r.status_code == 401
