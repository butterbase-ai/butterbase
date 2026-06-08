"""Shared async Redis client."""
import redis.asyncio as redis_async


class RedisPool:
    def __init__(self, url: str):
        self._url = url
        self.client: redis_async.Redis | None = None

    async def start(self) -> None:
        self.client = redis_async.from_url(
            self._url, encoding="utf-8", decode_responses=True,
            health_check_interval=15,
        )
        try:
            await self.client.ping()
        except Exception:
            await self.client.aclose()
            self.client = None
            raise

    async def close(self) -> None:
        if self.client is not None:
            await self.client.aclose()
            self.client = None
