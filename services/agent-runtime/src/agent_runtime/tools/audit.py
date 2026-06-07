"""Tool-call audit writer."""

import hashlib
import json
from typing import Any

import asyncpg


def args_hash(args: dict[str, Any]) -> str:
    blob = json.dumps(args, sort_keys=True, ensure_ascii=False).encode()
    return hashlib.sha256(blob).hexdigest()


async def write_audit(
    pool: asyncpg.Pool,
    *,
    run_id: str,
    app_id: str,
    tool_source: str,
    tool_name: str,
    server_id: str | None,
    args: dict[str, Any],
    duration_ms: int,
    status: str,
    error: str | None,
) -> None:
    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO agent_tool_audits
              (run_id, app_id, tool_source, tool_name, server_id,
               args_hash, duration_ms, status, error_message)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            """,
            run_id, app_id, tool_source, tool_name, server_id,
            args_hash(args), duration_ms, status, error,
        )
