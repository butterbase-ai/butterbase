"""Functions-as-tools.

Each app_function with agent_tool=true is exposed. Handler invokes the
function via control-api's /internal/agent-tools/function-invoke.
"""

from typing import Any
from agent_runtime.control_api_client import ControlApiClient
from agent_runtime.tools.base import Tool, ToolError
from agent_runtime.tools.acl import resolve_acl, AclInputs


async def load_function_tools(
    *,
    client: ControlApiClient,
    pool,
    app_id: str,
    run_id: str,
    caller_kind: str,
    caller_user_id: str | None,
    allow_names: list[str],
    spec_overrides: dict[str, dict[str, Any]],
) -> list[Tool]:
    if not allow_names:
        return []
    rows = await pool.fetch(
        """
        SELECT name, agent_tool_description, agent_tool_mode, agent_tool_exposed_to
        FROM app_functions
        WHERE app_id = $1 AND deleted_at IS NULL
          AND agent_tool = true
          AND name = ANY($2::text[])
        """,
        app_id, allow_names,
    )
    out: list[Tool] = []
    for row in rows:
        mode, exposed = resolve_acl(AclInputs(
            source="function",
            default_mode=row["agent_tool_mode"] or "read_only",
            default_exposed_to=row["agent_tool_exposed_to"] or "developer_only",
            spec_override=spec_overrides.get(row["name"]),
        ))
        out.append(_make_function_tool(
            name=row["name"],
            description=row["agent_tool_description"] or f"Customer function {row['name']}",
            client=client, app_id=app_id, run_id=run_id,
            caller_kind=caller_kind, caller_user_id=caller_user_id,
            mode=mode, exposed_to=exposed,
        ))
    return out


def _make_function_tool(*, name, description, client, app_id, run_id,
                        caller_kind, caller_user_id, mode, exposed_to) -> Tool:
    async def handler(args: dict[str, Any]) -> Any:
        resp = await client.invoke_function(
            function_name=name, app_id=app_id, run_id=run_id,
            caller_kind=caller_kind, caller_user_id=caller_user_id, args=args,
        )
        if not resp.get("ok"):
            raise ToolError(resp.get("error") or "function failed")
        return resp.get("result")

    return Tool(
        name=name, description=description,
        args_schema={"type": "object", "properties": {}, "additionalProperties": True},
        handler=handler, source="function", mode=mode, exposed_to=exposed_to,
    )
