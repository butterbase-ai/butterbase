"""Per-run MCP client pool.

Each MCPServerSpec maps to one MCP session. We snapshot the tools/list
response at run start and expose only allow-listed tool names.
"""

from contextlib import AsyncExitStack
from dataclasses import dataclass
from typing import Any

from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client
from mcp.client.sse import sse_client

from agent_runtime.tools.base import Tool, ToolError
from agent_runtime.tools.acl import resolve_acl, AclInputs


@dataclass
class MCPServerSpec:
    server_id: str
    name: str
    transport: str           # http | sse | streamable_http
    url: str
    auth_header: str | None  # already decrypted
    tool_acl: dict[str, Any]
    allow_tools: list[str]
    spec_overrides: dict[str, dict[str, Any]]


class MCPPool:
    def __init__(self, *, caller_kind: str):
        self._stack = AsyncExitStack()
        self._sessions: dict[str, ClientSession] = {}
        self._caller_kind = caller_kind

    async def open(self, specs: list[MCPServerSpec]) -> list[Tool]:
        tools: list[Tool] = []
        for spec in specs:
            session = await self._connect(spec)
            self._sessions[spec.server_id] = session
            listed = await session.list_tools()
            for mcp_tool in listed.tools:
                if mcp_tool.name not in spec.allow_tools:
                    continue
                server_override = spec.tool_acl.get(mcp_tool.name) or {}
                mode, exposed = resolve_acl(AclInputs(
                    source="mcp",
                    default_mode="read_only",
                    default_exposed_to="developer_only",
                    server_override=server_override,
                    spec_override=spec.spec_overrides.get(mcp_tool.name),
                ))
                tools.append(_wrap_mcp_tool(
                    session=session, mcp_tool=mcp_tool,
                    server_id=spec.server_id, mode=mode, exposed_to=exposed,
                ))
        return tools

    async def _connect(self, spec: MCPServerSpec) -> ClientSession:
        headers = {"Authorization": spec.auth_header} if spec.auth_header else {}
        if spec.transport in ("http", "streamable_http"):
            ctx = streamablehttp_client(spec.url, headers=headers)
        elif spec.transport == "sse":
            ctx = sse_client(spec.url, headers=headers)
        else:
            raise ToolError(f"unsupported MCP transport: {spec.transport}")
        read, write, _ = await self._stack.enter_async_context(ctx)
        session = await self._stack.enter_async_context(ClientSession(read, write))
        await session.initialize()
        return session

    async def close(self) -> None:
        await self._stack.aclose()


def _wrap_mcp_tool(*, session: ClientSession, mcp_tool, server_id: str,
                   mode, exposed_to) -> Tool:
    name = mcp_tool.name
    desc = mcp_tool.description or ""
    schema = (
        getattr(mcp_tool, "inputSchema", None)
        or getattr(mcp_tool, "input_schema", None)
        or {"type": "object"}
    )

    async def handler(args: dict[str, Any]) -> Any:
        result = await session.call_tool(name, args)
        if result.isError:
            raise ToolError(_render_mcp_error(result))
        return _render_mcp_content(result.content)

    return Tool(
        name=name, description=desc, args_schema=schema, handler=handler,
        source="mcp", mode=mode, exposed_to=exposed_to, server_id=server_id,
    )


def _render_mcp_content(content) -> Any:
    if not content:
        return None
    parts = []
    for c in content:
        if c.type == "text":
            parts.append(c.text)
        else:
            parts.append({"type": c.type, "data": str(c)})
    return parts[0] if len(parts) == 1 else parts


def _render_mcp_error(result) -> str:
    rendered = _render_mcp_content(result.content)
    return rendered if isinstance(rendered, str) else str(rendered)
