import pytest

from agent_runtime.compiler import compile_graph
from agent_runtime.spec import GraphSpec
from agent_runtime.tools.base import ToolRegistry


def _basic_spec() -> GraphSpec:
    return GraphSpec.model_validate(
        {
            "spec_version": "1",
            "entry": "answer",
            "nodes": {
                "answer": {
                    "type": "llm",
                    "model": "anthropic/claude-3.5-sonnet",
                    "system_prompt": "Be brief.",
                    "input_template": "Echo: {{ state.user_input }}",
                    "output_key": "reply",
                },
                "done": {"type": "end", "output_template": "{{ state.reply }}"},
            },
            "edges": [{"from": "answer", "to": "done"}],
            "tools": {"builtin": [], "mcp_servers": [], "functions": []},
            "limits": {
                "max_steps": 10, "max_tool_calls": 0, "max_parallel_tools": 1,
                "timeout_seconds": 60, "human_timeout_seconds": 86400,
            },
        }
    )


class FakeOpenRouter:
    def __init__(self, reply: str):
        self.reply = reply
        self.calls: list[dict] = []

    async def chat_completion(self, **kwargs):
        self.calls.append(kwargs)
        return {
            "message": {"role": "assistant", "content": self.reply},
            "finish_reason": "stop",
            "usage": {"prompt_tokens": 3, "completion_tokens": 4},
        }


@pytest.mark.asyncio
async def test_compile_executes_llm_then_end():
    spec = _basic_spec()
    fake = FakeOpenRouter(reply="echoed: hi")
    runner = compile_graph(spec, openrouter=fake, registry=ToolRegistry(), caller_kind="function")
    result = await runner({"user_input": "hi"})
    assert result["output"] == "echoed: hi"
    assert result["state"]["reply"] == "echoed: hi"
    assert fake.calls[0]["model"] == "anthropic/claude-3.5-sonnet"
    # New signature: messages list instead of user= kwarg
    msgs = fake.calls[0]["messages"]
    assert any("Echo: hi" in (m.get("content") or "") for m in msgs)


@pytest.mark.asyncio
async def test_step_limit_enforced():
    spec = _basic_spec()
    spec = spec.model_copy(update={"limits": spec.limits.model_copy(update={"max_steps": 1})})
    fake = FakeOpenRouter(reply="x")
    runner = compile_graph(spec, openrouter=fake, registry=ToolRegistry(), caller_kind="function")
    with pytest.raises(RuntimeError, match="max_steps"):
        await runner({"user_input": "hi"})
