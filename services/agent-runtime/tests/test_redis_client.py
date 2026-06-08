"""Test the RedisPool round-trip against a live Redis."""
import os
import pytest

from agent_runtime.redis_client import RedisPool

REDIS_URL = os.environ.get("TEST_REDIS_URL", "redis://localhost:6379")


@pytest.mark.asyncio
async def test_pool_round_trip():
    pool = RedisPool(REDIS_URL)
    await pool.start()
    try:
        await pool.client.set("ar:test", "hello")
        assert (await pool.client.get("ar:test")) == "hello"
    finally:
        await pool.client.delete("ar:test")
        await pool.close()
