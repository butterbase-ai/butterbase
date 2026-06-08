import pytest
from agent_runtime.tools.mcp_client import MCPPool, MCPServerSpec


class FakeSession:
    async def initialize(self): pass
    async def list_tools(self):
        from types import SimpleNamespace
        return SimpleNamespace(tools=[
            SimpleNamespace(name="echo", description="Echo back",
                            inputSchema={"type": "object",
                                         "properties": {"text": {"type": "string"}}}),
        ])
    async def call_tool(self, name, args):
        from types import SimpleNamespace
        return SimpleNamespace(
            isError=False,
            content=[SimpleNamespace(type="text", text=f"ok:{args}")],
        )


@pytest.mark.asyncio
async def test_mcp_pool_exposes_allow_listed_tools(monkeypatch):
    pool = MCPPool(caller_kind="function")

    async def fake_connect(self, spec):
        return FakeSession()

    monkeypatch.setattr(MCPPool, "_connect", fake_connect)

    spec = MCPServerSpec(
        server_id="s1", name="ext", transport="http", url="http://ext",
        auth_header=None, tool_acl={}, allow_tools=["echo"], spec_overrides={},
    )
    tools = await pool.open([spec])
    assert len(tools) == 1
    out = await tools[0].handler({"text": "hi"})
    assert out.startswith("ok:")
    await pool.close()
