"""Postgres-backed step checkpointer for agent runs."""
import json
from typing import Any

import asyncpg


class Checkpointer:
    def __init__(self, *, pool: asyncpg.Pool, run_id: str):
        self._pool = pool
        self._run_id = run_id

    async def save(self, *, step: int, node_id: str, state: dict[str, Any]) -> None:
        async with self._pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO agent_checkpoints (run_id, step, node_id, state)
                VALUES ($1::uuid, $2, $3, $4::jsonb)
                ON CONFLICT (run_id, step)
                DO UPDATE SET node_id = EXCLUDED.node_id, state = EXCLUDED.state
                """,
                self._run_id, step, node_id, json.dumps(state),
            )

    async def load_latest(self) -> tuple[int, str, dict[str, Any]] | None:
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                SELECT step, node_id, state
                FROM agent_checkpoints
                WHERE run_id = $1::uuid
                ORDER BY step DESC
                LIMIT 1
                """,
                self._run_id,
            )
        if row is None:
            return None
        state = row["state"]
        if isinstance(state, str):
            state = json.loads(state)
        return row["step"], row["node_id"], state
