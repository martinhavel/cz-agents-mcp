import importlib.util
import sys
from decimal import Decimal
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "ownership_network_refresh.py"

spec = importlib.util.spec_from_file_location("ownership_network_refresh", SCRIPT)
ownership_refresh = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = ownership_refresh
spec.loader.exec_module(ownership_refresh)


class FakeCursor:
    def __init__(self, companies=None, processed=None):
        self.companies = companies or []
        self.processed = processed or set()
        self.rows = []
        self.executed = []

    def execute(self, sql, params=None):
        params = params or {}
        self.executed.append((sql, params))
        last_ico = params.get("last_ico")
        limit = params.get("limit", len(self.companies))
        if "requested AS" in sql:
            requested = set(params["icos"])
            candidates = [ico for ico in self.companies if ico in requested]
        elif "FROM vr.companies c" in sql and "SELECT c.ico" in sql:
            candidates = list(self.companies)
        else:
            self.rows = []
            return

        self.rows = [
            (ico,)
            for ico in sorted(candidates)
            if (last_ico is None or ico > last_ico) and ico not in self.processed
        ][:limit]

    def fetchall(self):
        return self.rows


class ContextCursor:
    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False


class FakeConnection:
    def __init__(self):
        self.commits = 0
        self.rollbacks = 0

    def cursor(self):
        return ContextCursor()

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1


def test_refresh_commits_each_batch_independently(monkeypatch):
    conn = FakeConnection()
    batches = iter([["0001"], ["0002"], []])
    processed = []

    monkeypatch.setattr(ownership_refresh, "apply_session_settings", lambda cur: None)
    monkeypatch.setattr(ownership_refresh, "ensure_progress_table", lambda cur: None)
    monkeypatch.setattr(ownership_refresh, "compute_coverage", lambda cur: (2, 2, Decimal("100.00")))
    monkeypatch.setattr(ownership_refresh, "count_selected_icos", lambda cur, mode: 2)
    monkeypatch.setattr(ownership_refresh, "reset_progress_if_complete", lambda cur, mode, selected_icos: None)
    monkeypatch.setattr(ownership_refresh, "count_processed_markers", lambda cur, mode: 0)
    monkeypatch.setattr(ownership_refresh, "latest_import_as_of", lambda cur: None)
    monkeypatch.setattr(ownership_refresh, "fetch_next_batch", lambda cur, mode, last_ico, batch_size: next(batches))

    def fake_process_batch(cur, mode, icos, coverage_pct):
        processed.append(tuple(icos))
        return (len(icos), len(icos) * 2, len(icos))

    monkeypatch.setattr(ownership_refresh, "process_batch", fake_process_batch)

    mode = ownership_refresh.RefreshMode("full", "all")
    counts = ownership_refresh.refresh(conn, mode, batch_size=1)

    assert processed == [("0001",), ("0002",)]
    assert conn.commits == 4
    assert conn.rollbacks == 1
    assert counts.batches == 2
    assert counts.direct_edges == 2
    assert counts.depth2_edges == 4


def test_fetch_next_batch_skips_processed_icos():
    cur = FakeCursor(companies=["0001", "0002", "0003", "0004"], processed={"0002"})
    mode = ownership_refresh.RefreshMode("full", "all")

    batch = ownership_refresh.fetch_next_batch(cur, mode, last_ico=None, batch_size=3)

    assert batch == ["0001", "0003", "0004"]


def test_icos_mode_restricts_batches_to_requested_icos():
    args = ownership_refresh.parse_args(["--icos", "0003,0001", "--batch-size", "10"])
    mode = ownership_refresh.mode_from_args(args)
    cur = FakeCursor(companies=["0001", "0002", "0003", "0004"])

    batch = ownership_refresh.fetch_next_batch(cur, mode, last_ico=None, batch_size=10)

    assert mode.name == "icos"
    assert mode.icos == ("0003", "0001")
    assert batch == ["0001", "0003"]
    assert cur.executed[-1][1]["icos"] == ["0003", "0001"]
