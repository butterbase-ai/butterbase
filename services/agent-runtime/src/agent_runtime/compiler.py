"""Plan 2 compiler: llm node tool-calling loop + tool node + end node."""

import asyncio
import json
import time
from typing import Any, Awaitable, Callable

from agent_runtime.spec import (
    EndNode, GraphSpec, LlmNode, ToolNode, ToolRef,
)
from agent_runtime.templates import render
from agent_runtime.tools.base import (
    Tool, ToolBudget, ToolBudgetError, ToolDeniedError, ToolError, ToolRegistry,
)


RunnerResult = dict[str, Any]
Runner = Callable[[dict[str, Any]], Awaitable[RunnerResult]]


class Interrupted(Exception):
    """Raised by the interrupt builtin to pause the run with payload."""
    def __init__(self, payload: dict):
        self.payload = payload
        super().__init__("agent run interrupted")


def compile_graph(
    spec: GraphSpec,
    *,
    openrouter,
    registry: ToolRegistry,
    caller_kind: str,
    audit: Callable[..., Awaitable[None]] | None = None,
    emitter=None,       # EventEmitter | None
    checkpointer=None,  # Checkpointer | None
    cancel_token=None,  # CancelToken | None
    resume_step: int = 0,  # if >0, skip nodes already executed
) -> Runner:
    next_edges = {edge.from_: edge.to for edge in spec.edges}
    budget = registry.budget or ToolBudget(
        max_tool_calls=spec.limits.max_tool_calls,
        max_parallel_tools=spec.limits.max_parallel_tools,
    )
    registry.budget = budget

    async def _dispatch(tool: Tool, args: dict[str, Any]) -> Any:
        try:
            await budget.acquire()
        except ToolBudgetError as e:
            if audit is not None:
                await audit(
                    tool_source=tool.source, tool_name=tool.name,
                    server_id=tool.server_id, args=args,
                    duration_ms=0, status="budget", error=str(e),
                )
            raise

        t0 = time.monotonic()
        status = "ok"
        err: str | None = None
        try:
            if emitter is not None:
                await emitter.emit("tool_call_start", {
                    "tool_source": tool.source,
                    "tool_name": tool.name,
                })
            result = await tool.handler(args)
            return result
        except Interrupted:
            raise
        except ToolDeniedError as e:
            status, err = "denied", str(e)
            raise
        except ToolError as e:
            status, err = "error", str(e)
            raise
        except Exception as e:
            status, err = "error", str(e)
            raise
        finally:
            duration_ms = int((time.monotonic() - t0) * 1000)
            budget.release()
            if audit is not None:
                await audit(
                    tool_source=tool.source, tool_name=tool.name,
                    server_id=tool.server_id, args=args,
                    duration_ms=duration_ms,
                    status=status, error=err,
                )
            if emitter is not None:
                await emitter.emit("tool_call_end", {
                    "tool_source": tool.source,
                    "tool_name": tool.name,
                    "status": status,
                    "duration_ms": duration_ms,
                })

    async def _run_llm(node: LlmNode, state: dict[str, Any]) -> None:
        allow = [t.name for t in node.tools]
        visible = registry.visible(caller_kind=caller_kind, allow=allow or None)
        tool_specs = [t.to_openai_tool() for t in visible] if visible else None

        messages: list[dict[str, Any]] = [
            {"role": "system", "content": node.system_prompt},
            {"role": "user", "content": render(node.input_template, state)},
        ]
        usage_acc = {"prompt_tokens": 0, "completion_tokens": 0}
        loop_steps = 0
        while True:
            loop_steps += 1
            if loop_steps > spec.limits.max_steps:
                raise RuntimeError(
                    f"max_steps={spec.limits.max_steps} exceeded inside llm node"
                )
            out = await openrouter.chat_completion(
                model=node.model, messages=messages, tools=tool_specs,
                temperature=node.temperature, max_tokens=node.max_tokens,
            )
            usage = out.get("usage") or {}
            prompt_used = usage.get("prompt_tokens", 0)
            completion_used = usage.get("completion_tokens", 0)
            usage_acc["prompt_tokens"] += prompt_used
            usage_acc["completion_tokens"] += completion_used
            if emitter is not None:
                await emitter.emit("llm_token_usage", {
                    "prompt": prompt_used,
                    "completion": completion_used,
                })
            msg = out["message"]
            messages.append(msg)
            tool_calls = msg.get("tool_calls") or []
            if not tool_calls:
                state[node.output_key] = msg.get("content") or ""
                state.setdefault("_usage", {"prompt_tokens": 0, "completion_tokens": 0})
                state["_usage"]["prompt_tokens"] += usage_acc["prompt_tokens"]
                state["_usage"]["completion_tokens"] += usage_acc["completion_tokens"]
                return

            async def _do(call):
                fn = call["function"]
                try:
                    tool = registry.get(fn["name"])
                    args = json.loads(fn.get("arguments") or "{}")
                    res = await _dispatch(tool, args)
                    return call["id"], json.dumps(res, default=str)
                except Interrupted:
                    raise
                except ToolError as e:
                    return call["id"], json.dumps({"error": str(e)})
                except Exception as e:
                    return call["id"], json.dumps({"error": f"unexpected: {e}"})

            results = await asyncio.gather(
                *(_do(c) for c in tool_calls), return_exceptions=False,
            )
            for call_id, payload in results:
                messages.append({
                    "role": "tool",
                    "tool_call_id": call_id,
                    "content": payload,
                })

    async def _run_tool_node(node: ToolNode, state: dict[str, Any]) -> None:
        tool = registry.get(node.tool_ref.name)
        args = {k: render(v, state) if isinstance(v, str) else v
                for k, v in node.args_template.items()}
        result = await _dispatch(tool, args)
        state[node.output_key] = result

    async def _run_inner(initial_state: dict[str, Any]) -> RunnerResult:
        state: dict[str, Any] = dict(initial_state)
        node_id = spec.entry
        steps = 0
        output: str | None = None

        if resume_step == 0 and emitter is not None:
            await emitter.emit("run_start", {"input": initial_state})

        while True:
            if steps >= spec.limits.max_steps:
                raise RuntimeError(f"max_steps={spec.limits.max_steps} exceeded")
            steps += 1

            # Skip nodes already executed when resuming
            if steps <= resume_step:
                nxt = next_edges.get(node_id)
                if nxt is None:
                    raise RuntimeError(f"no outbound edge from node '{node_id}'")
                node_id = nxt
                continue

            node = spec.nodes[node_id]

            if emitter is not None:
                await emitter.emit("node_start", {"node_id": node_id, "step": steps})

            try:
                if isinstance(node, LlmNode):
                    await _run_llm(node, state)
                elif isinstance(node, ToolNode):
                    await _run_tool_node(node, state)
            except Interrupted:
                # Save checkpoint at steps-1 (last fully completed step) so that
                # on resume the interrupted node is re-executed (step N > resume_step N-1).
                # node_id is kept as the interrupted node for observability.
                if checkpointer is not None:
                    await checkpointer.save(step=steps - 1, node_id=node_id, state=state)
                raise

            if isinstance(node, EndNode):
                output = render(node.output_template, state)
                if emitter is not None:
                    await emitter.emit("node_end", {"node_id": node_id, "step": steps})
                    await emitter.emit("run_end", {"output": output})
                break

            if emitter is not None:
                await emitter.emit("node_end", {"node_id": node_id, "step": steps})

            if checkpointer is not None:
                await checkpointer.save(step=steps, node_id=node_id, state=state)

            if cancel_token is not None and cancel_token.is_cancelled():
                raise asyncio.CancelledError("run cancelled by cancel_token")

            nxt = next_edges.get(node_id)
            if nxt is None:
                raise RuntimeError(f"no outbound edge from node '{node_id}'")
            node_id = nxt

        return {
            "output": output,
            "state": state,
            "usage": state.get("_usage") or {"prompt_tokens": 0, "completion_tokens": 0},
        }

    async def run(initial_state: dict[str, Any]) -> RunnerResult:
        try:
            return await asyncio.wait_for(
                _run_inner(initial_state),
                timeout=spec.limits.timeout_seconds,
            )
        except asyncio.TimeoutError as exc:
            raise RuntimeError(
                f"graph execution exceeded timeout_seconds={spec.limits.timeout_seconds}"
            ) from exc

    return run
