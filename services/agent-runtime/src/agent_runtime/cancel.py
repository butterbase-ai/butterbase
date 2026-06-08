"""Cooperative cancel token. Listens on agent_runs:{id}:cancel."""
import asyncio
import logging

logger = logging.getLogger(__name__)


class CancelToken:
    def __init__(self, *, redis, run_id: str):
        self._redis = redis
        self._run_id = run_id
        self._flag = asyncio.Event()
        self._task: asyncio.Task | None = None
        self._pubsub = None

    def is_cancelled(self) -> bool:
        return self._flag.is_set()

    def trigger(self) -> None:
        self._flag.set()

    async def start(self) -> None:
        self._pubsub = self._redis.pubsub()
        await self._pubsub.subscribe(f"agent_runs:{self._run_id}:cancel")

        async def _listen():
            async for msg in self._pubsub.listen():
                if msg.get("type") == "message":
                    self._flag.set()
                    return

        self._task = asyncio.create_task(_listen())

    async def close(self) -> None:
        task, self._task = self._task, None
        pubsub, self._pubsub = self._pubsub, None
        if task is not None:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            except Exception:
                logger.warning(
                    "cancel listener exited with error", exc_info=True,
                )
        if pubsub is not None:
            try:
                await pubsub.unsubscribe()
            finally:
                await pubsub.aclose()
