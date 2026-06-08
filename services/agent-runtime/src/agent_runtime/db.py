"""asyncpg pools wired to per-region runtime-plane Postgres."""

import asyncio

import asyncpg


async def create_pool(dsn: str) -> asyncpg.Pool:
    return await asyncpg.create_pool(
        dsn=dsn,
        min_size=1,
        max_size=5,
        command_timeout=30,
    )


async def create_pools(urls: dict[str, str]) -> dict[str, asyncpg.Pool]:
    """Open one asyncpg pool per region. Opens concurrently; if any
    region fails, already-opened pools are closed before re-raising."""
    if not urls:
        raise RuntimeError("create_pools called with empty urls")
    regions = list(urls.keys())
    results = await asyncio.gather(
        *(create_pool(urls[r]) for r in regions),
        return_exceptions=True,
    )
    pools: dict[str, asyncpg.Pool] = {}
    errors: list[tuple[str, BaseException]] = []
    for region, result in zip(regions, results):
        if isinstance(result, BaseException):
            errors.append((region, result))
        else:
            pools[region] = result
    if errors:
        # Roll back successfully-opened pools so the process doesn't
        # leak connections when one region's DSN is bad.
        await asyncio.gather(
            *(p.close() for p in pools.values()),
            return_exceptions=True,
        )
        first_region, first_err = errors[0]
        raise RuntimeError(
            f"failed to open runtime DB pool for region '{first_region}': {first_err}"
        ) from first_err
    return pools
