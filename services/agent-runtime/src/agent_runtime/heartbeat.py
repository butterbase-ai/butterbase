"""Background task that keeps agent_runs.last_heartbeat fresh."""
import asyncio

import asyncpg


class Heartbeat:
    def __init__(
        self, *, pool: asyncpg.Pool, run_id: str, interval_seconds: float = 5.0,
    ):
        self._pool = pool
        self._run_id = run_id
        self._interval = interval_seconds
        self._task: asyncio.Task | None = None
        self._stop = asyncio.Event()

    async def start(self) -> None:
        await self._tick()
        self._task = asyncio.create_task(self._loop())

    async def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=self._interval)
                return
            except asyncio.TimeoutError:
                await self._tick()

    async def _tick(self) -> None:
        async with self._pool.acquire() as c:
            await c.execute(
                "UPDATE agent_runs SET last_heartbeat = now() WHERE id = $1::uuid",
                self._run_id,
            )

    async def stop(self) -> None:
        self._stop.set()
        if self._task is not None:
            try:
                await self._task
            except Exception:
                pass
            self._task = None
