"""Tests for compiler event emission and checkpointing (Task 7)."""

import pytest

from agent_runtime.compiler import compile_graph, Interrupted
from agent_runtime.spec import GraphSpec
from agent_runtime.tools.base import ToolRegistry


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------

class FakeEmitter:
    def __init__(self):
        self.events: list[tuple[str, dict]] = []

    async def emit(self, type_: str, payload: dict) -> int:
        self.events.append((type_, payload))
        return len(self.events)

    def types(self) -> list[str]:
        return [t for t, _ in self.events]

    def payload_for(self, type_: str) -> dict | None:
        for t, p in self.events:
            if t == type_:
                return p
        return None

    def all_payloads_for(self, type_: str) -> list[dict]:
        return [p for t, p in self.events if t == type_]


class FakeCheckpointer:
    def __init__(self):
        self.saves: list[dict] = []

    async def save(self, *, step: int, node_id: str, state: dict) -> None:
        self.saves.append({"step": step, "node_id": node_id, "state": dict(state)})


class FakeCancelToken:
    def __init__(self, cancelled: bool = False):
        self._cancelled = cancelled

    def is_cancelled(self) -> bool:
        return self._cancelled


class FakeOpenRouter:
    def __init__(self, reply: str = "hello"):
        self.reply = reply
        self.calls: list[dict] = []

    async def chat_completion(self, **kwargs):
        self.calls.append(kwargs)
        return {
            "message": {"role": "assistant", "content": self.reply},
            "finish_reason": "stop",
            "usage": {"prompt_tokens": 5, "completion_tokens": 3},
        }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _two_node_spec() -> GraphSpec:
    """A minimal 2-node spec: llm (triage) → end (done)."""
    return GraphSpec.model_validate(
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
                },
                "done": {"type": "end", "output_template": "{{ state.reply }}"},
            },
            "edges": [{"from": "triage", "to": "done"}],
            "tools": {"builtin": [], "mcp_servers": [], "functions": []},
            "limits": {
                "max_steps": 10,
                "max_tool_calls": 0,
                "max_parallel_tools": 1,
                "timeout_seconds": 60,
                "human_timeout_seconds": 86400,
            },
        }
    )


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_emitter_receives_run_start_and_end():
    spec = _two_node_spec()
    emitter = FakeEmitter()
    fake = FakeOpenRouter(reply="hello")

    runner = compile_graph(
        spec,
        openrouter=fake,
        registry=ToolRegistry(),
        caller_kind="function",
        emitter=emitter,
    )
    result = await runner({"user_input": "hi"})

    assert result["output"] == "hello"
    types = emitter.types()
    assert "run_start" in types
    assert "run_end" in types

    run_start_payload = emitter.payload_for("run_start")
    assert run_start_payload is not None
    assert "input" in run_start_payload

    run_end_payload = emitter.payload_for("run_end")
    assert run_end_payload is not None
    assert run_end_payload["output"] == "hello"


@pytest.mark.asyncio
async def test_emitter_receives_node_start_and_end_for_triage():
    spec = _two_node_spec()
    emitter = FakeEmitter()
    fake = FakeOpenRouter(reply="hello")

    runner = compile_graph(
        spec,
        openrouter=fake,
        registry=ToolRegistry(),
        caller_kind="function",
        emitter=emitter,
    )
    await runner({"user_input": "hi"})

    node_starts = emitter.all_payloads_for("node_start")
    node_ends = emitter.all_payloads_for("node_end")

    triage_starts = [p for p in node_starts if p["node_id"] == "triage"]
    triage_ends = [p for p in node_ends if p["node_id"] == "triage"]

    assert len(triage_starts) == 1, f"Expected 1 node_start for triage, got: {node_starts}"
    assert len(triage_ends) == 1, f"Expected 1 node_end for triage, got: {node_ends}"
    assert triage_starts[0]["step"] == triage_ends[0]["step"]


@pytest.mark.asyncio
async def test_emitter_receives_llm_token_usage():
    spec = _two_node_spec()
    emitter = FakeEmitter()
    fake = FakeOpenRouter(reply="hello")

    runner = compile_graph(
        spec,
        openrouter=fake,
        registry=ToolRegistry(),
        caller_kind="function",
        emitter=emitter,
    )
    await runner({"user_input": "hi"})

    usage_events = emitter.all_payloads_for("llm_token_usage")
    assert len(usage_events) >= 1
    assert usage_events[0]["prompt"] == 5
    assert usage_events[0]["completion"] == 3


@pytest.mark.asyncio
async def test_checkpointer_saves_after_llm_node():
    spec = _two_node_spec()
    checkpointer = FakeCheckpointer()
    fake = FakeOpenRouter(reply="hello")

    runner = compile_graph(
        spec,
        openrouter=fake,
        registry=ToolRegistry(),
        caller_kind="function",
        checkpointer=checkpointer,
    )
    await runner({"user_input": "hi"})

    # Should have saved after the triage (llm) node, not the end node
    assert len(checkpointer.saves) >= 1
    triage_saves = [s for s in checkpointer.saves if s["node_id"] == "triage"]
    assert len(triage_saves) == 1
    assert triage_saves[0]["step"] == 1
    assert "reply" in triage_saves[0]["state"]


@pytest.mark.asyncio
async def test_cancel_token_raises_cancelled_error():
    spec = _two_node_spec()
    cancel_token = FakeCancelToken(cancelled=True)
    fake = FakeOpenRouter(reply="hello")

    runner = compile_graph(
        spec,
        openrouter=fake,
        registry=ToolRegistry(),
        caller_kind="function",
        cancel_token=cancel_token,
    )

    import asyncio
    with pytest.raises(asyncio.CancelledError):
        await runner({"user_input": "hi"})


@pytest.mark.asyncio
async def test_run_without_optional_params():
    """compile_graph works with no emitter/checkpointer/cancel_token (backward compat)."""
    spec = _two_node_spec()
    fake = FakeOpenRouter(reply="world")

    runner = compile_graph(
        spec,
        openrouter=fake,
        registry=ToolRegistry(),
        caller_kind="function",
    )
    result = await runner({"user_input": "test"})
    assert result["output"] == "world"


@pytest.mark.asyncio
async def test_resume_step_skips_already_executed_nodes():
    """When resume_step=1, the triage node (step 1) is skipped."""
    spec = _two_node_spec()
    emitter = FakeEmitter()
    # Pre-populate state as if triage already ran
    fake = FakeOpenRouter(reply="hello")

    runner = compile_graph(
        spec,
        openrouter=fake,
        registry=ToolRegistry(),
        caller_kind="function",
        emitter=emitter,
        resume_step=1,
    )
    # Provide pre-computed reply in state so end node can render
    result = await runner({"user_input": "hi", "reply": "pre-computed"})

    # run_start should NOT be emitted when resume_step > 0
    assert "run_start" not in emitter.types()

    # triage node_start should NOT appear (step 1 <= resume_step 1)
    node_starts = emitter.all_payloads_for("node_start")
    triage_starts = [p for p in node_starts if p["node_id"] == "triage"]
    assert len(triage_starts) == 0

    # Output should use the pre-computed state
    assert result["output"] == "pre-computed"


@pytest.mark.asyncio
async def test_interrupted_exception_class():
    """Interrupted exception carries payload and message."""
    exc = Interrupted({"reason": "hitl", "data": 42})
    assert exc.payload == {"reason": "hitl", "data": 42}
    assert str(exc) == "agent run interrupted"


@pytest.mark.asyncio
async def test_emitter_event_order():
    """Events should be in order: run_start, node_start(triage), node_end(triage), run_end."""
    spec = _two_node_spec()
    emitter = FakeEmitter()
    fake = FakeOpenRouter(reply="hello")

    runner = compile_graph(
        spec,
        openrouter=fake,
        registry=ToolRegistry(),
        caller_kind="function",
        emitter=emitter,
    )
    await runner({"user_input": "hi"})

    types = emitter.types()
    # run_start must be first
    assert types[0] == "run_start"
    # run_end must be last
    assert types[-1] == "run_end"
    # node_start(triage) before node_end(triage)
    triage_start_idx = next(
        i for i, (t, p) in enumerate(emitter.events)
        if t == "node_start" and p.get("node_id") == "triage"
    )
    triage_end_idx = next(
        i for i, (t, p) in enumerate(emitter.events)
        if t == "node_end" and p.get("node_id") == "triage"
    )
    assert triage_start_idx < triage_end_idx
