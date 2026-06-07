import pytest
from agent_runtime.tools.functions import load_function_tools


class FakeClient:
    async def invoke_function(self, **kw):
        return {"ok": True, "result": {"echo": kw["args"]}}


class FakePool:
    async def fetch(self, _sql, *_args):
        return [{
            "name": "send_email",
            "agent_tool_description": "Send an email",
            "agent_tool_mode": "read_write",
            "agent_tool_exposed_to": "developer_only",
        }]


@pytest.mark.asyncio
async def test_function_tool_invokes_via_callback():
    tools = await load_function_tools(
        client=FakeClient(), pool=FakePool(), app_id="a", run_id="r",
        caller_kind="function", caller_user_id=None,
        allow_names=["send_email"], spec_overrides={},
    )
    assert len(tools) == 1
    out = await tools[0].handler({"to": "x@y"})
    assert out == {"echo": {"to": "x@y"}}
