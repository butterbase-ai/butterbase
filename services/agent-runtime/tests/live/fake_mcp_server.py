"""Minimal fake MCP server using the official `mcp` SDK's server primitives.

Exposes one tool: echo(text: str) -> str, returning f"echoed: {text}".
Uses streamable-http transport via Starlette + uvicorn.

Run:
    python services/agent-runtime/tests/live/fake_mcp_server.py [PORT]

Default port: 7142.
"""

import contextlib
import sys
from collections.abc import AsyncIterator

import uvicorn
from mcp.server.lowlevel.server import Server
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
import mcp.types as types
from starlette.applications import Starlette
from starlette.routing import Mount


server = Server("fake-mcp")


@server.list_tools()
async def list_tools() -> list[types.Tool]:
    return [
        types.Tool(
            name="echo",
            description="Echo back the given text.",
            inputSchema={
                "type": "object",
                "properties": {"text": {"type": "string"}},
                "required": ["text"],
            },
        )
    ]


@server.call_tool()
async def call_tool(
    name: str, arguments: dict
) -> list[types.TextContent | types.ImageContent | types.EmbeddedResource]:
    if name == "echo":
        text = arguments.get("text", "")
        return [types.TextContent(type="text", text=f"echoed: {text}")]
    raise ValueError(f"unknown tool: {name}")


def build_app(port: int) -> Starlette:
    session_manager = StreamableHTTPSessionManager(
        app=server,
        json_response=True,
        stateless=True,
    )

    # Pure ASGI handler — session_manager streams the response itself, so we
    # must NOT wrap it in a Starlette endpoint (which would try to send a
    # second response).
    async def asgi_handler(scope, receive, send):
        await session_manager.handle_request(scope, receive, send)

    @contextlib.asynccontextmanager
    async def lifespan(app: Starlette) -> AsyncIterator[None]:
        async with session_manager.run():
            yield

    return Starlette(
        routes=[Mount("/mcp", app=asgi_handler)],
        lifespan=lifespan,
    )


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 7142
    app = build_app(port)
    sys.stderr.write(f"fake-mcp-server listening on :{port}\n")
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="warning")


if __name__ == "__main__":
    main()
