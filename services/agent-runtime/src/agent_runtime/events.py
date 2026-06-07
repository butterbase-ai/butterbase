"""Event emitter: persists to agent_run_events and publishes to Redis."""
import json
import logging
from typing import Any

import asyncpg

logger = logging.getLogger(__name__)


class EventEmitter:
    def __init__(self, *, pool: asyncpg.Pool, redis, run_id: str):
        self._pool = pool
        self._redis = redis
        self._run_id = run_id
        self._channel = f"agent_runs:{run_id}"

    async def emit(self, type_: str, payload: dict[str, Any]) -> int:
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                INSERT INTO agent_run_events (run_id, seq, type, payload)
                VALUES (
                  $1,
                  COALESCE(
                    (SELECT MAX(seq) + 1 FROM agent_run_events WHERE run_id=$1),
                    1
                  ),
                  $2, $3::jsonb
                )
                RETURNING seq, created_at
                """,
                self._run_id, type_, json.dumps(payload),
            )
        seq = row["seq"]
        msg = json.dumps({
            "run_id": self._run_id,
            "seq": seq,
            "type": type_,
            "payload": payload,
            "created_at": row["created_at"].isoformat(),
        })
        try:
            await self._redis.publish(self._channel, msg)
        except Exception:
            # DB row is committed; subscribers replay from DB on reconnect.
            logger.warning(
                "redis publish failed for run %s seq %s", self._run_id, seq,
            )
        return seq
