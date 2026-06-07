"""ACL resolution. Most-restrictive wins; spec can never widen past defaults."""

from dataclasses import dataclass
from typing import Any
from agent_runtime.tools.base import ToolMode, ToolExposedTo


_MODE_RANK = {"read_only": 0, "read_write": 1}
_EXPOSED_RANK = {"developer_only": 0, "end_user": 1}


@dataclass
class AclInputs:
    source: str
    default_mode: ToolMode
    default_exposed_to: ToolExposedTo
    server_override: dict[str, Any] | None = None
    spec_override: dict[str, Any] | None = None


def _narrowest_mode(*candidates: ToolMode) -> ToolMode:
    return min(candidates, key=lambda m: _MODE_RANK[m])


def _narrowest_exposed(*candidates: ToolExposedTo) -> ToolExposedTo:
    return min(candidates, key=lambda e: _EXPOSED_RANK[e])


def resolve_acl(inp: AclInputs) -> tuple[ToolMode, ToolExposedTo]:
    mode: ToolMode = inp.default_mode
    exposed: ToolExposedTo = inp.default_exposed_to

    if inp.server_override:
        if "mode" in inp.server_override:
            mode = _narrowest_mode(mode, inp.server_override["mode"])
        if "exposed_to" in inp.server_override:
            exposed = _narrowest_exposed(exposed, inp.server_override["exposed_to"])

    if inp.spec_override:
        if "mode_override" in inp.spec_override:
            mode = _narrowest_mode(mode, inp.spec_override["mode_override"])
        if "exposed_to_override" in inp.spec_override:
            exposed = _narrowest_exposed(exposed, inp.spec_override["exposed_to_override"])

    return mode, exposed
