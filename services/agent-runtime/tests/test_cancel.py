"""Test the cooperative CancelToken."""
import asyncio
import uuid

import pytest

from agent_runtime.cancel import CancelToken


@pytest.mark.asyncio
async def test_token_fires_on_redis_message(redis_pool):
    run_id = str(uuid.uuid4())
    token = CancelToken(redis=redis_pool.client, run_id=run_id)
    await token.start()
    try:
        assert not token.is_cancelled()
        # give the listen task a moment to be ready
        await asyncio.sleep(0.05)
        await redis_pool.client.publish(f"agent_runs:{run_id}:cancel", "1")
        for _ in range(40):
            if token.is_cancelled():
                break
            await asyncio.sleep(0.05)
        assert token.is_cancelled()
    finally:
        await token.close()


@pytest.mark.asyncio
async def test_token_trigger_sets_flag(redis_pool):
    run_id = str(uuid.uuid4())
    token = CancelToken(redis=redis_pool.client, run_id=run_id)
    await token.start()
    try:
        token.trigger()
        assert token.is_cancelled()
    finally:
        await token.close()


@pytest.mark.asyncio
async def test_close_is_idempotent(redis_pool):
    run_id = str(uuid.uuid4())
    token = CancelToken(redis=redis_pool.client, run_id=run_id)
    await token.start()
    await token.close()
    # second close should not raise (test the design supports it)
    await token.close()
    assert token.is_cancelled() is False
