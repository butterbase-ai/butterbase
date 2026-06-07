import pytest
from fastapi import FastAPI, Request
from httpx import ASGITransport, AsyncClient
from agent_runtime.control_api_client import ControlApiClient


@pytest.mark.asyncio
async def test_call_builtin():
    app = FastAPI()

    @app.post("/internal/agent-tools/builtin/query_table")
    async def h(req: Request):
        body = await req.json()
        assert req.headers["x-internal-service-token"] == "t1"
        return {"ok": True, "result": {"rows": [], "row_count": 0,
                                       "echo": body["args"]}}

    transport = ASGITransport(app=app)
    client = ControlApiClient(base_url="http://test", token="t1")
    client._client = AsyncClient(transport=transport, base_url="http://test")
    r = await client.call_builtin(
        tool_name="query_table", app_id="a", run_id="r",
        caller_kind="end_user", caller_user_id="u", args={"table": "t"},
    )
    assert r == {"ok": True, "result": {"rows": [], "row_count": 0,
                                        "echo": {"table": "t"}}}
