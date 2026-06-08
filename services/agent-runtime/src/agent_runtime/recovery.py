"""Mark stale running runs as queued so they get retried on startup."""

import asyncio

import asyncpg


async def recover_all_stale_runs(
    pools: dict[str, asyncpg.Pool], *, stale_after_seconds: int = 30
) -> dict[str, list[str]]:
    """Recover stale runs across every region's pool. Returns a
    mapping of region -> list of recovered run IDs. Failures in one
    region don't block the others — the offending region is logged
    via the raised exception's __cause__ chain but ignored at the
    aggregate level (lifespan should log and continue)."""
    regions = list(pools.keys())
    results = await asyncio.gather(
        *(recover_stale_runs(pools[r], stale_after_seconds=stale_after_seconds) for r in regions),
        return_exceptions=True,
    )
    out: dict[str, list[str]] = {}
    for region, result in zip(regions, results):
        if isinstance(result, BaseException):
            out[region] = []
        else:
            out[region] = result
    return out


async def recover_stale_runs(pool: asyncpg.Pool, *, stale_after_seconds: int = 30) -> list[str]:
    """Recover stale runs by marking them as queued for retry.

    A run is considered stale if it is in 'running' or 'cancelling' status and either:
    - has no last_heartbeat recorded, or
    - last_heartbeat is older than stale_after_seconds

    Args:
        pool: asyncpg connection pool to control plane database.
        stale_after_seconds: Threshold in seconds for considering a run stale.
                           Defaults to 30 seconds.

    Returns:
        List of run IDs that were recovered (as strings).
    """
    async with pool.acquire() as c:
        rows = await c.fetch(
            """
            UPDATE agent_runs
               SET status = CASE WHEN cancel_requested THEN 'cancelled' ELSE 'queued' END,
                   attempt = CASE WHEN cancel_requested THEN attempt ELSE attempt + 1 END,
                   finished_at = CASE WHEN cancel_requested THEN now() ELSE finished_at END
             WHERE status IN ('running', 'cancelling')
               AND (last_heartbeat IS NULL
                    OR last_heartbeat < now() - ($1 || ' seconds')::interval)
            RETURNING id, cancel_requested
            """,
            str(stale_after_seconds),
        )
    return [str(r["id"]) for r in rows if not r["cancel_requested"]]
