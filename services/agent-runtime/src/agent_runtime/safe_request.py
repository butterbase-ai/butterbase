"""SSRF / DNS-rebinding egress guard."""

import ipaddress
from typing import Any

import dns.resolver
import httpx


class SafeRequestError(Exception):
    pass


_RESOLVER = dns.resolver.Resolver()
_RESOLVER.lifetime = 5.0


def is_safe_destination(ip: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return not (
        addr.is_private
        or addr.is_loopback
        or addr.is_link_local
        or addr.is_multicast
        or addr.is_unspecified
        or addr.is_reserved
        or str(addr) == "169.254.169.254"
    )


def resolve_safe(host: str) -> str:
    try:
        ipaddress.ip_address(host)
        ip = host
    except ValueError:
        try:
            answers = _RESOLVER.resolve(host, "A")
        except Exception as exc:
            raise SafeRequestError(f"dns failure for {host}: {exc}") from exc
        if not answers:
            raise SafeRequestError(f"no A records for {host}")
        ip = answers[0].address
    if not is_safe_destination(ip):
        raise SafeRequestError(f"refusing to dial {host} ({ip})")
    return ip


async def safe_request(
    method: str,
    url: str,
    *,
    client: httpx.AsyncClient | None = None,
    max_bytes: int = 1024 * 1024,
    connect_timeout: float = 5.0,
    read_timeout: float = 30.0,
    **kwargs: Any,
) -> httpx.Response:
    parsed = httpx.URL(url)
    host = parsed.host
    if not host:
        raise SafeRequestError(f"missing host in {url}")
    ip = resolve_safe(host)

    transport_url = parsed.copy_with(host=ip)
    headers = dict(kwargs.pop("headers", {}) or {})
    headers.setdefault("Host", host)
    extensions = dict(kwargs.pop("extensions", {}) or {})
    extensions.setdefault("sni_hostname", host)

    owns_client = client is None
    cli = client or httpx.AsyncClient(
        timeout=httpx.Timeout(read_timeout, connect=connect_timeout),
    )
    try:
        resp = await cli.request(
            method, str(transport_url),
            headers=headers, extensions=extensions, **kwargs,
        )
        body = await _read_capped(resp, max_bytes)
        return httpx.Response(
            status_code=resp.status_code,
            headers=resp.headers,
            content=body,
            request=resp.request,
        )
    finally:
        if owns_client:
            await cli.aclose()


async def _read_capped(resp: httpx.Response, max_bytes: int) -> bytes:
    chunks: list[bytes] = []
    total = 0
    async for chunk in resp.aiter_bytes():
        total += len(chunk)
        if total > max_bytes:
            raise SafeRequestError(f"response exceeded {max_bytes} bytes")
        chunks.append(chunk)
    return b"".join(chunks)
