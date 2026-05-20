# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "httpx>=0.27",
#     "psycopg[binary]>=3.2",
# ]
# ///
"""
Hackathon submission stress test.

Simulates N concurrent participants submitting to POST /hackathons/submissions.
Sidesteps Cognito by directly seeding platform_users + api_keys rows in the
control DB; each simulated participant uses its own bb_sk_ API key (one
distinct request.auth.userId per request — same code path as a real Cognito
user from the route's perspective).

Three phases:
  1. seed       - INSERT N platform_users + N api_keys, save run manifest.
  2. cold       - concurrent POST with submission_code (argon2 verify + INSERT
                  participant + INSERT submission). Worst case for the API.
  3. warm       - concurrent POST without code (pure upsert into
                  hackathon_submissions). Repeat-submission path.
  4. cleanup    - DELETE submissions, participants, api_keys, users for run.

Crash safety: the run manifest (user_ids + run_id) is written to
cleanup-<run_id>.json BEFORE any HTTP traffic. To recover from a crash, run
with --cleanup-only --run-id <id>.

Usage:
    export BUTTERBASE_DSN='postgresql://...butterbase-control-api-db?sslmode=require'
    uv run scripts/stress_submit.py \\
        --base-url https://api.butterbase.ai \\
        --num-users 1000 --concurrency 200 \\
        --submission-code BETA-HACKATHON

    # Cleanup-only (e.g. after a crash):
    uv run scripts/stress_submit.py --cleanup-only --run-id <id>
"""

import argparse
import asyncio
import hashlib
import json
import os
import secrets
import sys
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import httpx
import psycopg


# ---------------------------------------------------------------------------
# Config / Manifest
# ---------------------------------------------------------------------------

@dataclass
class Config:
    dsn: str
    base_url: str
    submission_code: str
    hackathon_slug: Optional[str]
    num_users: int
    concurrency: int
    phases: list[str]
    run_id: str
    timeout_seconds: int
    keep_data: bool


@dataclass
class Manifest:
    run_id: str
    user_ids: list[str] = field(default_factory=list)
    api_keys: list[str] = field(default_factory=list)  # parallel array

    def path(self) -> Path:
        return Path(f"cleanup-{self.run_id}.json")

    def save(self):
        self.path().write_text(json.dumps({
            "run_id": self.run_id,
            "user_ids": self.user_ids,
            "api_keys": self.api_keys,
        }, indent=2))

    @classmethod
    def load(cls, run_id: str) -> "Manifest":
        path = Path(f"cleanup-{run_id}.json")
        d = json.loads(path.read_text())
        return cls(run_id=d["run_id"], user_ids=d["user_ids"], api_keys=d["api_keys"])


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------

class Metrics:
    def __init__(self):
        self.latencies: dict[str, list[float]] = {}
        self.statuses: dict[str, dict[int, int]] = {}

    def record(self, label: str, latency: float, status: int):
        self.latencies.setdefault(label, []).append(latency)
        bucket = self.statuses.setdefault(label, {})
        bucket[status] = bucket.get(status, 0) + 1

    def report(self):
        print("\n" + "=" * 100)
        print(f"{'Phase':<30} {'N':>6} {'OK%':>6} {'p50':>7} {'p95':>7} {'p99':>7} {'max':>7} {'rps':>7}")
        print("-" * 100)
        for label, lats in sorted(self.latencies.items()):
            lats_sorted = sorted(lats)
            n = len(lats_sorted)
            statuses = self.statuses.get(label, {})
            ok = sum(c for s, c in statuses.items() if 200 <= s < 300)
            ok_pct = ok / n * 100 if n else 0
            wall = max(lats) if lats else 0  # rough; not real wall-time
            rps_est = n / sum(lats) * (n / 1) if sum(lats) else 0  # ops per sec of total work
            print(
                f"{label:<30} {n:>6} {ok_pct:>5.1f}% "
                f"{lats_sorted[int(n*.50)]*1000:>5.0f}ms "
                f"{lats_sorted[int(n*.95)]*1000:>5.0f}ms "
                f"{lats_sorted[min(int(n*.99), n-1)]*1000:>5.0f}ms "
                f"{lats_sorted[-1]*1000:>5.0f}ms "
                f"{rps_est:>6.0f}"
            )
            for s, c in sorted(statuses.items()):
                if not (200 <= s < 300):
                    print(f"  {'':<28} HTTP {s}: {c}")
        print("=" * 100)


# ---------------------------------------------------------------------------
# Seed: platform_users + api_keys
# ---------------------------------------------------------------------------

API_KEY_PREFIX = "bb_sk_"


def gen_api_key() -> tuple[str, str, str]:
    """Returns (full_key, sha256_hex_hash, key_prefix_first_12_chars)."""
    random_hex = secrets.token_hex(20)  # matches api-key-service.ts: 20 random bytes
    full = f"{API_KEY_PREFIX}{random_hex}"
    key_hash = hashlib.sha256(full.encode()).hexdigest()
    return full, key_hash, full[:12]


def seed_db(cfg: Config, manifest: Manifest):
    """INSERT N platform_users + api_keys. Save manifest BEFORE returning."""
    print(f"[seed] Inserting {cfg.num_users} platform_users + api_keys (run_id={cfg.run_id})...")
    t0 = time.monotonic()

    user_rows = []
    key_rows = []
    plain_keys = []
    for i in range(cfg.num_users):
        user_id = str(uuid.uuid4())
        cognito_sub = f"stress-{cfg.run_id}-{i:04d}"
        email = f"stress-{cfg.run_id}-{i:04d}@butterbase-stress.invalid"
        user_rows.append((user_id, cognito_sub, email))

        full_key, key_hash, key_prefix = gen_api_key()
        plain_keys.append(full_key)
        key_rows.append((user_id, key_hash, key_prefix, f"stress-{cfg.run_id}"))

    with psycopg.connect(cfg.dsn) as conn:
        with conn.cursor() as cur:
            # platform_users: cognito_sub UNIQUE, password_hash nullable since 003.
            cur.executemany(
                """INSERT INTO platform_users (id, cognito_sub, email, email_verified)
                   VALUES (%s, %s, %s, true)""",
                user_rows,
            )
            cur.executemany(
                """INSERT INTO api_keys (user_id, key_hash, key_prefix, name, scopes)
                   VALUES (%s, %s, %s, %s, '{*}')""",
                key_rows,
            )
        conn.commit()

    manifest.user_ids = [r[0] for r in user_rows]
    manifest.api_keys = plain_keys
    manifest.save()

    elapsed = time.monotonic() - t0
    print(f"[seed] Done in {elapsed:.1f}s. Manifest: {manifest.path()}")


# ---------------------------------------------------------------------------
# Field-schema-aware data synthesis
# ---------------------------------------------------------------------------

def fetch_active_hackathon(cfg: Config) -> dict:
    with psycopg.connect(cfg.dsn) as conn, conn.cursor() as cur:
        if cfg.hackathon_slug:
            cur.execute(
                """SELECT slug, name, starts_at, ends_at, submission_deadline, field_schema
                   FROM hackathons WHERE slug = %s""",
                (cfg.hackathon_slug,),
            )
        else:
            cur.execute(
                """SELECT slug, name, starts_at, ends_at, submission_deadline, field_schema
                   FROM hackathons WHERE is_active LIMIT 1"""
            )
        row = cur.fetchone()
        if not row:
            raise RuntimeError("No hackathon found")
        cols = [d.name for d in cur.description]
        return dict(zip(cols, row))


def synthesize_data(field_schema: dict, idx: int) -> dict:
    """Build a valid `data` payload for the route's validator."""
    out: dict = {}
    for f in field_schema.get("fields", []):
        if not f.get("required"):
            continue
        t = f["type"]
        k = f["key"]
        if t == "text":
            out[k] = f"Stress project {idx}"
        elif t == "markdown":
            out[k] = f"# Stress test {idx}\n\nGenerated submission."
        elif t == "url":
            out[k] = f"https://stress-test.invalid/{idx}"
        elif t == "image_url":
            out[k] = f"https://stress-test.invalid/{idx}.png"
        elif t == "email":
            out[k] = f"stress-{idx}@butterbase-stress.invalid"
        elif t == "number":
            out[k] = idx
        elif t == "text[]":
            out[k] = [f"member-{idx}-a", f"member-{idx}-b"]
        elif t == "enum":
            opts = f.get("options") or [""]
            out[k] = opts[0]
    return out


# ---------------------------------------------------------------------------
# Storm phases
# ---------------------------------------------------------------------------

async def submit_one(
    client: httpx.AsyncClient,
    cfg: Config,
    metrics: Metrics,
    label: str,
    api_key: str,
    payload: dict,
):
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    t0 = time.monotonic()
    try:
        resp = await client.post(
            f"{cfg.base_url}/hackathons/submissions",
            headers=headers,
            json=payload,
            timeout=cfg.timeout_seconds,
        )
        elapsed = time.monotonic() - t0
        metrics.record(label, elapsed, resp.status_code)
        if resp.status_code >= 400 and resp.status_code != 409:
            # Surface a sample of error bodies (rate-limit ourselves to keep logs sane)
            if metrics.statuses[label].get(resp.status_code, 0) <= 3:
                try:
                    body = resp.json()
                except Exception:
                    body = resp.text[:200]
                print(f"  [{label}] HTTP {resp.status_code}: {body}")
    except httpx.TimeoutException:
        metrics.record(label, time.monotonic() - t0, 408)
    except Exception as e:
        metrics.record(label, time.monotonic() - t0, 0)
        if metrics.statuses[label].get(0, 0) <= 3:
            print(f"  [{label}] {type(e).__name__}: {e}")


async def run_storm(
    cfg: Config,
    manifest: Manifest,
    metrics: Metrics,
    label: str,
    field_schema: dict,
    include_code: bool,
):
    print(f"\n[{label}] {cfg.num_users} concurrent submissions, semaphore={cfg.concurrency}...")
    sem = asyncio.Semaphore(cfg.concurrency)
    limits = httpx.Limits(
        max_connections=cfg.concurrency * 2,
        max_keepalive_connections=cfg.concurrency,
    )

    async with httpx.AsyncClient(limits=limits, http2=False) as client:
        async def task(i: int):
            async with sem:
                payload: dict = {"data": synthesize_data(field_schema, i)}
                if cfg.hackathon_slug:
                    payload["hackathon_slug"] = cfg.hackathon_slug
                if include_code:
                    payload["submission_code"] = cfg.submission_code
                await submit_one(client, cfg, metrics, label, manifest.api_keys[i], payload)

        wall = time.monotonic()
        await asyncio.gather(*(task(i) for i in range(len(manifest.api_keys))))
        wall = time.monotonic() - wall
        n = len(manifest.api_keys)
        print(f"[{label}] Wall: {wall:.1f}s, throughput: {n/wall:.0f} req/s")


# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------

def cleanup_by_run_id(cfg: Config, run_id: str):
    """Fallback cleanup when manifest is missing: match by cognito_sub prefix."""
    pattern = f"stress-{run_id}-%"
    print(f"[cleanup] Manifest missing — querying DB for cognito_sub LIKE {pattern!r}...")
    with psycopg.connect(cfg.dsn) as conn, conn.cursor() as cur:
        cur.execute("SELECT id FROM platform_users WHERE cognito_sub LIKE %s", (pattern,))
        ids = [r[0] for r in cur.fetchall()]
    if not ids:
        print(f"[cleanup] No platform_users matching run_id={run_id}. Nothing to do.")
        return
    print(f"[cleanup] Found {len(ids)} user(s) to remove.")
    m = Manifest(run_id=run_id, user_ids=ids, api_keys=[])
    cleanup(cfg, m)


def cleanup(cfg: Config, manifest: Manifest):
    if not manifest.user_ids:
        print("[cleanup] No user_ids in manifest, nothing to do.")
        return
    print(f"\n[cleanup] Deleting data for run_id={manifest.run_id} ({len(manifest.user_ids)} users)...")
    t0 = time.monotonic()
    with psycopg.connect(cfg.dsn) as conn, conn.cursor() as cur:
        # Order matters even though FKs CASCADE — be explicit for visibility.
        cur.execute(
            "DELETE FROM hackathon_submissions WHERE user_id = ANY(%s)",
            (manifest.user_ids,),
        )
        subs = cur.rowcount
        cur.execute(
            "DELETE FROM hackathon_participants WHERE user_id = ANY(%s)",
            (manifest.user_ids,),
        )
        parts = cur.rowcount
        cur.execute(
            "DELETE FROM api_keys WHERE user_id = ANY(%s)",
            (manifest.user_ids,),
        )
        keys = cur.rowcount
        cur.execute(
            "DELETE FROM platform_users WHERE id = ANY(%s)",
            (manifest.user_ids,),
        )
        users = cur.rowcount
        conn.commit()
    print(f"[cleanup] submissions={subs}, participants={parts}, api_keys={keys}, "
          f"platform_users={users} (took {time.monotonic()-t0:.1f}s)")
    try:
        manifest.path().unlink()
        print(f"[cleanup] Removed {manifest.path()}")
    except FileNotFoundError:
        pass


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

async def main_async(cfg: Config):
    manifest = Manifest(run_id=cfg.run_id)
    metrics = Metrics()

    h = fetch_active_hackathon(cfg)
    print(f"Target hackathon: slug={h['slug']}, deadline={h['submission_deadline']}")
    deadline_ts = h["submission_deadline"].timestamp()
    if time.time() > deadline_ts:
        print("ERROR: submission_deadline is in the past — submissions will 403.")
        sys.exit(1)

    try:
        if "seed" in cfg.phases:
            seed_db(cfg, manifest)
        else:
            print("[seed] Skipped — expecting --run-id with existing manifest.")

        if "cold" in cfg.phases:
            await run_storm(cfg, manifest, metrics, "cold (with code)",
                            h["field_schema"], include_code=True)

        if "warm" in cfg.phases:
            await run_storm(cfg, manifest, metrics, "warm (no code)",
                            h["field_schema"], include_code=False)

    finally:
        metrics.report()
        if not cfg.keep_data and manifest.user_ids:
            cleanup(cfg, manifest)
        elif cfg.keep_data:
            print(f"\nKEEP-DATA: skipped cleanup. To remove later:")
            print(f"  uv run scripts/stress_submit.py --cleanup-only --run-id {cfg.run_id}")


def parse_args() -> Config:
    p = argparse.ArgumentParser()
    p.add_argument("--dsn", default=os.environ.get("BUTTERBASE_DSN"),
                   help="Postgres DSN for control DB (env: BUTTERBASE_DSN)")
    p.add_argument("--base-url", default="https://api.butterbase.ai")
    p.add_argument("--submission-code", default=os.environ.get("SUBMISSION_CODE", ""))
    p.add_argument("--hackathon-slug", default=None,
                   help="Omit to use the active hackathon")
    p.add_argument("--num-users", type=int, default=1000)
    p.add_argument("--concurrency", type=int, default=200,
                   help="Max in-flight HTTP requests (full burst is unrealistic — "
                        "WAF/Cloudflare will throttle. 200 is a reasonable peak.)")
    p.add_argument("--phases", default="seed,cold,warm",
                   help="Comma-separated: seed,cold,warm")
    p.add_argument("--run-id", default=None,
                   help="Reuse an existing run_id (skip seeding, resume cleanup)")
    p.add_argument("--cleanup-only", action="store_true",
                   help="Skip storm; just delete data for --run-id")
    p.add_argument("--keep-data", action="store_true",
                   help="Don't delete after run; useful for inspecting results")
    p.add_argument("--timeout", type=int, default=60)
    args = p.parse_args()

    if not args.dsn:
        print("ERROR: --dsn or BUTTERBASE_DSN required.")
        sys.exit(1)

    if args.cleanup_only:
        if not args.run_id:
            print("ERROR: --cleanup-only requires --run-id")
            sys.exit(1)
        return Config(
            dsn=args.dsn, base_url=args.base_url,
            submission_code="", hackathon_slug=args.hackathon_slug,
            num_users=0, concurrency=1, phases=[],
            run_id=args.run_id, timeout_seconds=args.timeout, keep_data=False,
        )

    if not args.submission_code:
        print("ERROR: --submission-code or SUBMISSION_CODE required.")
        sys.exit(1)

    run_id = args.run_id or secrets.token_hex(4)
    return Config(
        dsn=args.dsn,
        base_url=args.base_url.rstrip("/"),
        submission_code=args.submission_code,
        hackathon_slug=args.hackathon_slug,
        num_users=args.num_users,
        concurrency=args.concurrency,
        phases=[s.strip() for s in args.phases.split(",") if s.strip()],
        run_id=run_id,
        timeout_seconds=args.timeout,
        keep_data=args.keep_data,
    )


def main():
    cfg = parse_args()

    if not cfg.phases and cfg.run_id:
        # cleanup-only path
        try:
            manifest = Manifest.load(cfg.run_id)
        except FileNotFoundError:
            cleanup_by_run_id(cfg, cfg.run_id)
            return
        cleanup(cfg, manifest)
        return

    print("=" * 60)
    print("  Hackathon Submit Stress Test")
    print("=" * 60)
    print(f"  run_id:       {cfg.run_id}")
    print(f"  base_url:     {cfg.base_url}")
    print(f"  num_users:    {cfg.num_users}")
    print(f"  concurrency:  {cfg.concurrency}")
    print(f"  phases:       {','.join(cfg.phases)}")
    print(f"  keep_data:    {cfg.keep_data}")
    print("=" * 60)
    asyncio.run(main_async(cfg))


if __name__ == "__main__":
    main()
