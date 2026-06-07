import pytest
from agent_runtime.tools.builtin import make_builtin_tool


class FakeClient:
    def __init__(self): self.calls = []
    async def call_builtin(self, **kwargs):
        self.calls.append(kwargs)
        return {"ok": True, "result": {"rows": [{"id": 1}]}}


@pytest.mark.asyncio
async def test_query_table_handler_calls_client():
    c = FakeClient()
    tool = make_builtin_tool(
        "query_table", client=c, app_id="a", run_id="r",
        caller_kind="end_user", caller_user_id="u",
    )
    out = await tool.handler({"table": "tasks"})
    assert out == {"rows": [{"id": 1}]}
    assert c.calls[0]["tool_name"] == "query_table"
    assert c.calls[0]["caller_user_id"] == "u"
    assert tool.mode == "read_only" and tool.exposed_to == "end_user"


@pytest.mark.asyncio
async def test_unknown_builtin_raises():
    from agent_runtime.tools.base import ToolError
    with pytest.raises(ToolError):
        make_builtin_tool("nope", client=FakeClient(), app_id="a", run_id="r",
                          caller_kind="function", caller_user_id=None)
