"""Environment-driven config. Fail fast on missing required vars."""

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Config:
    control_plane_url: str = ""
    openrouter_api_key: str | None = None
    openrouter_base_url: str = "https://openrouter.ai/api/v1"
    log_level: str = "info"
    internal_service_token: str = ""
    control_api_url: str = "http://control-api:4000"
    auth_encryption_key: str = ""
    redis_url: str = "redis://redis:6379"

    @classmethod
    def from_env(cls) -> "Config":
        control_plane_url = os.environ.get("CONTROL_PLANE_URL")
        if not control_plane_url:
            raise RuntimeError("CONTROL_PLANE_URL is required")
        cfg = cls(
            control_plane_url=control_plane_url,
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
