import importlib.util
import sys
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "sync_ownership_cache.py"

spec = importlib.util.spec_from_file_location("sync_ownership_cache", SCRIPT)
sync_ownership_cache = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = sync_ownership_cache
spec.loader.exec_module(sync_ownership_cache)


class FakeSourceCursor:
    def __init__(self, summary_csv, edges_csv, summary_stats, edges_stats):
        self.summary_csv = summary_csv
        self.edges_csv = edges_csv
        self.summary_stats = summary_stats
        self.edges_stats = edges_stats
        self.fetchone_row = None

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False

    def execute(self, _sql, params=None):
        table = params[0]
        if table.endswith("company_network_summary"):
            self.fetchone_row = self.summary_stats
        elif table.endswith("ownership_edges"):
            self.fetchone_row = self.edges_stats
        else:
            raise AssertionError(f"unexpected source stats table: {table}")

    def fetchone(self):
        return self.fetchone_row

    def copy_expert(self, sql, file_obj):
        if "vr.company_network_summary" in sql:
            file_obj.write(self.summary_csv)
        elif "vr.ownership_edges" in sql:
            file_obj.write(self.edges_csv)
        else:
            raise AssertionError(f"unexpected source copy sql: {sql}")


class FakeTargetCursor:
    def __init__(self, conn):
        self.conn = conn
        self.fetchone_row = None

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False

    def execute(self, sql):
        self.conn.operations.append((sql.strip().split()[0], self.conn.in_transaction, sql))
        if sql.startswith("TRUNCATE"):
            self.conn.rows = {"company_network_summary": 0, "ownership_edges": 0}
        elif "count(*)" in sql and "company_network_summary" in sql:
            self.fetchone_row = (self.conn.rows["company_network_summary"],)
        elif "count(*)" in sql and "ownership_edges" in sql:
            self.fetchone_row = (self.conn.rows["ownership_edges"],)

    def fetchone(self):
        return self.fetchone_row

    def copy_expert(self, sql, file_obj):
        data = file_obj.read()
        rows = 0 if data == "" else len(data.rstrip("\n").splitlines())
        if "ownership_cache.company_network_summary" in sql:
            table = "company_network_summary"
        elif "ownership_cache.ownership_edges" in sql:
            table = "ownership_edges"
        else:
            raise AssertionError(f"unexpected target copy sql: {sql}")
        self.conn.rows[table] = rows
        self.conn.operations.append((f"COPY:{table}", self.conn.in_transaction, sql))


class FakeSourceConnection:
    def __init__(self, source_cursor):
        self.source_cursor = source_cursor

    def cursor(self):
        return self.source_cursor


class FakeTargetConnection:
    def __init__(self):
        self.rows = {"company_network_summary": 0, "ownership_edges": 0}
        self.operations = []
        self.in_transaction = False
        self.commits = 0
        self.rollbacks = 0

    def __enter__(self):
        self.in_transaction = True
        return self

    def __exit__(self, exc_type, *_exc):
        if exc_type:
            self.rollbacks += 1
        else:
            self.commits += 1
        self.in_transaction = False
        return False

    def cursor(self):
        return FakeTargetCursor(self)


def make_source(edges_bytes=20):
    as_of = datetime(2026, 6, 22, tzinfo=timezone.utc)
    summary_csv = "12345678,3,1,2026-06-22 00:00:00+00,99.00\n"
    edges_csv = "p1,c1,12345678,role,2020-01-01,,1,false,HIGH,2026-06-22 00:00:00+00,99.00\n"
    return FakeSourceConnection(
        FakeSourceCursor(
            summary_csv,
            edges_csv,
            (1, len(summary_csv), as_of),
            (1, edges_bytes, as_of),
        )
    )


def test_sync_streams_summary_and_edges_with_atomic_swap():
    target = FakeTargetConnection()

    result = sync_ownership_cache.sync(make_source(), target, max_edges_bytes=100)

    assert result.copied_edges is True
    assert target.rows == {"company_network_summary": 1, "ownership_edges": 1}
    assert target.commits == 1
    assert target.rollbacks == 0
    transactional_ops = [op for op in target.operations if op[0] in {"TRUNCATE", "COPY:company_network_summary", "COPY:ownership_edges"}]
    assert [op[0] for op in transactional_ops] == ["TRUNCATE", "COPY:company_network_summary", "COPY:ownership_edges"]
    assert all(op[1] is True for op in transactional_ops)
    truncate_sql = next(op[2] for op in target.operations if op[0] == "TRUNCATE")
    assert "fill_requests" not in truncate_sql


def test_ddl_creates_persistent_fill_requests_queue():
    assert "CREATE TABLE IF NOT EXISTS ownership_cache.fill_requests" in sync_ownership_cache.DDL_SQL
    assert "ico text PRIMARY KEY" in sync_ownership_cache.DDL_SQL
    assert "filled_at timestamptz NULL" in sync_ownership_cache.DDL_SQL


def test_sync_skips_edges_when_size_exceeds_threshold():
    target = FakeTargetConnection()

    result = sync_ownership_cache.sync(make_source(edges_bytes=101), target, max_edges_bytes=100)

    assert result.copied_edges is False
    assert target.rows == {"company_network_summary": 1, "ownership_edges": 0}
    assert not any(op[0] == "COPY:ownership_edges" for op in target.operations)
