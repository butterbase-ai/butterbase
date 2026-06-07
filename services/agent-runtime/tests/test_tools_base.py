import pytest
from agent_runtime.tools.base import (
    Tool, ToolRegistry, ToolBudget, ToolDeniedError,
)


async def _h(args): return args


def _t(name, mode="read_only", exposed_to="end_user"):
    return Tool(
        name=name, description="", args_schema={"type": "object"},
        handler=_h, source="builtin", mode=mode, exposed_to=exposed_to,
    )


def test_visible_filters_end_user():
    reg = ToolRegistry()
    reg.add(_t("public", exposed_to="end_user"))
    reg.add(_t("private", exposed_to="developer_only"))
    assert {t.name for t in reg.visible(caller_kind="end_user")} == {"public"}
    assert {t.name for t in reg.visible(caller_kind="function")} == {"public", "private"}


def test_visible_respects_allow_list():
    reg = ToolRegistry()
    reg.add(_t("a"))
    reg.add(_t("b"))
    assert {t.name for t in reg.visible(caller_kind="function", allow=["a"])} == {"a"}


@pytest.mark.asyncio
async def test_budget_total_calls_fail_fast():
    from agent_runtime.tools.base import ToolBudgetError
    b = ToolBudget(max_tool_calls=2, max_parallel_tools=4)
    await b.acquire(); b.release()
    await b.acquire(); b.release()
    with pytest.raises(ToolBudgetError):
        await b.acquire()


@pytest.mark.asyncio
async def test_budget_parallel_queues():
    import asyncio
    b = ToolBudget(max_tool_calls=10, max_parallel_tools=1)
    await b.acquire()
    waiter = asyncio.create_task(b.acquire())
    await asyncio.sleep(0.05)
    assert not waiter.done()
    b.release()
    await asyncio.wait_for(waiter, timeout=1.0)
    b.release()
