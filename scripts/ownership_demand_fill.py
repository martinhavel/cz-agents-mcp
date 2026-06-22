#!/usr/bin/env python3
"""Demand-driven ownership cache fill runner.

Reads requested ICOs from ownership_cache.fill_requests, builds only those
networks in the VR base, syncs the mini-cache, and marks requests as filled.
"""

from __future__ import annotations

import fcntl
import logging
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Sequence

import sync_ownership_cache


ROOT = Path(__file__).resolve().parents[1]
LOCK_PATH = Path(os.environ.get("OWNERSHIP_DEMAND_FILL_LOCK", "/tmp/ownership_demand_fill.lock"))
DEFAULT_MAX_FILL_PER_RUN = 500


def parse_max_fill_per_run() -> int:
    raw = os.environ.get("MAX_FILL_PER_RUN", str(DEFAULT_MAX_FILL_PER_RUN))
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError("MAX_FILL_PER_RUN must be an integer") from exc
    if value <= 0:
        raise ValueError("MAX_FILL_PER_RUN must be positive")
    return value


def acquire_lock():
    LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
    lock_file = LOCK_PATH.open("w")
    try:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        lock_file.close()
        return None
    return lock_file


def ensure_queue_table(cache_conn) -> None:
    with cache_conn:
        with cache_conn.cursor() as cur:
            sync_ownership_cache.ensure_target_schema(cur)


def fetch_pending_icos(cache_conn, limit: int) -> list[str]:
    with cache_conn.cursor() as cur:
        cur.execute(
            """
            SELECT ico FROM ownership_cache.fill_requests
            WHERE filled_at IS NULL
            ORDER BY request_count DESC, last_requested DESC
            LIMIT %s
            """,
            (limit,),
        )
        return [str(row[0]) for row in cur.fetchall()]


def run_build(icos: Sequence[str], source_dsn: str, python_bin: str) -> subprocess.CompletedProcess:
    env = os.environ.copy()
    env["DB_URL"] = source_dsn
    return subprocess.run(
        [python_bin, "scripts/ownership_network_refresh.py", "--icos", ",".join(icos)],
        cwd=ROOT,
        env=env,
        check=False,
    )


def sync_cache(source_dsn: str, cache_dsn: str) -> sync_ownership_cache.SyncResult:
    source_conn = sync_ownership_cache.connect(source_dsn)
    cache_conn = sync_ownership_cache.connect(cache_dsn)
    try:
        return sync_ownership_cache.sync(
            source_conn,
            cache_conn,
            sync_ownership_cache.parse_max_edges_bytes(),
        )
    finally:
        source_conn.close()
        cache_conn.close()


def mark_filled(cache_conn, icos: Sequence[str]) -> None:
    with cache_conn:
        with cache_conn.cursor() as cur:
            cur.execute(
                """
                UPDATE ownership_cache.fill_requests
                SET filled_at = now()
                WHERE ico = ANY(%s)
                """,
                (list(icos),),
            )


def require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} must be set")
    return value


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    started = time.monotonic()
    lock_file = acquire_lock()
    if lock_file is None:
        logging.info("ownership demand fill already running; exiting")
        return 0

    try:
        source_dsn = require_env("SOURCE_DB_URL")
        cache_dsn = require_env("CACHE_DB_URL")
        max_fill = parse_max_fill_per_run()
        python_bin = os.environ.get("PYTHON_BIN", "python3")

        cache_conn = sync_ownership_cache.connect(cache_dsn)
        try:
            ensure_queue_table(cache_conn)
            icos = fetch_pending_icos(cache_conn, max_fill)
            if not icos:
                logging.info("ownership demand fill: no pending requests elapsed_seconds=%.2f", time.monotonic() - started)
                return 0

            logging.info("ownership demand fill: pending=%s selected=%s", len(icos), len(icos))
            build = run_build(icos, source_dsn, python_bin)
            if build.returncode != 0:
                logging.error("ownership demand fill build failed returncode=%s selected=%s", build.returncode, len(icos))
                return build.returncode or 1

            sync_cache(source_dsn, cache_dsn)
            mark_filled(cache_conn, icos)
        finally:
            cache_conn.close()

        logging.info(
            "ownership demand fill complete pending=%s filled=%s elapsed_seconds=%.2f",
            len(icos),
            len(icos),
            time.monotonic() - started,
        )
        return 0
    except Exception:
        logging.exception("ownership demand fill failed")
        return 1
    finally:
        lock_file.close()


if __name__ == "__main__":
    sys.exit(main())
