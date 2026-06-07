"""Webhook delivery: enqueue helper + background worker with retry."""

import asyncio
import json
import logging
from typing import Any

import asyncpg
import httpx

logger = logging.getLogger(__name__)

MAX_ATTEMPTS = 5


async def enqueue_webhook(
    pool: asyncpg.Pool,
    run_id: str,
    url: str,
    payload: dict[str, Any],
) -> None:
    """Insert a pending delivery row. Called from runner.py terminal branches."""
    async with pool.acquire() as c:
        await c.execute(
            "INSERT INTO agent_webhook_deliveries (run_id, url, payload) VALUES ($1::uuid, $2, $3::jsonb)",
            run_id,
            url,
            json.dumps(payload),
        )


class WebhookWorker:
    def __init__(
        self,
        *,
        pool: asyncpg.Pool,
        http_client: httpx.AsyncClient,
        poll_interval: float = 2.0,
    ):
        self._pool = pool
        self._http = http_client
        self._poll = poll_interval
        self._stop = asyncio.Event()
        self._task: asyncio.Task | None = None

    async def start(self) -> None:
        self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        self._stop.set()
        if self._task is not None:
            try:
                await self._task
            except Exception:
                logger.exception("webhook worker stop error")
            self._task = None

    async def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                await self._tick()
            except Exception:
                logger.exception("webhook tick error")
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=self._poll)
            except asyncio.TimeoutError:
                continue
            return

    async def _tick(self) -> None:
        """Claim up to 20 due rows and dispatch sequentially."""
        async with self._pool.acquire() as c:
            rows = await c.fetch(
                """
                SELECT id, url, payload, attempts FROM agent_webhook_deliveries
                WHERE status='pending' AND next_attempt <= now()
                ORDER BY next_attempt LIMIT 20
                """,
            )
        for r in rows:
            payload = r["payload"]
            if isinstance(payload, str):
                payload = json.loads(payload)
            try:
                resp = await self._http.post(r["url"], json=payload, timeout=10.0)
                if 200 <= resp.status_code < 300:
                    await self._mark_sent(r["id"])
                else:
                    await self._mark_retry(
                        r["id"], r["attempts"], f"HTTP {resp.status_code}"
                    )
            except Exception as exc:
                await self._mark_retry(r["id"], r["attempts"], str(exc)[:500])

    async def _mark_sent(self, delivery_id: int) -> None:
        async with self._pool.acquire() as c:
            await c.execute(
                "UPDATE agent_webhook_deliveries SET status='sent', delivered_at=now() WHERE id=$1",
                delivery_id,
            )

    async def _mark_retry(self, delivery_id: int, attempts: int, err: str) -> None:
        new_attempts = attempts + 1
        terminal = new_attempts >= MAX_ATTEMPTS
        new_status = "failed" if terminal else "pending"
        # Exponential backoff: 2^n seconds, capped at 300s
        backoff = min(2**new_attempts, 300)
        async with self._pool.acquire() as c:
            await c.execute(
                """
                UPDATE agent_webhook_deliveries
                SET attempts=$2, last_error=$3, status=$4,
                    next_attempt = now() + ($5 || ' seconds')::interval
                WHERE id=$1
                """,
                delivery_id,
                new_attempts,
                err,
                new_status,
                str(backoff),
            )
