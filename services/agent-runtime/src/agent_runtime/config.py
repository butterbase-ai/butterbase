"""Environment-driven config. Fail fast on missing required vars."""

import os
from dataclasses import dataclass, field


def _region_env_suffix(region: str) -> str:
    return region.replace("-", "_").upper()


def _load_pool_urls() -> dict[str, str]:
    regions = [
        r.strip()
        for r in os.environ.get("BUTTERBASE_REGIONS", "").split(",")
        if r.strip()
    ]
    if regions:
        urls: dict[str, str] = {}
        missing: list[str] = []
        for r in regions:
            key = f"RUNTIME_DB_URL_{_region_env_suffix(r)}"
            url = os.environ.get(key)
            if not url:
                missing.append(key)
                continue
            urls[r] = url
        if missing:
            raise RuntimeError(
                f"BUTTERBASE_REGIONS set but missing runtime DB URLs: {', '.join(missing)}"
            )
        return urls

    # Legacy single-region fallback: BUTTERBASE_REGION + CONTROL_PLANE_URL
    # (or RUNTIME_DB_URL). Keeps single-region deploys booting without
    # touching their env.
    url = os.environ.get("RUNTIME_DB_URL") or os.environ.get("CONTROL_PLANE_URL")
    if not url:
        raise RuntimeError(
            "BUTTERBASE_REGIONS + RUNTIME_DB_URL_<REGION> "
            "or CONTROL_PLANE_URL is required"
        )
    region = os.environ.get("BUTTERBASE_REGION", "local")
    return {region: url}


@dataclass(frozen=True)
class Config:
    pool_urls: dict[str, str] = field(default_factory=dict)
    openrouter_api_key: str | None = None
    openrouter_base_url: str = "https://openrouter.ai/api/v1"
    log_level: str = "info"
    internal_service_token: str = ""
    control_api_url: str = "http://control-api:4000"
    auth_encryption_key: str = ""
    redis_url: str = "redis://redis:6379"

    @property
    def regions(self) -> list[str]:
        return list(self.pool_urls.keys())

    @classmethod
    def from_env(cls) -> "Config":
        pool_urls = _load_pool_urls()
        cfg = cls(
            pool_urls=pool_urls,
            openrouter_api_key=os.environ.get("OPENROUTER_API_KEY"),
            openrouter_base_url=os.environ.get(
                "OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"
            ),
            log_level=os.environ.get("LOG_LEVEL", "info"),
            internal_service_token=os.environ.get("INTERNAL_SERVICE_TOKEN", ""),
            control_api_url=os.environ.get(
                "CONTROL_API_URL", "http://control-api:4000"
            ),
            auth_encryption_key=os.environ.get("AUTH_ENCRYPTION_KEY", ""),
            redis_url=os.environ.get("REDIS_URL", "redis://redis:6379"),
        )
        if os.environ.get("ENV") == "production":
            missing: list[str] = []
            if not cfg.internal_service_token:
                missing.append("INTERNAL_SERVICE_TOKEN")
            if not cfg.auth_encryption_key:
                missing.append("AUTH_ENCRYPTION_KEY")
            if missing:
                raise RuntimeError(
                    f"required env vars missing in production: {', '.join(missing)}"
                )
        return cfg
