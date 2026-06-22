#!/usr/bin/env python3
"""Refresh precomputed VR ownership network tables.

Offline batch only -- do not call from API path.
"""

import argparse
import csv
import io
import os
import sys
import traceback
from dataclasses import dataclass
from decimal import Decimal
from typing import Iterable

import psycopg2


COPY_NULL = "\\N"
# Depth-2 joins are N x (N - 1); very broad person keys create huge low-signal batches.
MAX_DEPTH2_COMPANIES_PER_PERSON = 50
# Default 120s chrání noční inkrementální refresh před kontencí s živým dd.
# Initial full build nad ~150M řádky na ARM ho přesáhne → override přes env.
STATEMENT_TIMEOUT = os.environ.get("OWNERSHIP_STMT_TIMEOUT", "120s")
REFRESH_NAME = "ownership_network"


@dataclass(frozen=True)
class Counts:
    direct_edges: int
    depth2_edges: int
    summary_rows: int
    processed_icos: int
    total_icos: int
    coverage_pct: Decimal


DIRECT_EDGES_SQL = """
WITH latest_import AS (
  SELECT max(finished_at) AS as_of
  FROM vr.import_log
  WHERE status = 'done'
),
namesake_person_keys AS (
  SELECT canonical_key
  FROM vr.persons
  WHERE canonical_key IS NOT NULL
    AND birth_date IS NOT NULL
  GROUP BY canonical_key
  HAVING count(DISTINCT id) > 1
),
direct_edges AS (
  SELECT DISTINCT
    p.canonical_key AS canonical_key_person,
    'ico:' || r.company_ico AS canonical_key_company,
    r.company_ico AS ico,
    r.role AS role_type,
    r.valid_from,
    r.valid_to,
    1::int AS depth,
    (n.canonical_key IS NOT NULL) AS namesake_risk,
    CASE WHEN n.canonical_key IS NOT NULL THEN 'LOW' ELSE 'HIGH' END AS confidence,
    COALESCE((SELECT as_of FROM latest_import), now()) AS as_of,
    %(coverage_pct)s::numeric(5,2) AS coverage_pct
  FROM vr.persons p
  JOIN vr.roles r ON r.person_id = p.id
  JOIN vr.companies c ON c.ico = r.company_ico
  LEFT JOIN namesake_person_keys n ON n.canonical_key = p.canonical_key
  WHERE p.canonical_key IS NOT NULL
    AND r.company_ico IS NOT NULL
)
SELECT
  canonical_key_person,
  canonical_key_company,
  ico,
  role_type,
  valid_from,
  valid_to,
  depth,
  namesake_risk,
  confidence,
  as_of,
  coverage_pct
FROM direct_edges
ORDER BY ico, canonical_key_person, canonical_key_company, role_type NULLS LAST
"""


DEPTH2_EDGES_SQL = """
WITH latest_import AS (
  SELECT max(finished_at) AS as_of
  FROM vr.import_log
  WHERE status = 'done'
),
namesake_person_keys AS (
  SELECT canonical_key
  FROM vr.persons
  WHERE canonical_key IS NOT NULL
    AND birth_date IS NOT NULL
  GROUP BY canonical_key
  HAVING count(DISTINCT id) > 1
),
person_company_roles AS (
  SELECT DISTINCT
    p.canonical_key AS canonical_key_person,
    r.company_ico,
    r.role AS role_type,
    r.valid_from,
    r.valid_to
  FROM vr.persons p
  JOIN vr.roles r ON r.person_id = p.id
  JOIN vr.companies c ON c.ico = r.company_ico
  WHERE p.canonical_key IS NOT NULL
    AND r.company_ico IS NOT NULL
),
eligible_person_keys AS (
  SELECT canonical_key_person
  FROM person_company_roles
  GROUP BY canonical_key_person
  HAVING count(DISTINCT company_ico) <= %(max_depth2_companies)s
),
depth2_edges AS (
  SELECT DISTINCT
    source.canonical_key_person,
    'ico:' || target.company_ico AS canonical_key_company,
    source.company_ico AS ico,
    source.role_type,
    source.valid_from,
    source.valid_to,
    2::int AS depth,
    (n.canonical_key IS NOT NULL) AS namesake_risk,
    CASE WHEN n.canonical_key IS NOT NULL THEN 'LOW' ELSE 'HIGH' END AS confidence,
    COALESCE((SELECT as_of FROM latest_import), now()) AS as_of,
    %(coverage_pct)s::numeric(5,2) AS coverage_pct
  FROM person_company_roles source
  JOIN eligible_person_keys eligible
    ON eligible.canonical_key_person = source.canonical_key_person
  JOIN person_company_roles target
    ON target.canonical_key_person = source.canonical_key_person
   AND target.company_ico <> source.company_ico
  LEFT JOIN namesake_person_keys n ON n.canonical_key = source.canonical_key_person
)
SELECT
  canonical_key_person,
  canonical_key_company,
  ico,
  role_type,
  valid_from,
  valid_to,
  depth,
  namesake_risk,
  confidence,
  as_of,
  coverage_pct
FROM depth2_edges
ORDER BY ico, canonical_key_person, canonical_key_company, role_type NULLS LAST
"""


SUMMARY_SQL = """
WITH edges AS (
  SELECT * FROM vr.ownership_edges
)
SELECT
  ico,
  (
    count(DISTINCT canonical_key_person)
    + count(DISTINCT canonical_key_company)
  )::int AS network_size,
  count(*) FILTER (WHERE depth = 2)::int AS shared_role_link_count,
  max(as_of) AS as_of,
  max(coverage_pct)::numeric(5,2) AS coverage_pct
FROM edges
GROUP BY ico
ORDER BY ico
"""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Refresh precomputed VR ownership network tables.")
    parser.add_argument("--dry-run", action="store_true", help="Print row counts without writing.")
    parser.add_argument("--batch-size", type=int, default=500, help="Fetch and copy batch size.")
    return parser.parse_args()


def connect():
    dsn = os.environ.get("DB_URL") or os.environ.get("PG_DSN")
    if not dsn:
        raise RuntimeError("DB_URL or PG_DSN must be set")
    # This off-peak batch must not starve the live MCP traffic on opi5plus.
    return psycopg2.connect(dsn)


def scalar_int(cur, sql: str) -> int:
    cur.execute(sql)
    row = cur.fetchone()
    return int(row[0] or 0)


def compute_coverage(cur) -> tuple[int, int, Decimal]:
    processed = scalar_int(
        cur,
        """
        SELECT count(DISTINCT c.ico)
        FROM vr.companies c
        JOIN vr.roles r ON r.company_ico = c.ico
        JOIN vr.persons p ON p.id = r.person_id
        WHERE p.canonical_key IS NOT NULL
        """,
    )
    total = scalar_int(cur, "SELECT COALESCE(sum(companies_n), 0) FROM vr.import_log WHERE status = 'done'")
    if total == 0:
        return processed, total, Decimal("0.00")
    coverage = (Decimal(processed) / Decimal(total) * Decimal(100)).quantize(Decimal("0.01"))
    return processed, total, min(coverage, Decimal("100.00"))


def stream_rows(cur, sql: str, coverage_pct: Decimal, batch_size: int) -> Iterable[tuple]:
    cur.itersize = batch_size
    cur.execute(
        sql,
        {
            "coverage_pct": coverage_pct,
            "max_depth2_companies": MAX_DEPTH2_COMPANIES_PER_PERSON,
        },
    )
    while True:
        rows = cur.fetchmany(batch_size)
        if not rows:
            break
        for row in rows:
            yield row


def write_copy(cur, table: str, columns: list[str], rows: Iterable[tuple]) -> int:
    buf = io.StringIO()
    writer = csv.writer(buf, delimiter="\t", lineterminator="\n")
    count = 0
    for row in rows:
        writer.writerow([COPY_NULL if value is None else value for value in row])
        count += 1
    buf.seek(0)
    cur.copy_from(buf, table, columns=columns, sep="\t", null=COPY_NULL)
    return count


def count_query(cur, sql: str, coverage_pct: Decimal) -> int:
    cur.execute(f"SET LOCAL statement_timeout = '{STATEMENT_TIMEOUT}'")
    cur.execute(
        f"SELECT count(*) FROM ({sql}) q",
        {
            "coverage_pct": coverage_pct,
            "max_depth2_companies": MAX_DEPTH2_COMPANIES_PER_PERSON,
        },
    )
    row = cur.fetchone()
    return int(row[0] or 0)


def refresh(conn, batch_size: int) -> Counts:
    edge_columns = [
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
    ]
    summary_columns = ["ico", "network_size", "shared_role_link_count", "as_of", "coverage_pct"]

    with conn.cursor() as cur:
        processed_icos, total_icos, coverage_pct = compute_coverage(cur)
        cur.execute("SET LOCAL search_path TO vr, public")
        cur.execute("TRUNCATE vr.ownership_edges, vr.company_network_summary")

        direct_cur = conn.cursor(name="ownership_direct_edges")
        depth2_cur = conn.cursor(name="ownership_depth2_edges")
        try:
            cur.execute(f"SET LOCAL statement_timeout = '{STATEMENT_TIMEOUT}'")
            direct_count = write_copy(
                cur,
                "ownership_edges",
                edge_columns,
                stream_rows(direct_cur, DIRECT_EDGES_SQL, coverage_pct, batch_size),
            )
            cur.execute(f"SET LOCAL statement_timeout = '{STATEMENT_TIMEOUT}'")
            depth2_count = write_copy(
                cur,
                "ownership_edges",
                edge_columns,
                stream_rows(depth2_cur, DEPTH2_EDGES_SQL, coverage_pct, batch_size),
            )
        finally:
            direct_cur.close()
            depth2_cur.close()

        summary_count = write_copy(cur, "company_network_summary", summary_columns, summary_rows(cur))
        cur.execute(
            """
            INSERT INTO vr.refresh_log (refresh_name, rows_written, coverage_pct, ok)
            VALUES (%s, %s, %s, true)
            """,
            (REFRESH_NAME, direct_count + depth2_count + summary_count, coverage_pct),
        )

    conn.commit()
    return Counts(direct_count, depth2_count, summary_count, processed_icos, total_icos, coverage_pct)


def summary_rows(cur) -> Iterable[tuple]:
    cur.execute(f"SET LOCAL statement_timeout = '{STATEMENT_TIMEOUT}'")
    cur.execute(SUMMARY_SQL)
    return cur.fetchall()


def dry_run(conn, batch_size: int) -> Counts:
    with conn.cursor() as cur:
        processed_icos, total_icos, coverage_pct = compute_coverage(cur)
        direct_count = count_query(cur, DIRECT_EDGES_SQL, coverage_pct)
        depth2_count = count_query(cur, DEPTH2_EDGES_SQL, coverage_pct)
        summary_count = scalar_int(
            cur,
            """
            WITH direct_icos AS (
              SELECT DISTINCT r.company_ico AS ico
              FROM vr.persons p
              JOIN vr.roles r ON r.person_id = p.id
              JOIN vr.companies c ON c.ico = r.company_ico
              WHERE p.canonical_key IS NOT NULL
                AND r.company_ico IS NOT NULL
            )
            SELECT count(*) FROM direct_icos
            """,
        )
    _ = batch_size
    return Counts(direct_count, depth2_count, summary_count, processed_icos, total_icos, coverage_pct)


def main() -> int:
    args = parse_args()
    # Lower scheduler priority so refresh work competes less with live dd traffic on opi5plus.
    os.nice(10)
    try:
        with connect() as conn:
            counts = dry_run(conn, args.batch_size) if args.dry_run else refresh(conn, args.batch_size)
        mode = "dry-run" if args.dry_run else "refresh"
        print(
            f"{mode}: direct_edges={counts.direct_edges} depth2_edges={counts.depth2_edges} "
            f"summary_rows={counts.summary_rows} processed_icos={counts.processed_icos} "
            f"total_icos={counts.total_icos} coverage_pct={counts.coverage_pct}"
        )
        return 0
    except Exception as exc:
        print(f"ownership_network_refresh failed: {exc}", file=sys.stderr)
        log_failure(traceback.format_exc())
        return 1


def log_failure(error: str) -> None:
    try:
        with connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO vr.refresh_log (refresh_name, rows_written, ok, error)
                    VALUES (%s, 0, false, %s)
                    """,
                    (REFRESH_NAME, error[:4000]),
                )
            conn.commit()
    except Exception as log_exc:
        print(f"ownership_network_refresh failed to write refresh_log: {log_exc}", file=sys.stderr)


if __name__ == "__main__":
    sys.exit(main())
