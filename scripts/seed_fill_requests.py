#!/usr/bin/env python3
"""Seed ownership_cache.fill_requests from stdin or a file.

DEPRECATED: mini-cache fill requests are retired in favor of on-demand VR base ownership queries.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path
from typing import Sequence

import sync_ownership_cache


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Seed ownership fill requests from comma/newline separated ICOs.")
    parser.add_argument("file", nargs="?", help="Optional file path. Reads stdin when omitted.")
    return parser.parse_args(argv)


def parse_icos(raw: str) -> list[str]:
    return list(dict.fromkeys(part.strip() for part in re.split(r"[,\s]+", raw) if part.strip()))


def read_input(path: str | None) -> str:
    if path:
        return Path(path).read_text()
    return sys.stdin.read()


def seed_requests(cache_dsn: str, icos: Sequence[str]) -> int:
    if not icos:
        return 0
    conn = sync_ownership_cache.connect(cache_dsn)
    try:
        with conn:
            with conn.cursor() as cur:
                sync_ownership_cache.ensure_target_schema(cur)
                cur.executemany(
                    """
                    INSERT INTO ownership_cache.fill_requests (ico)
                    VALUES (%s)
                    ON CONFLICT (ico) DO NOTHING
                    """,
                    [(ico,) for ico in icos],
                )
                return cur.rowcount if cur.rowcount and cur.rowcount > 0 else 0
    finally:
        conn.close()


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    cache_dsn = os.environ.get("CACHE_DB_URL")
    if not cache_dsn:
        print("CACHE_DB_URL must be set", file=sys.stderr)
        return 2
    icos = parse_icos(read_input(args.file))
    inserted = seed_requests(cache_dsn, icos)
    print(f"seeded fill_requests inserted={inserted} requested={len(icos)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
