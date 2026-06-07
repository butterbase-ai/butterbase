"""Tests for human-in-the-loop (HITL) interrupt builtin (Task 8)."""

import pytest

from agent_runtime.compiler import compile_graph, Interrupted
from agent_runtime.spec import GraphSpec
from agent_runtime.tools.base import ToolRegistry, Tool


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------

class FakeOpenRouter:
    """Fake OpenRouter that returns a tool_call to 'interrupt'."""

    def __init__(self):
        self.calls: list[dict] = []

    async def chat_completion(self, **kwargs):
        """Return a tool_call to interrupt with test payload."""
        self.calls.append(kwargs)
        return {
            "message": {
                "role": "assistant",
                "tool_calls": [
                    {
                        "id": "call_123",
                        "function": {
                            "name": "interrupt",
                            "arguments": '{"reason": "needs_approval", "data": {"amount": 500}}'
                        }
                    }
                ]
            },
            "finish_reason": "tool_calls",
            "usage": {"prompt_tokens": 5, "completion_tokens": 3},
        }


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_interrupt_builtin_raises_interrupted_exception():
    """
    Test that the interrupt builtin tool raises Interrupted with the correct payload.

    A minimal graph with one LLM node whose stubbed openrouter returns a tool_call
    to "interrupt" with arguments {"reason": "needs_approval", "data": {"amount": 500}}.
    Compile + run. Assert that Interrupted is raised with the correct payload.
    """
    spec = GraphSpec.model_validate(
        {
            "spec_version": "1",
            "entry": "triage",
            "nodes": {
                "triage": {
                    "type": "llm",
                    "model": "anthropic/claude-3.5-sonnet",
                    "system_prompt": "Be brief.",
                    "input_template": "{{ state.user_input }}",
                    "output_key": "reply",
                    "tools": [
                        {
                            "source": "builtin",
                            "name": "interrupt",
                        }
                    ],
                },
                "done": {"type": "end", "output_template": "{{ state.reply }}"},
            },
            "edges": [{"from": "triage", "to": "done"}],
            "tools": {"builtin": ["interrupt"], "mcp_servers": [], "functions": []},
            "limits": {
                "max_steps": 10,
                "max_tool_calls": 10,
                "max_parallel_tools": 1,
                "timeout_seconds": 60,
                "human_timeout_seconds": 86400,
            },
        }
    )

    # Create a registry with the interrupt tool
    from agent_runtime.tools.builtin import make_builtin_tool

    class FakeClient:
        async def call_builtin(self, **kwargs):
            return {"ok": True, "result": {}}

    registry = ToolRegistry()
    interrupt_tool = make_builtin_tool(
        "interrupt",
        client=FakeClient(),
        app_id="test_app",
        run_id="test_run",
        caller_kind="function",
        caller_user_id=None,
    )
    registry.add(interrupt_tool)

    fake_openrouter = FakeOpenRouter()

    runner = compile_graph(
        spec,
        openrouter=fake_openrouter,
        registry=registry,
        caller_kind="function",
    )

    # Run should raise Interrupted with the payload from the tool_call
    with pytest.raises(Interrupted) as exc_info:
        await runner({"user_input": "test"})

    # Assert the payload matches what was in the tool_call arguments
    assert exc_info.value.payload == {"reason": "needs_approval", "data": {"amount": 500}}
