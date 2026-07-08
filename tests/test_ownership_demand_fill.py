import importlib.util
import sys
from pathlib import Path
from types import SimpleNamespace


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "ownership_demand_fill.py"
SYNC_SCRIPT = ROOT / "scripts" / "sync_ownership_cache.py"

sync_spec = importlib.util.spec_from_file_location("sync_ownership_cache", SYNC_SCRIPT)
sync_ownership_cache = importlib.util.module_from_spec(sync_spec)
sys.modules[sync_spec.name] = sync_ownership_cache
sync_spec.loader.exec_module(sync_ownership_cache)

spec = importlib.util.spec_from_file_location("ownership_demand_fill", SCRIPT)
ownership_demand_fill = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = ownership_demand_fill
spec.loader.exec_module(ownership_demand_fill)


class DummyLock:
    def __init__(self):
        self.closed = False

    def close(self):
        self.closed = True


class FakeCacheConnection:
    def __init__(self, pending):
        self.pending = pending
        self.queries = []
        self.marked = None
        self.closed = False
        self.in_transaction = False

    def __enter__(self):
        self.in_transaction = True
        return self

    def __exit__(self, *_exc):
        self.in_transaction = False
        return False

    def cursor(self):
        return self

    def execute(self, sql, params=None):
        self.queries.append((sql, params))
        if "SELECT ico FROM ownership_cache.fill_requests" in sql:
            self.fetchall_rows = [(ico,) for ico in self.pending]
        if "UPDATE ownership_cache.fill_requests" in sql:
            self.marked = params[0]

    def fetchall(self):
        return self.fetchall_rows

    def close(self):
        self.closed = True


def test_main_runs_pending_build_sync_and_marks_filled(monkeypatch):
    cache = FakeCacheConnection(["12345678", "87654321"])
    calls = []

    monkeypatch.setenv("SOURCE_DB_URL", "postgres://source")
    monkeypatch.setenv("CACHE_DB_URL", "postgres://cache")
    monkeypatch.setenv("MAX_FILL_PER_RUN", "2")
    monkeypatch.setenv("PYTHON_BIN", "python-test")
    monkeypatch.setattr(ownership_demand_fill, "acquire_lock", lambda: DummyLock())
    monkeypatch.setattr(ownership_demand_fill.sync_ownership_cache, "connect", lambda dsn: cache)
    monkeypatch.setattr(
        ownership_demand_fill,
        "run_build",
        lambda icos, source_dsn, python_bin: calls.append(("build", list(icos), source_dsn, python_bin))
        or SimpleNamespace(returncode=0),
    )
    monkeypatch.setattr(
        ownership_demand_fill,
        "sync_cache",
        lambda source_dsn, cache_dsn: calls.append(("sync", source_dsn, cache_dsn)),
    )

    assert ownership_demand_fill.main() == 0
    assert calls == [
        ("build", ["12345678", "87654321"], "postgres://source", "python-test"),
        ("sync", "postgres://source", "postgres://cache"),
    ]
    assert cache.marked == ["12345678", "87654321"]
    assert cache.closed is True


def test_main_noops_when_queue_is_empty(monkeypatch):
    cache = FakeCacheConnection([])
    calls = []

    monkeypatch.setenv("SOURCE_DB_URL", "postgres://source")
    monkeypatch.setenv("CACHE_DB_URL", "postgres://cache")
    monkeypatch.setattr(ownership_demand_fill, "acquire_lock", lambda: DummyLock())
    monkeypatch.setattr(ownership_demand_fill.sync_ownership_cache, "connect", lambda dsn: cache)
    monkeypatch.setattr(ownership_demand_fill, "run_build", lambda *_args: calls.append("build"))
    monkeypatch.setattr(ownership_demand_fill, "sync_cache", lambda *_args: calls.append("sync"))

    assert ownership_demand_fill.main() == 0
    assert calls == []
    assert cache.marked is None
