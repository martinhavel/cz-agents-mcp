#!/usr/bin/env python3
"""Refresh precomputed VR ownership network tables.

DEPRECATED: mini-cache/precompute refresh is retired in favor of on-demand VR base ownership queries.
Offline batch only -- do not call from API path.
"""

import argparse
import hashlib
import os
import subprocess
import sys
import traceback
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Sequence


REFRESH_NAME = "ownership_network"
PROGRESS_TABLE = "vr.ownership_refresh_progress"

# Depth-2 joins are N x (N - 1); very broad person keys create huge low-signal batches.
MAX_DEPTH2_COMPANIES_PER_PERSON = int(os.environ.get("MAX_DEPTH2_COMPANIES_PER_PERSON", "50"))
MAX_PERSON_RECORDS_PER_KEY = int(os.environ.get("MAX_PERSON_RECORDS_PER_KEY", "25"))
BATCH_SIZE = int(os.environ.get("BATCH_SIZE", "10000"))
WORK_MEM = os.environ.get("WORK_MEM", "256MB")
MAINTENANCE_WORK_MEM = os.environ.get("MAINTENANCE_WORK_MEM", "512MB")
STATEMENT_TIMEOUT = os.environ.get(
    "STATEMENT_TIMEOUT",
    os.environ.get("OWNERSHIP_STMT_TIMEOUT", "300s"),
)


@dataclass(frozen=True)
class Counts:
    direct_edges: int
    depth2_edges: int
    summary_rows: int
    processed_icos: int
    total_icos: int
    coverage_pct: Decimal
    batches: int
    skipped_icos: int


@dataclass(frozen=True)
class RefreshMode:
    name: str
    selector: str
    icos: tuple[str, ...] = ()
    since: str | None = None

    @property
    def key(self) -> str:
        raw = f"{self.name}:{self.selector}"
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()


SESSION_SQL = """
SET work_mem = %(work_mem)s;
SET maintenance_work_mem = %(maintenance_work_mem)s;
SET statement_timeout = %(statement_timeout)s;
"""


ENSURE_PROGRESS_SQL = f"""
CREATE TABLE IF NOT EXISTS {PROGRESS_TABLE} (
  refresh_name text NOT NULL,
  mode_key text NOT NULL,
  ico text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (refresh_name, mode_key, ico)
)
"""


DIRECT_INSERT_SQL = """
WITH batch_icos AS (
  SELECT unnest(%(icos)s::text[]) AS ico
),
latest_import AS (
  SELECT max(finished_at) AS as_of
  FROM vr.import_log
  WHERE status = 'done'
),
direct_roles AS (
  SELECT DISTINCT
    p.canonical_key AS canonical_key_person,
    'ico:' || r.company_ico AS canonical_key_company,
    r.company_ico AS ico,
    r.role AS role_type,
    r.valid_from,
    r.valid_to
  FROM batch_icos b
  JOIN vr.roles r ON r.company_ico = b.ico
  JOIN vr.persons p ON p.id = r.person_id
  JOIN vr.companies c ON c.ico = r.company_ico
  WHERE p.canonical_key IS NOT NULL
    AND r.company_ico IS NOT NULL
),
namesake_person_keys AS (
  SELECT p.canonical_key
  FROM vr.persons p
  JOIN (SELECT DISTINCT canonical_key_person AS canonical_key FROM direct_roles) k
    ON k.canonical_key = p.canonical_key
  WHERE p.birth_date IS NOT NULL
  GROUP BY p.canonical_key
  HAVING count(DISTINCT p.id) > 1
)
INSERT INTO vr.ownership_edges (
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
)
SELECT
  d.canonical_key_person,
  d.canonical_key_company,
  d.ico,
  d.role_type,
  d.valid_from,
  d.valid_to,
  1::int AS depth,
  (n.canonical_key IS NOT NULL) AS namesake_risk,
  CASE WHEN n.canonical_key IS NOT NULL THEN 'LOW' ELSE 'HIGH' END AS confidence,
  COALESCE((SELECT as_of FROM latest_import), now()) AS as_of,
  %(coverage_pct)s::numeric(5,2) AS coverage_pct
FROM direct_roles d
LEFT JOIN namesake_person_keys n ON n.canonical_key = d.canonical_key_person
"""


DEPTH2_INSERT_SQL = """
WITH batch_icos AS (
  SELECT unnest(%(icos)s::text[]) AS ico
),
latest_import AS (
  SELECT max(finished_at) AS as_of
  FROM vr.import_log
  WHERE status = 'done'
),
source_people AS (
  SELECT DISTINCT
    p.canonical_key,
    r.company_ico,
    r.role AS role_type,
    r.valid_from,
    r.valid_to
  FROM batch_icos b
  JOIN vr.roles r ON r.company_ico = b.ico
  JOIN vr.persons p ON p.id = r.person_id
  JOIN vr.companies c ON c.ico = r.company_ico
  WHERE p.canonical_key IS NOT NULL
    AND r.company_ico IS NOT NULL
),
hub_person_keys AS (
  SELECT p.canonical_key
  FROM vr.persons p
  JOIN (SELECT DISTINCT canonical_key FROM source_people) sp
    ON sp.canonical_key = p.canonical_key
  GROUP BY p.canonical_key
  HAVING count(DISTINCT p.id) > %(max_person_records_per_key)s
),
depth2_source_people AS (
  SELECT sp.*
  FROM source_people sp
  LEFT JOIN hub_person_keys h ON h.canonical_key = sp.canonical_key
  WHERE h.canonical_key IS NULL
),
person_company_roles AS (
  SELECT DISTINCT
    p.canonical_key,
    r.company_ico,
    r.role AS role_type,
    r.valid_from,
    r.valid_to
  FROM (SELECT DISTINCT canonical_key FROM depth2_source_people) sp
  JOIN vr.persons p ON p.canonical_key = sp.canonical_key
  JOIN vr.roles r ON r.person_id = p.id
  JOIN vr.companies c ON c.ico = r.company_ico
  WHERE r.company_ico IS NOT NULL
),
eligible_person_keys AS (
  SELECT canonical_key
  FROM person_company_roles
  GROUP BY canonical_key
  HAVING count(DISTINCT company_ico) <= %(max_depth2_companies)s
),
namesake_person_keys AS (
  SELECT p.canonical_key
  FROM vr.persons p
  JOIN (SELECT DISTINCT canonical_key FROM depth2_source_people) k
    ON k.canonical_key = p.canonical_key
  WHERE p.birth_date IS NOT NULL
  GROUP BY p.canonical_key
  HAVING count(DISTINCT p.id) > 1
)
INSERT INTO vr.ownership_edges (
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
)
SELECT DISTINCT
  source.canonical_key AS canonical_key_person,
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
FROM depth2_source_people source
JOIN eligible_person_keys eligible ON eligible.canonical_key = source.canonical_key
JOIN person_company_roles target
  ON target.canonical_key = source.canonical_key
 AND target.company_ico <> source.company_ico
LEFT JOIN namesake_person_keys n ON n.canonical_key = source.canonical_key
"""


SUMMARY_INSERT_SQL = """
INSERT INTO vr.company_network_summary (
  ico,
  network_size,
  shared_role_link_count,
  as_of,
  coverage_pct
)
SELECT
  e.ico,
  (
    count(DISTINCT e.canonical_key_person)
    + count(DISTINCT e.canonical_key_company)
  )::int AS network_size,
  count(*) FILTER (WHERE e.depth = 2)::int AS shared_role_link_count,
  max(e.as_of) AS as_of,
  max(e.coverage_pct)::numeric(5,2) AS coverage_pct
FROM vr.ownership_edges e
WHERE e.ico = ANY(%(icos)s::text[])
GROUP BY e.ico
"""


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Refresh precomputed VR ownership network tables.")
    parser.add_argument("--dry-run", action="store_true", help="Print selected batch counts without writing.")
    parser.add_argument(
        "--batch-size",
        type=int,
        default=BATCH_SIZE,
        help="ICO companies per commit batch; defaults to BATCH_SIZE env or 10000.",
    )
    parser.add_argument("--icos", help="Comma-separated ICO list to recompute incrementally.")
    parser.add_argument("--since", help="Recompute companies updated in vr.companies since YYYY-MM-DD.")
    args = parser.parse_args(argv)
    if args.batch_size <= 0:
        parser.error("--batch-size must be positive")
    if args.icos and args.since:
        parser.error("--icos and --since are mutually exclusive")
    return args


def mode_from_args(args: argparse.Namespace) -> RefreshMode:
    if args.icos:
        icos = tuple(dict.fromkeys(ico.strip() for ico in args.icos.split(",") if ico.strip()))
        if not icos:
            raise ValueError("--icos must include at least one ICO")
        return RefreshMode("icos", ",".join(icos), icos=icos)
    if args.since:
        return RefreshMode("since", args.since, since=args.since)
    return RefreshMode("full", "all")


def connect():
    dsn = os.environ.get("DB_URL") or os.environ.get("PG_DSN")
    if not dsn:
        raise RuntimeError("DB_URL or PG_DSN must be set")
    # DB_URL supplies host/port; do not hardcode deployment details here.
    import psycopg2

    return psycopg2.connect(dsn)


def lower_priority() -> None:
    try:
        os.nice(10)
    except OSError as exc:
        print(f"ownership_network_refresh could not lower nice priority: {exc}", file=sys.stderr)
    try:
        subprocess.run(["ionice", "-c", "2", "-n", "7", "-p", str(os.getpid())], check=False)
    except OSError as exc:
        print(f"ownership_network_refresh could not set ionice priority: {exc}", file=sys.stderr)


def apply_session_settings(cur) -> None:
    cur.execute(
        SESSION_SQL,
        {
            "work_mem": WORK_MEM,
            "maintenance_work_mem": MAINTENANCE_WORK_MEM,
            "statement_timeout": STATEMENT_TIMEOUT,
        },
    )


def scalar_int(cur, sql: str, params: dict | None = None) -> int:
    cur.execute(sql, params or {})
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


def latest_import_as_of(cur) -> datetime | None:
    cur.execute("SELECT max(finished_at) FROM vr.import_log WHERE status = 'done'")
    row = cur.fetchone()
    return row[0] if row else None


def ensure_progress_table(cur) -> None:
    cur.execute(ENSURE_PROGRESS_SQL)


def reset_progress_if_complete(cur, mode: RefreshMode, selected_icos: int) -> None:
    if selected_icos == 0:
        return
    processed = count_processed_markers(cur, mode)
    if processed >= selected_icos:
        cur.execute(
            "DELETE FROM vr.ownership_refresh_progress WHERE refresh_name = %s AND mode_key = %s",
            (REFRESH_NAME, mode.key),
        )


def fetch_next_batch(cur, mode: RefreshMode, last_ico: str | None, batch_size: int) -> list[str]:
    params = {"refresh_name": REFRESH_NAME, "mode_key": mode.key, "last_ico": last_ico, "limit": batch_size}
    if mode.name == "icos":
        cur.execute(
            """
            WITH requested AS (
              SELECT DISTINCT unnest(%(icos)s::text[]) AS ico
            )
            SELECT r.ico
            FROM requested r
            JOIN vr.companies c ON c.ico = r.ico
            WHERE (%(last_ico)s IS NULL OR r.ico > %(last_ico)s)
              AND NOT EXISTS (
                SELECT 1
                FROM vr.ownership_refresh_progress p
                WHERE p.refresh_name = %(refresh_name)s
                  AND p.mode_key = %(mode_key)s
                  AND p.ico = r.ico
              )
            ORDER BY r.ico
            LIMIT %(limit)s
            """,
            {**params, "icos": list(mode.icos)},
        )
    elif mode.name == "since":
        cur.execute(
            """
            SELECT c.ico
            FROM vr.companies c
            WHERE c.updated_at >= %(since)s::date
              AND (%(last_ico)s IS NULL OR c.ico > %(last_ico)s)
              AND NOT EXISTS (
                SELECT 1
                FROM vr.ownership_refresh_progress p
                WHERE p.refresh_name = %(refresh_name)s
                  AND p.mode_key = %(mode_key)s
                  AND p.ico = c.ico
              )
            ORDER BY c.ico
            LIMIT %(limit)s
            """,
            {**params, "since": mode.since},
        )
    else:
        cur.execute(
            """
            SELECT c.ico
            FROM vr.companies c
            WHERE (%(last_ico)s IS NULL OR c.ico > %(last_ico)s)
              AND NOT EXISTS (
                SELECT 1
                FROM vr.ownership_refresh_progress p
                WHERE p.refresh_name = %(refresh_name)s
                  AND p.mode_key = %(mode_key)s
                  AND p.ico = c.ico
              )
            ORDER BY c.ico
            LIMIT %(limit)s
            """,
            params,
        )
    return [str(row[0]) for row in cur.fetchall()]


def count_selected_icos(cur, mode: RefreshMode) -> int:
    if mode.name == "icos":
        return scalar_int(
            cur,
            "SELECT count(DISTINCT ico) FROM vr.companies WHERE ico = ANY(%(icos)s::text[])",
            {"icos": list(mode.icos)},
        )
    if mode.name == "since":
        return scalar_int(cur, "SELECT count(*) FROM vr.companies WHERE updated_at >= %(since)s::date", {"since": mode.since})
    return scalar_int(cur, "SELECT count(*) FROM vr.companies")


def count_processed_markers(cur, mode: RefreshMode) -> int:
    return scalar_int(
        cur,
        """
        SELECT count(*)
        FROM vr.ownership_refresh_progress
        WHERE refresh_name = %(refresh_name)s
          AND mode_key = %(mode_key)s
        """,
        {"refresh_name": REFRESH_NAME, "mode_key": mode.key},
    )


def process_batch(cur, mode: RefreshMode, icos: Sequence[str], coverage_pct: Decimal) -> tuple[int, int, int]:
    params = {
        "icos": list(icos),
        "coverage_pct": coverage_pct,
        "max_depth2_companies": MAX_DEPTH2_COMPANIES_PER_PERSON,
        "max_person_records_per_key": MAX_PERSON_RECORDS_PER_KEY,
    }
    cur.execute("DELETE FROM vr.ownership_edges WHERE ico = ANY(%(icos)s::text[])", {"icos": list(icos)})
    cur.execute("DELETE FROM vr.company_network_summary WHERE ico = ANY(%(icos)s::text[])", {"icos": list(icos)})

    cur.execute(DIRECT_INSERT_SQL, params)
    direct_count = cur.rowcount if cur.rowcount and cur.rowcount > 0 else 0

    cur.execute(DEPTH2_INSERT_SQL, params)
    depth2_count = cur.rowcount if cur.rowcount and cur.rowcount > 0 else 0

    cur.execute(SUMMARY_INSERT_SQL, {"icos": list(icos)})
    summary_count = cur.rowcount if cur.rowcount and cur.rowcount > 0 else 0

    cur.executemany(
        f"""
        INSERT INTO {PROGRESS_TABLE} (refresh_name, mode_key, ico)
        VALUES (%s, %s, %s)
        ON CONFLICT (refresh_name, mode_key, ico)
        DO UPDATE SET processed_at = EXCLUDED.processed_at
        """,
        [(REFRESH_NAME, mode.key, ico) for ico in icos],
    )
    return direct_count, depth2_count, summary_count


def refresh(conn, mode: RefreshMode, batch_size: int) -> Counts:
    direct_count = 0
    depth2_count = 0
    summary_count = 0
    batches = 0
    last_ico = None

    with conn.cursor() as cur:
        apply_session_settings(cur)
        ensure_progress_table(cur)
        processed_icos, total_icos, coverage_pct = compute_coverage(cur)
        selected_icos = count_selected_icos(cur, mode)
        reset_progress_if_complete(cur, mode, selected_icos)
        already_done = count_processed_markers(cur, mode)
        as_of = latest_import_as_of(cur)
    conn.commit()

    while True:
        with conn.cursor() as cur:
            apply_session_settings(cur)
            batch = fetch_next_batch(cur, mode, last_ico, batch_size)
            if not batch:
                conn.rollback()
                break
            d_count, d2_count, s_count = process_batch(cur, mode, batch, coverage_pct)
        conn.commit()

        batches += 1
        direct_count += d_count
        depth2_count += d2_count
        summary_count += s_count
        last_ico = batch[-1]
        print(
            f"batch {batches}: processed {len(batch)} ICOs through {last_ico}; "
            f"direct={d_count} depth2={d2_count} summary={s_count}",
            flush=True,
        )

    with conn.cursor() as cur:
        apply_session_settings(cur)
        cur.execute(
            """
            INSERT INTO vr.refresh_log (refresh_name, refreshed_at, rows_written, coverage_pct, ok)
            VALUES (%s, COALESCE(%s, now()), %s, %s, true)
            """,
            (REFRESH_NAME, as_of, direct_count + depth2_count + summary_count, coverage_pct),
        )
    conn.commit()

    return Counts(
        direct_count,
        depth2_count,
        summary_count,
        processed_icos,
        total_icos if mode.name == "full" else selected_icos,
        coverage_pct,
        batches,
        already_done,
    )


def dry_run(conn, mode: RefreshMode, batch_size: int) -> Counts:
    with conn.cursor() as cur:
        apply_session_settings(cur)
        ensure_progress_table(cur)
        processed_icos, total_icos, coverage_pct = compute_coverage(cur)
        selected_icos = count_selected_icos(cur, mode)
        already_done = count_processed_markers(cur, mode)
        batch = fetch_next_batch(cur, mode, None, batch_size)
    conn.rollback()
    return Counts(
        0,
        0,
        0,
        processed_icos,
        total_icos if mode.name == "full" else selected_icos,
        coverage_pct,
        1 if batch else 0,
        already_done,
    )


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    mode = mode_from_args(args)
    lower_priority()
    try:
        with connect() as conn:
            counts = dry_run(conn, mode, args.batch_size) if args.dry_run else refresh(conn, mode, args.batch_size)
        action = "dry-run" if args.dry_run else "refresh"
        print(
            f"{action}: mode={mode.name} batch_size={args.batch_size} batches={counts.batches} "
            f"direct_edges={counts.direct_edges} depth2_edges={counts.depth2_edges} "
            f"summary_rows={counts.summary_rows} processed_icos={counts.processed_icos} "
            f"selected_or_total_icos={counts.total_icos} skipped_icos={counts.skipped_icos} "
            f"coverage_pct={counts.coverage_pct}"
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
                apply_session_settings(cur)
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
