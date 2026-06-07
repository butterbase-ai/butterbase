"""Internal routes: start, resume, cancel an agent run.

start  → fire-and-forget (202 immediately).
resume → re-queue a paused run and fire-and-forget.
cancel → set cancel_requested=TRUE and publish Redis signal.
"""

import asyncio
import json
import logging

from fastapi import APIRouter, Request, HTTPException

from agent_runtime.openrouter import OpenRouterClient
from agent_runtime.runner import run_agent

logger = logging.getLogger(__name__)
router = APIRouter()


def _auth_check(request: Request) -> None:
    cfg = request.app.state.config
    expected = getattr(cfg, "internal_service_token", "")
    if expected and request.headers.get("x-internal-service-token") != expected:
        raise HTTPException(status_code=401, detail="unauthorized")


async def _run_in_background(app, run_id: str) -> None:
    """Build client (if not overridden), run agent, close client."""
    cfg = app.state.config
    pool = app.state.pool
    redis = app.state.redis.client
    control_api = getattr(app.state, "control_api", None)
    encryption_key: bytes = getattr(app.state, "encryption_key", b"")
    override = getattr(app.state, "run_agent_fn", None)
    runner_fn = override or run_agent

    client: OpenRouterClient | None = None
    if override is None:
        api_key = cfg.openrouter_api_key
        if not api_key:
            raise RuntimeError("OPENROUTER_API_KEY not set")
        client = OpenRouterClient(api_key=api_key, base_url=cfg.openrouter_base_url)

    try:
        await runner_fn(
            pool=pool,
            run_id=run_id,
            openrouter=client,
            redis=redis,
            control_api=control_api,
            encryption_key=encryption_key,
        )
    except Exception:
        logger.exception("agent run %s failed in background task", run_id)
    finally:
        if client is not None:
            await client.close()


def _schedule_run(app, run_id: str) -> asyncio.Task:
    task = asyncio.create_task(_run_in_background(app, run_id))
    app.state.run_tasks.add(task)
    task.add_done_callback(app.state.run_tasks.discard)
    return task


@router.post("/internal/runs/{run_id}/start", status_code=202)
async def start_run(run_id: str, request: Request):
    _auth_check(request)
    _schedule_run(request.app, run_id)
    return {"run_id": run_id, "status": "queued"}


@router.post("/internal/runs/{run_id}/resume", status_code=202)
async def resume_run(run_id: str, request: Request):
    _auth_check(request)
    body: dict = await request.json()
    resume_input = body.get("input")

    pool = request.app.state.pool
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            UPDATE agent_runs
               SET status = 'queued',
                   resume_input = $2::jsonb,
                   attempt = attempt + 1
             WHERE id = $1 AND status = 'paused'
            RETURNING id
            """,
            run_id,
            json.dumps(resume_input),
        )
    if row is None:
        raise HTTPException(status_code=404, detail="run not paused")

    _schedule_run(request.app, run_id)
    return {"run_id": run_id, "status": "queued"}


@router.post("/internal/runs/{run_id}/cancel", status_code=202)
async def cancel_run(run_id: str, request: Request):
    _auth_check(request)

    pool = request.app.state.pool
    redis = request.app.state.redis.client

    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            UPDATE agent_runs
               SET cancel_requested = TRUE,
                   status = CASE WHEN status = 'running' THEN 'cancelling' ELSE status END
             WHERE id = $1
            RETURNING status
            """,
            run_id,
        )
    if row is None:
        raise HTTPException(status_code=404, detail="run not found")

    await redis.publish(f"agent_runs:{run_id}:cancel", "1")
    return {"run_id": run_id, "status": row["status"]}
