"""Tiny safe template evaluator: only `{{ state.path.to.value }}` works."""

import json
import re
from typing import Any

_TOKEN = re.compile(r"\{\{\s*state\.([a-zA-Z_][\w.]*)\s*\}\}")


def render(template: str, state: dict[str, Any]) -> str:
    def replace(match: re.Match[str]) -> str:
        path = match.group(1).split(".")
        value: Any = state
        for part in path:
            if not isinstance(value, dict) or part not in value:
                raise KeyError(f"missing template key: state.{match.group(1)}")
            value = value[part]
        if isinstance(value, str):
            return value
        if isinstance(value, (dict, list)):
            return json.dumps(value, ensure_ascii=False)
        return str(value)

    return _TOKEN.sub(replace, template)
