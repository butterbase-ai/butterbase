"""Uniform tool interface used across builtin / mcp / function sources."""

from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Literal


ToolSource = Literal["builtin", "mcp", "function"]
ToolMode = Literal["read_only", "read_write"]
ToolExposedTo = Literal["developer_only", "end_user"]


class ToolError(Exception):
    """Raised by a tool handler. Surfaces to the model as a tool result."""


class ToolDeniedError(ToolError):
    """Tool exists but ACL refused the call."""


class ToolBudgetError(ToolError):
    """Tool-call budget exhausted (max_tool_calls reached)."""


ToolHandler = Callable[[dict[str, Any]], Awaitable[Any]]


@dataclass
class Tool:
    name: str
    description: str
    args_schema: dict[str, Any]
    handler: ToolHandler
    source: ToolSource
    mode: ToolMode
    exposed_to: ToolExposedTo
    server_id: str | None = None

    def to_openai_tool(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.args_schema,
            },
        }


class ToolBudget:
    def __init__(self, *, max_tool_calls: int, max_parallel_tools: int):
        import asyncio
        self.max_tool_calls = max_tool_calls
        self.max_parallel_tools = max_parallel_tools
        self.used_calls = 0
        self._sem = asyncio.Semaphore(max_parallel_tools)

    async def acquire(self) -> None:
        if self.used_calls >= self.max_tool_calls:
            raise ToolBudgetError(
                f"tool-call budget exhausted (max_tool_calls={self.max_tool_calls})"
            )
        self.used_calls += 1
        await self._sem.acquire()

    def release(self) -> None:
        self._sem.release()


@dataclass
class ToolRegistry:
    tools: dict[str, Tool] = field(default_factory=dict)
    budget: ToolBudget | None = None

    def add(self, tool: Tool) -> None:
        if tool.name in self.tools:
            raise ValueError(f"duplicate tool name: {tool.name}")
        self.tools[tool.name] = tool

    def get(self, name: str) -> Tool:
        if name not in self.tools:
            raise ToolError(f"unknown tool: {name}")
        return self.tools[name]

    def visible(
        self,
        *,
        caller_kind: str,
        allow: list[str] | None = None,
    ) -> list[Tool]:
        out: list[Tool] = []
        for tool in self.tools.values():
            if allow is not None and tool.name not in allow:
                continue
            if caller_kind == "end_user" and tool.exposed_to != "end_user":
                continue
            out.append(tool)
        return out
