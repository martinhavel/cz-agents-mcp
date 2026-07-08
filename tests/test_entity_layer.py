import importlib.util
import py_compile
import sys
from pathlib import Path
from unittest.mock import Mock


ROOT = Path(__file__).resolve().parents[1]
BUILD_SCRIPT = ROOT / "scripts" / "build_entity_adjacency.py"
QUERY_SCRIPT = ROOT / "scripts" / "ownership_query.py"
TEST_SCRIPT = ROOT / "tests" / "test_entity_layer.py"


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


build_entity_adjacency = load_module("build_entity_adjacency", BUILD_SCRIPT)
ownership_query = load_module("ownership_query", QUERY_SCRIPT)


class FakeCursor:
    def __init__(self, result_sets):
        self.result_sets = list(result_sets)
        self.executed = []

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False

    def execute(self, sql, params=None):
        self.executed.append((sql, params))

    def fetchall(self):
        return self.result_sets.pop(0)


class FakeConnection:
    def __init__(self, result_sets):
        self.cursor_obj = FakeCursor(result_sets)

    def cursor(self):
        return self.cursor_obj


def test_dedup_edge():
    rows = [
        {
            "company_ico": "29445469",
            "canonical_key": "jane-doe-1970",
            "role": "jednatel",
            "valid_from": "2020-01-01",
            "valid_to": "2022-01-01",
        },
        {
            "company_ico": "29445469",
            "canonical_key": "jane-doe-1970",
            "role": "spolecnik",
            "valid_from": "2019-01-01",
            "valid_to": "2024-01-01",
        },
        {
            "company_ico": "29445469",
            "canonical_key": "jane-doe-1970",
            "role": "jednatel",
            "valid_from": "2021-01-01",
            "valid_to": "2023-01-01",
        },
    ]

    edges = build_entity_adjacency.dedupe_edge_rows(rows)

    assert edges == [
        {
            "company_ico": "29445469",
            "canonical_key": "jane-doe-1970",
            "role_types": ["jednatel", "spolecnik"],
            "valid_from": "2019-01-01",
            "valid_to": "2024-01-01",
        }
    ]


def test_degree_cap():
    conn = FakeConnection(
        [
            [("hub-key", "Hub Person", ["jednatel"], None, None), ("normal-key", "Normal Person", ["clen"], None, None)],
            [("hub-key", 51, 935), ("normal-key", 2, 3)],
            [("12345678", "normal-key")],
        ]
    )

    result = ownership_query.get_company_network(conn, "29445469", max_degree=50, max_nodes=200)

    assert result["entities_1hop"][0]["is_hub"] is True
    assert result["entities_1hop"][1]["is_hub"] is False
    assert result["collapsed_hubs"] == [
        {"canonical_key": "hub-key", "repr_full_name": "Hub Person", "company_count": 51}
    ]
    assert result["companies_2hop"] == [{"ico": "12345678", "shared_entities": ["normal-key"]}]
    assert conn.cursor_obj.executed[2][1] == (["normal-key"], "29445469")


def test_max_nodes_cap():
    conn = FakeConnection(
        [
            [("entity-a", "Entity A", ["jednatel"], None, None)],
            [("entity-a", 3, 3)],
            [("10000001", "entity-a"), ("10000002", "entity-a"), ("10000003", "entity-a")],
        ]
    )

    result = ownership_query.get_company_network(conn, "29445469", max_degree=50, max_nodes=2)

    assert result["truncated"] is True
    assert len(result["companies_2hop"]) <= 2
    assert [company["ico"] for company in result["companies_2hop"]] == ["10000001", "10000002"]
    assert result["coverage"] == "partial (max_nodes cap)"


def test_1hop_no_cap():
    conn = FakeConnection(
        [
            [("hub-key", "Hub Person", ["jednatel"], None, None)],
            [("hub-key", 999, 935)],
        ]
    )

    result = ownership_query.get_company_network(conn, "29445469", max_degree=50, max_nodes=200)

    assert result["entities_1hop"] == [
        {
            "canonical_key": "hub-key",
            "repr_full_name": "Hub Person",
            "role_types": ["jednatel"],
            "valid_from": None,
            "valid_to": None,
            "is_hub": True,
        }
    ]
    assert result["collapsed_hubs"][0]["canonical_key"] == "hub-key"
    assert result["companies_2hop"] == []


def test_python_files_compile():
    compiler = Mock(wraps=py_compile.compile)
    for path in [BUILD_SCRIPT, QUERY_SCRIPT, TEST_SCRIPT]:
        compiler(str(path), doraise=True)

    assert compiler.call_count == 3
