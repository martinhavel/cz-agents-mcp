#!/usr/bin/env python3
"""Sync precomputed VR ownership tables into the local ownership cache.

Source and target DSNs must come from SOURCE_DB_URL and CACHE_DB_URL.
"""

from __future__ import annotations

import logging
import os
import sys
import threading
import time
from dataclasses import dataclass
from typing import Sequence


CACHE_SCHEMA = "ownership_cache"
SUMMARY_TABLE = "company_network_summary"
EDGES_TABLE = "ownership_edges"
DEFAULT_CACHE_EDGES_MAX_BYTES = 8 * 1024 * 1024 * 1024

SUMMARY_COLUMNS = (
    "ico",
    "network_size",
    "shared_role_link_count",
    "as_of",
    "coverage_pct",
)
EDGES_COLUMNS = (
    "canonical_key_person",
    "canonical_key_company",
    "ico",
    "role_type",
    "valid_from",
    "valid_to",
    "depth",
    "namesake_risk",
    "confidence",
    "as_of",
    "coverage_pct",
)

DDL_SQL = f"""
CREATE SCHEMA IF NOT EXISTS {CACHE_SCHEMA};

CREATE TABLE IF NOT EXISTS {CACHE_SCHEMA}.{SUMMARY_TABLE} (
  ico text PRIMARY KEY,
  network_size int NOT NULL,
  shared_role_link_count int NOT NULL,
  as_of timestamptz NOT NULL,
  coverage_pct numeric(5,2) NOT NULL
);

CREATE TABLE IF NOT EXISTS {CACHE_SCHEMA}.{EDGES_TABLE} (
  canonical_key_person text NOT NULL,
  canonical_key_company text NOT NULL,
  ico text NOT NULL,
  role_type text,
  valid_from date,
  valid_to date,
  depth int NOT NULL CHECK (depth IN (1, 2)),
  namesake_risk boolean NOT NULL DEFAULT false,
  confidence text NOT NULL DEFAULT 'HIGH' CHECK (confidence IN ('HIGH', 'LOW')),
  as_of timestamptz NOT NULL,
  coverage_pct numeric(5,2) NOT NULL
);

-- Persistent demand-fill queue. Sync replaces cached summary/edge data only;
-- fill_requests must survive full cache refreshes.
CREATE TABLE IF NOT EXISTS {CACHE_SCHEMA}.fill_requests (
  ico text PRIMARY KEY,
  first_requested timestamptz DEFAULT now(),
  last_requested timestamptz DEFAULT now(),
  request_count int DEFAULT 1,
  filled_at timestamptz NULL,
  as_of timestamptz NULL
);

CREATE INDEX IF NOT EXISTS ownership_cache_summary_ico_idx
  ON {CACHE_SCHEMA}.{SUMMARY_TABLE} (ico);

CREATE INDEX IF NOT EXISTS ownership_cache_edges_ico_idx
  ON {CACHE_SCHEMA}.{EDGES_TABLE} (ico);

CREATE INDEX IF NOT EXISTS ownership_cache_edges_depth_ico_idx
  ON {CACHE_SCHEMA}.{EDGES_TABLE} (depth, ico);
"""


@dataclass(frozen=True)
class TableStats:
    rows: int
    bytes: int
    as_of: str | None


@dataclass(frozen=True)
class SyncResult:
    summary: TableStats
    edges: TableStats
    copied_edges: bool
    elapsed_seconds: float


def connect(dsn: str):
    import psycopg2

    return psycopg2.connect(dsn)


def parse_max_edges_bytes() -> int:
    raw = os.environ.get("CACHE_EDGES_MAX_BYTES")
    if raw is None or raw == "":
        return DEFAULT_CACHE_EDGES_MAX_BYTES
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError("CACHE_EDGES_MAX_BYTES must be an integer byte count") from exc
    if value < 0:
        raise ValueError("CACHE_EDGES_MAX_BYTES must be non-negative")
    return value


def table_stats(cur, table_name: str) -> TableStats:
    cur.execute(
        f"""
        SELECT
          count(*)::bigint,
          pg_total_relation_size(%s::regclass)::bigint,
          max(as_of)
        FROM vr.{table_name}
        """,
        (f"vr.{table_name}",),
    )
    row = cur.fetchone()
    return TableStats(rows=int(row[0] or 0), bytes=int(row[1] or 0), as_of=format_as_of(row[2]))


def target_row_count(cur, table_name: str) -> int:
    cur.execute(f"SELECT count(*)::bigint FROM {CACHE_SCHEMA}.{table_name}")
    row = cur.fetchone()
    return int(row[0] or 0)


def format_as_of(value) -> str | None:
    if value is None:
        return None
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


def quoted_columns(columns: Sequence[str]) -> str:
    return ", ".join(columns)


def copy_sql(direction: str, schema: str, table_name: str, columns: Sequence[str]) -> str:
    columns_sql = quoted_columns(columns)
    if direction == "TO":
        return f"COPY {schema}.{table_name} ({columns_sql}) TO STDOUT WITH (FORMAT csv)"
    if direction == "FROM":
        return f"COPY {schema}.{table_name} ({columns_sql}) FROM STDIN WITH (FORMAT csv)"
    raise ValueError(f"unsupported COPY direction: {direction}")


def stream_copy(source_cur, target_cur, table_name: str, columns: Sequence[str]) -> None:
    source_sql = copy_sql("TO", "vr", table_name, columns)
    target_sql = copy_sql("FROM", CACHE_SCHEMA, table_name, columns)
    read_fd, write_fd = os.pipe()
    errors: list[BaseException] = []

    def copy_from_source() -> None:
        try:
            with os.fdopen(write_fd, "w", closefd=True) as writer:
                source_cur.copy_expert(source_sql, writer)
        except BaseException as exc:
            errors.append(exc)

    worker = threading.Thread(target=copy_from_source, daemon=True)
    worker.start()
    try:
        with os.fdopen(read_fd, "r", closefd=True) as reader:
            target_cur.copy_expert(target_sql, reader)
    finally:
        worker.join()
    if errors:
        raise errors[0]


def ensure_target_schema(cur) -> None:
    cur.execute(DDL_SQL)


def sync(source_conn, target_conn, max_edges_bytes: int) -> SyncResult:
    started = time.monotonic()
    with source_conn.cursor() as source_cur:
        summary_stats = table_stats(source_cur, SUMMARY_TABLE)
        edges_stats = table_stats(source_cur, EDGES_TABLE)
        copied_edges = edges_stats.bytes <= max_edges_bytes

        if not copied_edges:
            logging.warning(
                "ownership_edges size %s exceeds CACHE_EDGES_MAX_BYTES=%s; syncing summary only",
                edges_stats.bytes,
                max_edges_bytes,
            )

        with target_conn:
            with target_conn.cursor() as target_cur:
                ensure_target_schema(target_cur)
                target_cur.execute(
                    f"TRUNCATE {CACHE_SCHEMA}.{EDGES_TABLE}, {CACHE_SCHEMA}.{SUMMARY_TABLE}"
                )
                stream_copy(source_cur, target_cur, SUMMARY_TABLE, SUMMARY_COLUMNS)
                if copied_edges:
                    stream_copy(source_cur, target_cur, EDGES_TABLE, EDGES_COLUMNS)

                summary_rows = target_row_count(target_cur, SUMMARY_TABLE)
                edges_rows = target_row_count(target_cur, EDGES_TABLE)
                if summary_rows != summary_stats.rows:
                    raise RuntimeError(f"summary row count mismatch: source={summary_stats.rows} target={summary_rows}")
                if copied_edges and edges_rows != edges_stats.rows:
                    raise RuntimeError(f"edges row count mismatch: source={edges_stats.rows} target={edges_rows}")
                if not copied_edges and edges_rows != 0:
                    raise RuntimeError(f"expected empty cached edges after summary-only sync, found {edges_rows}")

    return SyncResult(
        summary=summary_stats,
        edges=edges_stats,
        copied_edges=copied_edges,
        elapsed_seconds=time.monotonic() - started,
    )


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    source_dsn = os.environ.get("SOURCE_DB_URL")
    cache_dsn = os.environ.get("CACHE_DB_URL")
    if not source_dsn:
        logging.error("SOURCE_DB_URL must be set")
        return 2
    if not cache_dsn:
        logging.error("CACHE_DB_URL must be set")
        return 2

    try:
        max_edges_bytes = parse_max_edges_bytes()
        source_conn = connect(source_dsn)
        target_conn = connect(cache_dsn)
        try:
            result = sync(source_conn, target_conn, max_edges_bytes)
        finally:
            source_conn.close()
            target_conn.close()
    except Exception:
        logging.exception("ownership cache sync failed")
        return 1

    logging.info(
        "ownership cache sync complete summary_rows=%s summary_bytes=%s edges_rows=%s "
        "edges_bytes=%s copied_edges=%s as_of=%s elapsed_seconds=%.2f",
        result.summary.rows,
        result.summary.bytes,
        result.edges.rows,
        result.edges.bytes,
        result.copied_edges,
        result.summary.as_of,
        result.elapsed_seconds,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
