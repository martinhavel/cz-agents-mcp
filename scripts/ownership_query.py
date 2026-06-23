#!/usr/bin/env python3
"""Bounded on-demand 2-hop VR ownership network query."""

from __future__ import annotations

import argparse
import json
import os
import sys
import time


def _rows_as_dicts(cursor, columns: list[str]) -> list[dict]:
    rows = cursor.fetchall()
    if not rows:
        return []
    first = rows[0]
    if isinstance(first, dict):
        return rows
    return [dict(zip(columns, row)) for row in rows]


def _coverage(truncated: bool, collapsed_hubs: list[dict]) -> str:
    reasons = []
    if collapsed_hubs:
        reasons.append("hub cap")
    if truncated:
        reasons.append("max_nodes cap")
    if not reasons:
        return "100%"
    return "partial (%s)" % ", ".join(reasons)


def get_company_network(conn, ico: str, max_degree: int = 50, max_nodes: int = 200) -> dict:
    started = time.monotonic()

    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT
              e.canonical_key,
              pe.repr_full_name,
              e.role_types,
              e.valid_from,
              e.valid_to
            FROM vr.company_entity_edge e
            LEFT JOIN vr.person_entity pe ON pe.canonical_key = e.canonical_key
            WHERE e.company_ico = %s
            ORDER BY e.canonical_key
            """,
            (ico,),
        )
        first_hop = _rows_as_dicts(
            cur,
            ["canonical_key", "repr_full_name", "role_types", "valid_from", "valid_to"],
        )

        canonical_keys = [row["canonical_key"] for row in first_hop]
        if canonical_keys:
            cur.execute(
                """
                SELECT canonical_key, company_count, record_count
                FROM vr.entity_degree
                WHERE canonical_key = ANY(%s)
                """,
                (canonical_keys,),
            )
            degree_rows = _rows_as_dicts(cur, ["canonical_key", "company_count", "record_count"])
        else:
            degree_rows = []

        degree_by_key = {row["canonical_key"]: row for row in degree_rows}
        entities_1hop = []
        collapsed_hubs = []
        non_hub_keys = []

        for row in first_hop:
            degree = degree_by_key.get(row["canonical_key"], {})
            company_count = int(degree.get("company_count") or 0)
            is_hub = company_count > max_degree
            entity = {
                "canonical_key": row["canonical_key"],
                "repr_full_name": row.get("repr_full_name"),
                "role_types": row.get("role_types") or [],
                "valid_from": row.get("valid_from"),
                "valid_to": row.get("valid_to"),
                "is_hub": is_hub,
            }
            entities_1hop.append(entity)
            if is_hub:
                collapsed_hubs.append(
                    {
                        "canonical_key": row["canonical_key"],
                        "repr_full_name": row.get("repr_full_name"),
                        "company_count": company_count,
                    }
                )
            else:
                non_hub_keys.append(row["canonical_key"])

        two_hop_rows = []
        if non_hub_keys:
            cur.execute(
                """
                SELECT DISTINCT e.company_ico, e.canonical_key
                FROM vr.company_entity_edge e
                WHERE e.canonical_key = ANY(%s)
                  AND e.company_ico != %s
                ORDER BY e.company_ico, e.canonical_key
                """,
                (non_hub_keys, ico),
            )
            two_hop_rows = _rows_as_dicts(cur, ["company_ico", "canonical_key"])

    companies_by_ico: dict[str, list[str]] = {}
    truncated = False
    for row in two_hop_rows:
        company_ico = row["company_ico"]
        if company_ico not in companies_by_ico and len(companies_by_ico) >= max_nodes:
            truncated = True
            continue
        companies_by_ico.setdefault(company_ico, []).append(row["canonical_key"])

    companies_2hop = [
        {"ico": company_ico, "shared_entities": sorted(set(shared_entities))}
        for company_ico, shared_entities in companies_by_ico.items()
    ]
    company_nodes = {ico} | set(companies_by_ico)
    entity_nodes = set(canonical_keys)
    first_hop_edge_count = len(entities_1hop)
    second_hop_edge_count = sum(len(company["shared_entities"]) for company in companies_2hop)

    return {
        "network_size": len(company_nodes) + len(entity_nodes),
        "shared_role_link_count": first_hop_edge_count + second_hop_edge_count,
        "coverage": _coverage(truncated, collapsed_hubs),
        "entities_1hop": entities_1hop,
        "companies_2hop": companies_2hop,
        "collapsed_hubs": collapsed_hubs,
        "truncated": truncated,
        "query_time_ms": (time.monotonic() - started) * 1000.0,
    }


def connect(db_url: str):
    import psycopg2

    return psycopg2.connect(db_url)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Query bounded VR company ownership network")
    parser.add_argument("--ico", required=True)
    parser.add_argument("--max-degree", type=int, default=50)
    parser.add_argument("--max-nodes", type=int, default=200)
    parser.add_argument("--db-url", default=os.environ.get("DB_URL"))
    args = parser.parse_args(argv)

    if not args.db_url:
        print("--db-url or DB_URL is required", file=sys.stderr)
        return 2

    conn = connect(args.db_url)
    try:
        result = get_company_network(conn, args.ico, args.max_degree, args.max_nodes)
    finally:
        conn.close()
    print(json.dumps(result, indent=2, sort_keys=True, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
