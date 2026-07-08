#!/usr/bin/env python3
"""Build deduped VR company/person-entity adjacency tables."""

from __future__ import annotations

import argparse
import os
import sys
import time
from collections import Counter, defaultdict
from dataclasses import dataclass
from typing import Iterable


PROGRESS_NAME = "vr_entity_adjacency_company_ico"


COMPANY_EDGE_SQL = """
WITH batch_companies AS (
  SELECT c.company_ico
  FROM (
    SELECT DISTINCT r.company_ico
    FROM vr.roles r
    WHERE r.company_ico > %s
    ORDER BY r.company_ico
    LIMIT %s
  ) c
),
edge_rows AS (
  SELECT
    r.company_ico,
    p.canonical_key,
    array_agg(DISTINCT r.role ORDER BY r.role) FILTER (WHERE r.role IS NOT NULL) AS role_types,
    min(r.valid_from) AS valid_from,
    max(r.valid_to) AS valid_to
  FROM vr.roles r
  JOIN vr.persons p ON p.id = r.person_id
  JOIN batch_companies b ON b.company_ico = r.company_ico
  WHERE p.canonical_key IS NOT NULL
  GROUP BY r.company_ico, p.canonical_key
)
INSERT INTO vr.company_entity_edge (
  company_ico,
  canonical_key,
  role_types,
  valid_from,
  valid_to
)
SELECT
  company_ico,
  canonical_key,
  COALESCE(role_types, ARRAY[]::text[]),
  valid_from,
  valid_to
FROM edge_rows
ON CONFLICT (company_ico, canonical_key) DO UPDATE
SET role_types = EXCLUDED.role_types,
    valid_from = EXCLUDED.valid_from,
    valid_to = EXCLUDED.valid_to
"""


ENTITY_DEGREE_SQL = """
WITH batch_entities AS (
  SELECT DISTINCT p.canonical_key
  FROM vr.roles r
  JOIN vr.persons p ON p.id = r.person_id
  WHERE r.company_ico > %s
    AND r.company_ico <= %s
    AND p.canonical_key IS NOT NULL
),
degree_rows AS (
  SELECT
    p.canonical_key,
    count(DISTINCT r.company_ico)::int AS company_count,
    count(DISTINCT p.id)::int AS record_count
  FROM vr.persons p
  JOIN vr.roles r ON r.person_id = p.id
  JOIN batch_entities b ON b.canonical_key = p.canonical_key
  GROUP BY p.canonical_key
)
INSERT INTO vr.entity_degree (canonical_key, company_count, record_count)
SELECT canonical_key, company_count, record_count
FROM degree_rows
ON CONFLICT (canonical_key) DO UPDATE
SET company_count = EXCLUDED.company_count,
    record_count = EXCLUDED.record_count
"""


PERSON_ENTITY_SQL = """
WITH batch_entities AS (
  SELECT DISTINCT p.canonical_key
  FROM vr.roles r
  JOIN vr.persons p ON p.id = r.person_id
  WHERE r.company_ico > %s
    AND r.company_ico <= %s
    AND p.canonical_key IS NOT NULL
),
name_counts AS (
  SELECT
    p.canonical_key,
    p.full_name,
    p.birth_date,
    count(*) AS name_count,
    length(COALESCE(p.full_name, '')) AS name_len
  FROM vr.persons p
  JOIN batch_entities b ON b.canonical_key = p.canonical_key
  GROUP BY p.canonical_key, p.full_name, p.birth_date
),
ranked AS (
  SELECT
    canonical_key,
    full_name,
    birth_date,
    row_number() OVER (
      PARTITION BY canonical_key
      ORDER BY name_count DESC, name_len DESC, full_name NULLS LAST, birth_date NULLS LAST
    ) AS rn
  FROM name_counts
)
INSERT INTO vr.person_entity (canonical_key, repr_full_name, birth_date)
SELECT canonical_key, full_name, birth_date
FROM ranked
WHERE rn = 1
ON CONFLICT (canonical_key) DO UPDATE
SET repr_full_name = EXCLUDED.repr_full_name,
    birth_date = EXCLUDED.birth_date
"""


NEXT_KEY_SQL = """
SELECT max(company_ico)
FROM (
  SELECT DISTINCT r.company_ico
  FROM vr.roles r
  WHERE r.company_ico > %s
  ORDER BY r.company_ico
  LIMIT %s
) batch
"""


COUNT_BATCH_SQL = """
SELECT count(*)
FROM (
  SELECT DISTINCT r.company_ico
  FROM vr.roles r
  WHERE r.company_ico > %s
  ORDER BY r.company_ico
  LIMIT %s
) batch
"""


ENSURE_SQL = """
CREATE SCHEMA IF NOT EXISTS vr;

CREATE TABLE IF NOT EXISTS vr.company_entity_edge (
  company_ico text NOT NULL,
  canonical_key text NOT NULL,
  role_types text[] NOT NULL,
  valid_from date,
  valid_to date,
  PRIMARY KEY (company_ico, canonical_key)
);

CREATE TABLE IF NOT EXISTS vr.entity_degree (
  canonical_key text PRIMARY KEY,
  company_count int NOT NULL,
  record_count int NOT NULL
);

CREATE TABLE IF NOT EXISTS vr.person_entity (
  canonical_key text PRIMARY KEY,
  repr_full_name text,
  birth_date date
);

CREATE TABLE IF NOT EXISTS vr.build_progress (
  build_name text PRIMARY KEY,
  last_key text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS company_entity_edge_canonical_key_idx
  ON vr.company_entity_edge (canonical_key);
"""


@dataclass(frozen=True)
class Config:
    db_url: str
    work_mem: str
    statement_timeout: str
    batch_size: int
    batch_sleep_ms: int


def dedupe_edge_rows(rows: Iterable[dict]) -> list[dict]:
    """Small in-memory equivalent of the SQL edge aggregation for unit tests."""
    grouped: dict[tuple[str, str], dict] = {}
    for row in rows:
        key = (row["company_ico"], row["canonical_key"])
        edge = grouped.setdefault(
            key,
            {
                "company_ico": row["company_ico"],
                "canonical_key": row["canonical_key"],
                "role_types": set(),
                "valid_from": row.get("valid_from"),
                "valid_to": row.get("valid_to"),
            },
        )
        if row.get("role"):
            edge["role_types"].add(row["role"])
        if row.get("valid_from") is not None:
            current = edge["valid_from"]
            edge["valid_from"] = row["valid_from"] if current is None else min(current, row["valid_from"])
        if row.get("valid_to") is not None:
            current = edge["valid_to"]
            edge["valid_to"] = row["valid_to"] if current is None else max(current, row["valid_to"])

    result = []
    for edge in grouped.values():
        item = dict(edge)
        item["role_types"] = sorted(item["role_types"])
        result.append(item)
    return sorted(result, key=lambda item: (item["company_ico"], item["canonical_key"]))


def representative_names(rows: Iterable[dict]) -> dict[str, dict]:
    grouped: dict[str, Counter] = defaultdict(Counter)
    birth_dates: dict[tuple[str, str], object] = {}
    for row in rows:
        name = row.get("full_name")
        canonical_key = row["canonical_key"]
        grouped[canonical_key][name] += 1
        birth_dates[(canonical_key, name)] = row.get("birth_date")

    reps = {}
    for canonical_key, counts in grouped.items():
        name, _count = max(
            counts.items(),
            key=lambda item: (item[1], len(item[0] or ""), item[0] or ""),
        )
        reps[canonical_key] = {
            "canonical_key": canonical_key,
            "repr_full_name": name,
            "birth_date": birth_dates[(canonical_key, name)],
        }
    return reps


def parse_positive_int(value: str, name: str) -> int:
    try:
        parsed = int(value)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer") from exc
    if parsed <= 0:
        raise ValueError(f"{name} must be positive")
    return parsed


def parse_nonnegative_int(value: str, name: str) -> int:
    try:
        parsed = int(value)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer") from exc
    if parsed < 0:
        raise ValueError(f"{name} must be non-negative")
    return parsed


def load_config(db_url: str | None) -> Config:
    resolved_db_url = db_url or os.environ.get("DB_URL")
    if not resolved_db_url:
        raise RuntimeError("DB_URL must be set")
    return Config(
        db_url=resolved_db_url,
        work_mem=os.environ.get("WORK_MEM", "256MB"),
        statement_timeout=os.environ.get("STATEMENT_TIMEOUT", "30s"),
        batch_size=parse_positive_int(os.environ.get("BATCH_SIZE", "5000"), "BATCH_SIZE"),
        batch_sleep_ms=parse_nonnegative_int(os.environ.get("BATCH_SLEEP_MS", "50"), "BATCH_SLEEP_MS"),
    )


def connect(db_url: str):
    import psycopg2

    return psycopg2.connect(db_url)


def set_batch_settings(cur, config: Config) -> None:
    cur.execute("SET LOCAL work_mem = %s", (config.work_mem,))
    cur.execute("SET LOCAL statement_timeout = %s", (config.statement_timeout,))


def ensure_schema(conn) -> None:
    with conn:
        with conn.cursor() as cur:
            cur.execute(ENSURE_SQL)


def read_progress(cur) -> str:
    cur.execute(
        """
        INSERT INTO vr.build_progress (build_name, last_key)
        VALUES (%s, '')
        ON CONFLICT (build_name) DO NOTHING
        """,
        (PROGRESS_NAME,),
    )
    cur.execute("SELECT last_key FROM vr.build_progress WHERE build_name = %s", (PROGRESS_NAME,))
    row = cur.fetchone()
    return row[0] if row else ""


def write_progress(cur, last_key: str) -> None:
    cur.execute(
        """
        UPDATE vr.build_progress
        SET last_key = %s,
            updated_at = now()
        WHERE build_name = %s
        """,
        (last_key, PROGRESS_NAME),
    )


def run_batch(conn, config: Config, last_key: str) -> tuple[str | None, int, int]:
    with conn:
        with conn.cursor() as cur:
            set_batch_settings(cur, config)
            cur.execute(NEXT_KEY_SQL, (last_key, config.batch_size))
            row = cur.fetchone()
            next_key = row[0] if row else None
            if next_key is None:
                return None, 0, 0

            cur.execute(COUNT_BATCH_SQL, (last_key, config.batch_size))
            company_count = int(cur.fetchone()[0])

            cur.execute(COMPANY_EDGE_SQL, (last_key, config.batch_size))
            edge_rows = cur.rowcount if cur.rowcount and cur.rowcount > 0 else 0
            cur.execute(ENTITY_DEGREE_SQL, (last_key, next_key))
            cur.execute(PERSON_ENTITY_SQL, (last_key, next_key))
            write_progress(cur, next_key)
            return next_key, company_count, edge_rows


def print_dry_run(config: Config) -> None:
    print("-- First batch starts after last_key = ''")
    print(f"-- batch_size={config.batch_size} work_mem={config.work_mem} statement_timeout={config.statement_timeout}")
    print(ENSURE_SQL.strip())
    print(COMPANY_EDGE_SQL.strip())
    print(ENTITY_DEGREE_SQL.strip())
    print(PERSON_ENTITY_SQL.strip())


def build(config: Config) -> int:
    conn = connect(config.db_url)
    try:
        ensure_schema(conn)
        with conn:
            with conn.cursor() as cur:
                last_key = read_progress(cur)

        batch_no = 0
        while True:
            batch_no += 1
            started = time.monotonic()
            next_key, company_count, edge_rows = run_batch(conn, config, last_key)
            elapsed = time.monotonic() - started
            if next_key is None:
                print(f"complete batches={batch_no - 1} last_key={last_key!r}")
                return 0

            print(
                "batch=%s current_key=%s companies=%s edge_rows_upserted=%s elapsed_seconds=%.2f"
                % (batch_no, next_key, company_count, edge_rows, elapsed),
                flush=True,
            )
            last_key = next_key
            time.sleep(config.batch_sleep_ms / 1000.0)
    finally:
        conn.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build VR entity adjacency tables")
    parser.add_argument("--dry-run", action="store_true", help="print first batch SQL without executing")
    parser.add_argument("--db-url", help="database URL; defaults to DB_URL")
    args = parser.parse_args(argv)

    try:
        config = load_config(args.db_url)
        if args.dry_run:
            print_dry_run(config)
            return 0
        return build(config)
    except Exception as exc:
        print(f"build_entity_adjacency failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
