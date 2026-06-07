"""Tests for runner lifecycle: completion, pause, cancellation (Task 9).

Uses live Postgres (pg_pool + seed_run fixtures) and live Redis (redis_pool).
"""

import asyncio
import json
import uuid

import pytest

from agent_runtime.runner import run_agent


# ---------------------------------------------------------------------------
# Graph spec helpers
# ---------------------------------------------------------------------------

_LIMITS = {
    "max_steps": 10,
    "max_tool_calls": 10,
    "max_parallel_tools": 1,
    "timeout_seconds": 60,
    "human_timeout_seconds": 86400,
    "heartbeat_seconds": 5,
}

_SIMPLE_GRAPH = {
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
    "limits": _LIMITS,
}

# Graph with interrupt tool (for paused test)
_INTERRUPT_GRAPH = {
    "spec_version": "1",
    "entry": "triage",
    "nodes": {
        "triage": {
            "type": "llm",
            "model": "anthropic/claude-3.5-sonnet",
            "system_prompt": "Be brief.",
            "input_template": "{{ state.user_input }}",
            "output_key": "reply",
            "tools": [{"source": "builtin", "name": "interrupt"}],
        },
        "done": {"type": "end", "output_template": "{{ state.reply }}"},
    },
    "edges": [{"from": "triage", "to": "done"}],
    "tools": {"builtin": ["interrupt"], "mcp_servers": [], "functions": []},
    "limits": _LIMITS,
}

# Two-node LLM graph (for cancellation test — cancel arrives between nodes)
_TWO_LLM_GRAPH = {
    "spec_version": "1",
    "entry": "node_a",
    "nodes": {
        "node_a": {
            "type": "llm",
            "model": "anthropic/claude-3.5-sonnet",
            "system_prompt": "Be brief.",
            "input_template": "{{ state.user_input }}",
            "output_key": "reply_a",
        },
        "node_b": {
            "type": "llm",
            "model": "anthropic/claude-3.5-sonnet",
            "system_prompt": "Be brief.",
            "input_template": "{{ state.reply_a }}",
            "output_key": "reply_b",
        },
        "done": {"type": "end", "output_template": "{{ state.reply_b }}"},
    },
    "edges": [
        {"from": "node_a", "to": "node_b"},
        {"from": "node_b", "to": "done"},
    ],
    "tools": {"builtin": [], "mcp_servers": [], "functions": []},
    "limits": _LIMITS,
}


# ---------------------------------------------------------------------------
# Fake OpenRouter implementations
# ---------------------------------------------------------------------------

class FakeOpenRouterSimple:
    """Returns a plain text reply with no tool_calls."""

    async def chat_completion(self, **kwargs):
        return {
            "message": {"role": "assistant", "content": "hello world"},
            "finish_reason": "stop",
            "usage": {"prompt_tokens": 5, "completion_tokens": 3},
        }


class FakeOpenRouterInterrupt:
    """Returns a tool_call to 'interrupt' on first LLM call."""

    async def chat_completion(self, **kwargs):
        return {
            "message": {
                "role": "assistant",
                "tool_calls": [
                    {
                        "id": "call_interrupt_1",
                        "function": {
                            "name": "interrupt",
                            "arguments": json.dumps({
                                "reason": "needs_approval",
                                "data": {"amount": 100},
                            }),
                        },
                    }
                ],
            },
            "finish_reason": "tool_calls",
            "usage": {"prompt_tokens": 5, "completion_tokens": 3},
        }


class FakeOpenRouterSlowFirstNode:
    """Sleeps briefly on the first call so cancel signal arrives in time."""

    def __init__(self, sleep: float = 0.05):
        self._sleep = sleep
        self._call_count = 0

    async def chat_completion(self, **kwargs):
        self._call_count += 1
        if self._call_count == 1:
            await asyncio.sleep(self._sleep)
        return {
            "message": {"role": "assistant", "content": f"reply_{self._call_count}"},
            "finish_reason": "stop",
            "usage": {"prompt_tokens": 3, "completion_tokens": 2},
        }


# ---------------------------------------------------------------------------
# Seed helper: override graph_spec on agent so runner uses the right graph
# ---------------------------------------------------------------------------

async def _set_graph_spec(pg_pool, run_id: str, graph_spec: dict) -> None:
    """Update the agent's graph_spec for the given run."""
    async with pg_pool.acquire() as c:
        agent_id = await c.fetchval(
            "SELECT agent_id FROM agent_runs WHERE id = $1",
            uuid.UUID(run_id),
        )
        await c.execute(
            "UPDATE agents SET graph_spec = $1::jsonb WHERE id = $2",
            json.dumps(graph_spec), agent_id,
        )


async def _set_run_input(pg_pool, run_id: str, input_data: dict) -> None:
    async with pg_pool.acquire() as c:
        await c.execute(
            "UPDATE agent_runs SET input = $1::jsonb WHERE id = $2",
            json.dumps(input_data), uuid.UUID(run_id),
        )


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_runner_completion(pg_pool, seed_run, redis_pool):
    """Runner completes successfully: status=completed, events contain run_start+run_end,
    agent_usage row exists."""
    run_id = seed_run
    await _set_graph_spec(pg_pool, run_id, _SIMPLE_GRAPH)
    await _set_run_input(pg_pool, run_id, {"user_input": "hi"})

    await run_agent(
        pool=pg_pool,
        run_id=run_id,
        openrouter=FakeOpenRouterSimple(),
        redis=redis_pool.client,
    )

    async with pg_pool.acquire() as c:
        run = await c.fetchrow(
            "SELECT status, output, error FROM agent_runs WHERE id = $1",
            uuid.UUID(run_id),
        )
        events = await c.fetch(
            "SELECT type FROM agent_run_events WHERE run_id = $1 ORDER BY seq",
            run_id,
        )
        usage = await c.fetchrow(
            "SELECT prompt_tokens, completion_tokens FROM agent_usage WHERE run_id = $1",
            run_id,
        )

    assert run["status"] == "completed"
    assert run["error"] is None
    output = run["output"]
    if isinstance(output, str):
        output = json.loads(output)
    assert output == {"value": "hello world"}

    event_types = [e["type"] for e in events]
    assert "run_start" in event_types
    assert "run_end" in event_types
    # run_start before run_end
    assert event_types.index("run_start") < event_types.index("run_end")

    assert usage is not None
    assert usage["prompt_tokens"] == 5
    assert usage["completion_tokens"] == 3


@pytest.mark.asyncio
async def test_runner_paused(pg_pool, seed_run, redis_pool):
    """Runner pauses when LLM node calls the interrupt tool:
    status=paused, interrupt_payload set, run_paused event emitted,
    checkpoint exists for the node that was executing."""
    run_id = seed_run
    await _set_graph_spec(pg_pool, run_id, _INTERRUPT_GRAPH)
    await _set_run_input(pg_pool, run_id, {"user_input": "please approve"})

    # run_agent should NOT raise — Interrupted is caught internally
    await run_agent(
        pool=pg_pool,
        run_id=run_id,
        openrouter=FakeOpenRouterInterrupt(),
        redis=redis_pool.client,
    )

    async with pg_pool.acquire() as c:
        run = await c.fetchrow(
            "SELECT status, interrupt_payload, finished_at FROM agent_runs WHERE id = $1",
            uuid.UUID(run_id),
        )
        events = await c.fetch(
            "SELECT type FROM agent_run_events WHERE run_id = $1 ORDER BY seq",
            run_id,
        )
        checkpoint = await c.fetchrow(
            "SELECT step, node_id FROM agent_checkpoints WHERE run_id = $1 ORDER BY step DESC LIMIT 1",
            run_id,
        )

    assert run["status"] == "paused"
    assert run["finished_at"] is None, "paused run should not have finished_at"

    interrupt_payload = run["interrupt_payload"]
    if isinstance(interrupt_payload, str):
        interrupt_payload = json.loads(interrupt_payload)
    assert interrupt_payload is not None
    assert interrupt_payload.get("reason") == "needs_approval"

    event_types = [e["type"] for e in events]
    assert "run_paused" in event_types

    # Checkpoint should exist for the interrupted node.
    # step = steps - 1 = 0 because triage is the first (and only) node interrupted
    # before completion; node_id is preserved for observability.
    assert checkpoint is not None
    assert checkpoint["node_id"] == "triage"
    assert checkpoint["step"] == 0


@pytest.mark.asyncio
async def test_runner_cancelled(pg_pool, seed_run, redis_pool):
    """Runner is cancelled: publish cancel signal mid-run, assert status=cancelled,
    run_cancelled event emitted."""
    run_id = seed_run
    await _set_graph_spec(pg_pool, run_id, _TWO_LLM_GRAPH)
    await _set_run_input(pg_pool, run_id, {"user_input": "start"})

    cancel_channel = f"agent_runs:{run_id}:cancel"

    async def _publish_cancel_after_delay():
        # Wait long enough for CancelToken to subscribe, then publish.
        # The first LLM node sleeps 0.1s, so we publish at 0.05s — after
        # subscription is set up but before the cancel_token check fires.
        await asyncio.sleep(0.05)
        await redis_pool.client.publish(cancel_channel, "cancel")

    # Start run_agent as a task, concurrently publish the cancel signal.
    run_task = asyncio.create_task(
        run_agent(
            pool=pg_pool,
            run_id=run_id,
            openrouter=FakeOpenRouterSlowFirstNode(sleep=0.2),
            redis=redis_pool.client,
        )
    )
    publish_task = asyncio.create_task(_publish_cancel_after_delay())

    # run_agent should NOT re-raise CancelledError — it catches it internally
    await asyncio.gather(run_task, publish_task)

    async with pg_pool.acquire() as c:
        run = await c.fetchrow(
            "SELECT status, finished_at FROM agent_runs WHERE id = $1",
            uuid.UUID(run_id),
        )
        events = await c.fetch(
            "SELECT type FROM agent_run_events WHERE run_id = $1 ORDER BY seq",
            run_id,
        )

    assert run["status"] == "cancelled"
    assert run["finished_at"] is not None

    event_types = [e["type"] for e in events]
    assert "run_cancelled" in event_types
