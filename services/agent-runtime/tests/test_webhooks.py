"""Tests for webhook delivery worker (Task 11)."""

import uuid
from datetime import timezone

import httpx
import pytest

from agent_runtime.webhooks import MAX_ATTEMPTS, WebhookWorker, enqueue_webhook


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _fetch_delivery(pg_pool, delivery_id: int) -> dict:
    async with pg_pool.acquire() as c:
        row = await c.fetchrow(
            "SELECT id, status, attempts, last_error, next_attempt, delivered_at, payload "
            "FROM agent_webhook_deliveries WHERE id = $1",
            delivery_id,
        )
    assert row is not None, f"delivery {delivery_id} not found"
    return dict(row)


async def _seed_delivery(pg_pool, run_id: str, *, attempts: int = 0, url: str = "http://example.com/hook") -> int:
    """Insert a due pending row directly and return its id."""
    async with pg_pool.acquire() as c:
        delivery_id = await c.fetchval(
            """
            INSERT INTO agent_webhook_deliveries (run_id, url, payload, attempts, next_attempt)
            VALUES ($1::uuid, $2, $3::jsonb, $4, now() - interval '1 second')
            RETURNING id
            """,
            run_id,
            url,
            '{"run_id": "test", "status": "completed"}',
            attempts,
        )
    return delivery_id


# ---------------------------------------------------------------------------
# Case 1: enqueue + 2xx → status='sent', delivered_at set
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_enqueue_and_2xx_marks_sent(pg_pool, seed_run):
    run_id = seed_run
    url = "http://example.com/hook"
    payload = {"run_id": run_id, "status": "completed", "output": "hello"}

    await enqueue_webhook(pg_pool, run_id, url, payload)

    # Verify row was inserted
    async with pg_pool.acquire() as c:
        row = await c.fetchrow(
            "SELECT id, status, url FROM agent_webhook_deliveries WHERE run_id=$1::uuid",
            run_id,
        )
    assert row is not None
    assert row["status"] == "pending"
    assert row["url"] == url
    delivery_id = row["id"]

    # Mock HTTP returning 200
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    worker = WebhookWorker(pool=pg_pool, http_client=client, poll_interval=999.0)

    await worker._tick()

    d = await _fetch_delivery(pg_pool, delivery_id)
    assert d["status"] == "sent"
    assert d["delivered_at"] is not None


# ---------------------------------------------------------------------------
# Case 2: 5xx → retry with attempts++ and next_attempt in future
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_5xx_increments_attempts_and_schedules_retry(pg_pool, seed_run):
    run_id = seed_run
    delivery_id = await _seed_delivery(pg_pool, run_id)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    worker = WebhookWorker(pool=pg_pool, http_client=client, poll_interval=999.0)

    await worker._tick()

    d = await _fetch_delivery(pg_pool, delivery_id)
    assert d["attempts"] == 1
    assert d["status"] == "pending"
    assert d["last_error"] == "HTTP 503"

    from datetime import datetime

    now = datetime.now(timezone.utc)
    next_attempt = d["next_attempt"]
    if next_attempt.tzinfo is None:
        next_attempt = next_attempt.replace(tzinfo=timezone.utc)
    assert next_attempt > now, "next_attempt should be in the future"


# ---------------------------------------------------------------------------
# Case 3: max attempts reached → status='failed'
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_max_attempts_marks_failed(pg_pool, seed_run):
    run_id = seed_run
    # Pre-seed with attempts = MAX_ATTEMPTS - 1 = 4
    delivery_id = await _seed_delivery(pg_pool, run_id, attempts=MAX_ATTEMPTS - 1)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    worker = WebhookWorker(pool=pg_pool, http_client=client, poll_interval=999.0)

    await worker._tick()

    d = await _fetch_delivery(pg_pool, delivery_id)
    assert d["attempts"] == MAX_ATTEMPTS
    assert d["status"] == "failed"


# ---------------------------------------------------------------------------
# Case 4: network exception → treated like a failure, retry scheduled
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_network_exception_schedules_retry(pg_pool, seed_run):
    run_id = seed_run
    delivery_id = await _seed_delivery(pg_pool, run_id)

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    worker = WebhookWorker(pool=pg_pool, http_client=client, poll_interval=999.0)

    await worker._tick()

    d = await _fetch_delivery(pg_pool, delivery_id)
    assert d["attempts"] == 1
    assert d["status"] == "pending"
    assert d["last_error"] is not None


# ---------------------------------------------------------------------------
# Case 5: worker start / stop lifecycle
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_worker_start_stop():
    """WebhookWorker.start() creates a background task; stop() cancels it cleanly."""

    def handler(request: httpx.Request) -> httpx.Response:  # pragma: no cover
        return httpx.Response(200)

    # We don't need a real pool for this — we just test the task lifecycle.
    # Use a minimal fake pool that never gets called.
    class _FakePool:
        def acquire(self):
            raise AssertionError("pool should not be acquired in this test")

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    worker = WebhookWorker(
        pool=_FakePool(),  # type: ignore[arg-type]
        http_client=client,
        poll_interval=9999.0,  # very long poll so _tick never fires
    )

    await worker.start()
    assert worker._task is not None
    assert not worker._task.done()

    await worker.stop()
    assert worker._task is None
