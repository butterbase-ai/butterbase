"""Mark stale running runs as queued so they get retried on startup."""

import asyncpg


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
