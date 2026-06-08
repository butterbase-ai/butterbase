"""Built-in tool factories. Handlers delegate to control-api callback."""

from typing import Any
from agent_runtime.control_api_client import ControlApiClient
from agent_runtime.tools.base import Tool, ToolError
from agent_runtime.tools.acl import resolve_acl, AclInputs


_DEFAULTS: dict[str, tuple[str, str]] = {
    "query_table":      ("read_only",  "end_user"),
    "insert_row":       ("read_write", "developer_only"),
    "update_row":       ("read_write", "developer_only"),
    "delete_row":       ("read_write", "developer_only"),
    "read_storage":     ("read_only",  "end_user"),
    "write_storage":    ("read_write", "developer_only"),
    "auth_user_lookup": ("read_only",  "developer_only"),
    "interrupt":        ("read_only",  "developer_only"),
}


_SCHEMAS: dict[str, dict[str, Any]] = {
    "query_table": {
        "type": "object",
        "properties": {
            "table":  {"type": "string"},
            "filter": {"type": "object"},
            "limit":  {"type": "integer", "minimum": 1, "maximum": 200},
        },
        "required": ["table"],
    },
    "insert_row": {
        "type": "object",
        "properties": {
            "table":  {"type": "string"},
            "values": {"type": "object"},
        },
        "required": ["table", "values"],
    },
    "update_row": {
        "type": "object",
        "properties": {
            "table": {"type": "string"},
            "id":    {},
            "patch": {"type": "object"},
        },
        "required": ["table", "id", "patch"],
    },
    "delete_row": {
        "type": "object",
        "properties": {
            "table": {"type": "string"},
            "id":    {},
        },
        "required": ["table", "id"],
    },
    "read_storage": {
        "type": "object",
        "properties": {"key": {"type": "string"}},
        "required": ["key"],
    },
    "write_storage": {
        "type": "object",
        "properties": {
            "key":            {"type": "string"},
            "content_base64": {"type": "string"},
            "content_type":   {"type": "string"},
        },
        "required": ["key", "content_base64"],
    },
    "auth_user_lookup": {
        "type": "object",
        "properties": {
            "id":    {"type": "string"},
            "email": {"type": "string"},
        },
    },
    "interrupt": {
        "type": "object",
        "properties": {
            "reason": {"type": "string"},
            "data": {"type": "object"},
        },
        "required": ["reason"],
    },
}

_DESCRIPTIONS: dict[str, str] = {
    "query_table": "Read rows from a table in this app's database. Honors RLS.",
    "insert_row":  "Insert one row into a table. Server-side only.",
    "update_row":  "Update rows matching a filter. Server-side only.",
    "delete_row":  "Delete rows matching a filter. Server-side only.",
    "read_storage":  "Read an object from app storage by key.",
    "write_storage": "Write an object to app storage at key.",
    "auth_user_lookup": "Look up a user by id or email.",
    "interrupt": "Pause the agent run for human review. Provide reason and any payload the human needs to decide. The run resumes via /resume with their input.",
}


def make_builtin_tool(
    name: str,
    *,
    client: ControlApiClient,
    app_id: str,
    run_id: str,
    caller_kind: str,
    caller_user_id: str | None,
    spec_override: dict[str, Any] | None = None,
) -> Tool:
    if name not in _DEFAULTS:
        raise ToolError(f"unknown builtin tool: {name}")
    mode_default, exposed_default = _DEFAULTS[name]
    mode, exposed = resolve_acl(AclInputs(
        source="builtin",
        default_mode=mode_default,
        default_exposed_to=exposed_default,
        spec_override=spec_override,
    ))

    if name == "interrupt":
        async def handler(args: dict[str, Any]) -> Any:
            from agent_runtime.compiler import Interrupted
            raise Interrupted({"reason": args.get("reason"),
                               "data": args.get("data") or {}})
    else:
        async def handler(args: dict[str, Any]) -> Any:
            resp = await client.call_builtin(
                tool_name=name, app_id=app_id, run_id=run_id,
                caller_kind=caller_kind, caller_user_id=caller_user_id, args=args,
            )
            if not resp.get("ok"):
                raise ToolError(resp.get("error") or "tool failed")
            return resp.get("result")

    return Tool(
        name=name,
        description=_DESCRIPTIONS[name],
        args_schema=_SCHEMAS.get(name, {"type": "object"}),
        handler=handler,
        source="builtin",
        mode=mode,
        exposed_to=exposed,
    )
