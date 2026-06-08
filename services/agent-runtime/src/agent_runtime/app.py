"""FastAPI entrypoint for agent-runtime."""

import asyncio
import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI
import httpx

from agent_runtime.config import Config
from agent_runtime.control_api_client import ControlApiClient
from agent_runtime.db import create_pools
from agent_runtime.redis_client import RedisPool
from agent_runtime.recovery import recover_all_stale_runs
from agent_runtime.routes import health, runs
from agent_runtime.webhooks import WebhookWorker

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    cfg = Config.from_env()
    pools = await create_pools(cfg.pool_urls)
    redis_pool = RedisPool(cfg.redis_url)
    await redis_pool.start()
    app.state.config = cfg
    app.state.pools = pools
    app.state.redis = redis_pool
    app.state.control_api = ControlApiClient(
        base_url=cfg.control_api_url,
        token=cfg.internal_service_token,
    )
    # Decode the 64-hex-char AUTH_ENCRYPTION_KEY into 32 raw bytes.
    # Falls back to empty bytes when not configured (no MCP auth_header usage).
    app.state.encryption_key = (
        bytes.fromhex(cfg.auth_encryption_key)
        if cfg.auth_encryption_key
        else b""
    )
    app.state.run_tasks = set()
    http_client = httpx.AsyncClient()
    # One webhook worker per region — agent_webhook_deliveries lives in the
    # runtime plane, so each region drains its own queue.
    workers: dict[str, WebhookWorker] = {}
    for region, pool in pools.items():
        w = WebhookWorker(pool=pool, http_client=http_client)
        await w.start()
        workers[region] = w
    app.state.webhook_workers = workers
    app.state.webhook_http = http_client

    # Recover stale runs in every region on startup.
    recovered_by_region = await recover_all_stale_runs(pools)
    for region, recovered_ids in recovered_by_region.items():
        if recovered_ids:
            logger.info(
                "Recovered %d stale runs in region %s", len(recovered_ids), region
            )
            for run_id in recovered_ids:
                runs._schedule_run(app, run_id, region)

    try:
        yield
    finally:
        if app.state.run_tasks:
            await asyncio.gather(*app.state.run_tasks, return_exceptions=True)
        for w in workers.values():
            await w.stop()
        await http_client.aclose()
        await redis_pool.close()
        await app.state.control_api.close()
        for pool in pools.values():
            await pool.close()


app = FastAPI(title="agent-runtime", version="0.1.0", lifespan=lifespan)
app.include_router(health.router)
app.include_router(runs.router)
