import json
import pytest
from agent_runtime.spec import GraphSpec
from agent_runtime.compiler import compile_graph
from agent_runtime.tools.base import Tool, ToolRegistry


class FakeOpenRouter:
    def __init__(self, scripted):
        self.scripted = list(scripted)
        self.calls = []

    async def chat_completion(self, **kwargs):
        self.calls.append(kwargs)
        return self.scripted.pop(0)


@pytest.mark.asyncio
async def test_llm_calls_tool_then_replies():
    async def echo_handler(args):
        return {"echoed": args}

    reg = ToolRegistry()
    reg.add(Tool(
        name="echo", description="", args_schema={"type": "object"},
        handler=echo_handler, source="builtin",
        mode="read_only", exposed_to="end_user",
    ))

    fake = FakeOpenRouter([
        {
            "message": {
                "role": "assistant",
                "tool_calls": [{
                    "id": "c1",
                    "type": "function",
                    "function": {"name": "echo", "arguments": json.dumps({"x": 1})},
                }],
            },
            "usage": {"prompt_tokens": 7, "completion_tokens": 5},
            "finish_reason": "tool_calls",
        },
        {
            "message": {"role": "assistant", "content": "done"},
            "usage": {"prompt_tokens": 3, "completion_tokens": 2},
            "finish_reason": "stop",
        },
    ])

    spec = GraphSpec.model_validate({
        "spec_version": "1", "entry": "a",
        "nodes": {
            "a": {
                "type": "llm", "model": "m", "system_prompt": "", "input_template": "",
                "output_key": "out",
                "tools": [{"source": "builtin", "name": "echo"}],
            },
            "z": {"type": "end", "output_template": "{{ state.out }}"},
        },
        "edges": [{"from": "a", "to": "z"}],
        "tools": {"builtin": ["echo"], "mcp_servers": [], "functions": []},
        "limits": {
            "max_steps": 10, "max_tool_calls": 5, "max_parallel_tools": 2,
            "timeout_seconds": 30, "human_timeout_seconds": 3600,
        },
    })
    runner = compile_graph(spec, openrouter=fake, registry=reg, caller_kind="function")
    result = await runner({})
    assert result["output"] == "done"
    assert result["usage"] == {"prompt_tokens": 10, "completion_tokens": 7}


@pytest.mark.asyncio
async def test_tool_node_renders_args_and_writes_output():
    async def h(args):
        return f"sent to {args['to']}"

    reg = ToolRegistry()
    reg.add(Tool(
        name="send", description="", args_schema={"type": "object"},
        handler=h, source="function",
        mode="read_write", exposed_to="developer_only",
    ))

    spec = GraphSpec.model_validate({
        "spec_version": "1", "entry": "t",
        "nodes": {
            "t": {
                "type": "tool",
                "tool_ref": {"source": "function", "name": "send"},
                "args_template": {"to": "{{ state.user_input }}"},
                "output_key": "out",
            },
            "z": {"type": "end", "output_template": "{{ state.out }}"},
        },
        "edges": [{"from": "t", "to": "z"}],
        "tools": {"builtin": [], "mcp_servers": [], "functions": ["send"]},
        "limits": {
            "max_steps": 5, "max_tool_calls": 5, "max_parallel_tools": 1,
            "timeout_seconds": 30, "human_timeout_seconds": 3600,
        },
    })
    runner = compile_graph(spec, openrouter=None, registry=reg, caller_kind="function")
    result = await runner({"user_input": "alice@example.com"})
    assert result["output"] == "sent to alice@example.com"
