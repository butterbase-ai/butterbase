"""Test EventEmitter persists to DB and publishes to Redis."""
import asyncio
import json
import uuid

import pytest

from agent_runtime.events import EventEmitter


@pytest.mark.asyncio
async def test_emit_writes_db_and_publishes(pg_pool, redis_pool, seed_run):
    run_id = seed_run
    sub = redis_pool.client.pubsub()
    await sub.subscribe(f"agent_runs:{run_id}")
    # consume the subscribe-ack
    await sub.get_message(timeout=1)

    emitter = EventEmitter(pool=pg_pool, redis=redis_pool.client, run_id=run_id)
    seq1 = await emitter.emit("node_start", {"node_id": "triage"})
    seq2 = await emitter.emit("node_end", {"node_id": "triage"})

    assert seq1 == 1 and seq2 == 2

    msg1 = await asyncio.wait_for(
        sub.get_message(ignore_subscribe_messages=True), timeout=2,
    )
    assert msg1 is not None, "First message not received"
    payload1 = json.loads(msg1["data"])
    assert payload1["seq"] == 1
    assert payload1["type"] == "node_start"
    assert payload1["payload"] == {"node_id": "triage"}
    assert payload1["run_id"] == run_id

    msg2 = await asyncio.wait_for(
        sub.get_message(ignore_subscribe_messages=True), timeout=2,
    )
    assert msg2 is not None, "Second message not received"
    payload2 = json.loads(msg2["data"])
    assert payload2["seq"] == 2

    async with pg_pool.acquire() as c:
        rows = await c.fetch(
            "SELECT seq, type, payload FROM agent_run_events "
            "WHERE run_id = $1 ORDER BY seq",
            uuid.UUID(run_id),
        )
    assert [(r["seq"], r["type"]) for r in rows] == [
        (1, "node_start"), (2, "node_end"),
    ]

    await sub.unsubscribe()
    await sub.aclose()
