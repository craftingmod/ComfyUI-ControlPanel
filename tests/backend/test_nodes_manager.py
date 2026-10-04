import asyncio
import json
import sqlite3
import sys
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qs, urlparse

import pytest

from backend import manager_routes, nodes_manager, registry_cache


def _registry_db(path):
  connection = sqlite3.connect(path)
  try:
    registry_cache._create_schema(connection)
    connection.execute(
      "INSERT INTO nodes (node_id, payload) VALUES (?, ?)",
      ("example-pack", json.dumps({"id": "example-pack", "name": "Example"})),
    )
    active = {
      "id": "active-id",
      "version": "1.2.0",
      "status": "NodeVersionStatusActive",
      "node_id": "example-pack",
      "createdAt": "2025-01-01T00:00:00Z",
    }
    flagged = {
      "id": "flagged-id",
      "version": "1.10.0",
      "status": "NodeVersionStatusFlagged",
      "node_id": "example-pack",
      "createdAt": "2025-02-01T00:00:00Z",
    }
    connection.execute(
      "INSERT INTO installed_node_versions "
      "(node_id, latest_active, latest_flagged, newest_observed, version_seeded_at, "
      "last_reconciled_at, needs_version_reconcile, last_active_refresh) "
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      (
        "example-pack",
        json.dumps(active),
        json.dumps(flagged),
        json.dumps(flagged),
        1.0,
        1.0,
        0,
        1.0,
      ),
    )
    connection.commit()
  finally:
    connection.close()


def test_local_catalog_reads_sqlite_projection_without_writing(tmp_path):
  database = tmp_path / "registry.db"
  legacy = tmp_path / "registry-node-list.json"
  _registry_db(database)
  original = database.read_bytes()

  safe = nodes_manager.read_local_catalog(database, legacy)
  flagged = nodes_manager.read_local_catalog(database, legacy, allow_flagged=True)

  assert safe["source"] == "sqlite"
  assert safe["nodes"][0]["latest_version"]["version"] == "1.2.0"
  assert flagged["nodes"][0]["latest_version"]["version"] == "1.10.0"
  assert database.read_bytes() == original


def test_local_catalog_uses_legacy_json_after_sqlite_failure(tmp_path):
  database = tmp_path / "registry.db"
  legacy = tmp_path / "registry-node-list.json"
  database.write_bytes(b"not sqlite")
  legacy.write_text(
    json.dumps({"nodes": [{"id": "legacy-pack", "name": "Legacy"}]}),
    encoding="utf-8",
  )

  result = nodes_manager.read_local_catalog(database, legacy)

  assert result["source"] == "legacy-json"
  assert result["warning"]
  assert result["nodes"][0]["id"] == "legacy-pack"


def test_local_catalog_reports_missing_or_corrupt_cache_actionably(tmp_path):
  with pytest.raises(
    nodes_manager.CatalogUnavailableError, match="Replace Manager Repository Data"
  ):
    nodes_manager.read_local_catalog(tmp_path / "missing.db", tmp_path / "missing.json")

  broken_db = tmp_path / "broken.db"
  broken_db.write_bytes(b"broken")
  broken_json = tmp_path / "broken.json"
  broken_json.write_text("{bad json", encoding="utf-8")
  with pytest.raises(nodes_manager.CatalogUnavailableError, match="invalid"):
    nodes_manager.read_local_catalog(broken_db, broken_json)


def test_local_catalog_uses_manager_json_as_read_only_stale_fallback(tmp_path):
  database = tmp_path / "registry.db"
  legacy = tmp_path / "registry-node-list.json"
  manager_json = tmp_path / "hashed_nodes.json"
  manager_json.write_text(
    json.dumps({"nodes": [{"id": "manager-pack", "name": "Manager cached"}]}),
    encoding="utf-8",
  )
  original = manager_json.read_bytes()

  result = nodes_manager.read_local_catalog(
    database, legacy, manager_json_path=manager_json
  )

  assert result["source"] == "manager-json"
  assert "may be stale" in result["warning"]
  assert result["nodes"][0]["id"] == "manager-pack"
  assert manager_json.read_bytes() == original


def test_manager_json_fallback_normalizes_legacy_node_map(tmp_path):
  manager_json = tmp_path / "manager.json"
  manager_json.write_text(
    json.dumps({"nodes": {"map-key": {"name": "Mapped", "status": "active"}}}),
    encoding="utf-8",
  )

  result = nodes_manager.read_local_catalog(
    tmp_path / "missing.db",
    tmp_path / "missing.json",
    manager_json_path=manager_json,
  )

  assert result["nodes"] == [{"name": "Mapped", "status": "active", "id": "map-key"}]


def test_registry_versions_validate_id_without_requesting_scanner_histories():
  calls = []

  async def fetch(url):
    calls.append(url)
    # Easy Use's two Flagged versions exceed 4 MB when reasons are requested.
    assert parse_qs(urlparse(url).query)["include_status_reason"] == ["false"]
    if "NodeVersionStatusActive" in url:
      return {"page": 1, "pageSize": 5, "totalPages": 0, "versions": []}
    return {
      "page": 1,
      "pageSize": 5,
      "total": 1,
      "totalPages": 1,
      "versions": [
        {
          "version": "2.0.0",
          "node_id": "example-pack",
          "status": "NodeVersionStatusFlagged",
          "status_reason": {"scanner": "registry", "reason": "review"},
        }
      ],
    }

  result = asyncio.run(
    nodes_manager.fetch_registry_versions("example-pack", fetch_json=fetch)
  )

  assert result[0]["status"] == "NodeVersionStatusFlagged"
  assert result[0]["status_reason"] == {"scanner": "registry", "reason": "review"}
  assert "nodeId=example-pack" in calls[0]
  assert "include_status_reason=false" in calls[0]
  assert "pageSize=5" in calls[0]
  assert len(calls) == 2
  with pytest.raises(ValueError, match="Registry node ID"):
    asyncio.run(nodes_manager.fetch_registry_versions("../outside", fetch_json=fetch))


def test_registry_versions_fetches_five_active_and_five_review_versions():
  calls = []

  async def fetch(url):
    calls.append(url)
    query = parse_qs(urlparse(url).query)
    assert query["page"] == ["1"]
    assert query["pageSize"] == ["5"]
    statuses = query["statuses"]
    review = "NodeVersionStatusFlagged" in statuses
    assert statuses == (
      ["NodeVersionStatusFlagged", "NodeVersionStatusPending"]
      if review
      else ["NodeVersionStatusActive"]
    )
    return {
      "page": 1,
      "pageSize": 5,
      "totalPages": 1000,
      "versions": [
        {
          "version": f"1.{int(review)}.{index}",
          "node_id": "example-pack",
          "status": "NodeVersionStatusPending" if review and index % 2 else statuses[0],
        }
        for index in range(5)
      ],
    }

  result = asyncio.run(
    nodes_manager.fetch_registry_versions("example-pack", fetch_json=fetch)
  )
  assert len(result) == 10
  assert len(calls) == 2
  assert sum(version["status"] == "NodeVersionStatusActive" for version in result) == 5
  assert result[0]["version"] == "1.1.4"


def test_registry_versions_excludes_banned_and_deduplicates():
  async def fetch(_url):
    return [
      {"version": "3.0.0", "status": "NodeVersionStatusBanned"},
      {"version": "2.0.0", "status": "NodeVersionStatusDeleted"},
      {"version": "1.0.0", "status": "NodeVersionStatusActive"},
      {"version": "1.0.0", "status": "NodeVersionStatusActive"},
    ]

  result = asyncio.run(
    nodes_manager.fetch_registry_versions("example-pack", fetch_json=fetch)
  )
  assert result == [{"version": "1.0.0", "status": "NodeVersionStatusActive"}]


def test_registry_json_reader_collects_streamed_chunks_and_enforces_limit():
  class Content:
    def __init__(self, chunks):
      self.chunks = chunks

    async def read(self, _size):
      return b""

    async def iter_chunked(self, _size):
      for chunk in self.chunks:
        yield chunk

  class Response:
    status = 200
    content_length = None
    reason = "OK"

    def __init__(self, chunks):
      self.content = Content(chunks)

    async def __aenter__(self):
      return self

    async def __aexit__(self, *_args):
      return None

  class Session:
    def __init__(self, response):
      self.response = response

    def get(self, _url):
      return self.response

  payload = b'{"versions":[{"version":"1.0.0"}]}'
  result = asyncio.run(
    nodes_manager._fetch_json(
      Session(Response([payload[:12], payload[12:]])), "https://example.test"
    )
  )
  assert result["versions"][0]["version"] == "1.0.0"

  too_large = b"x" * (nodes_manager.MAX_VERSION_RESPONSE_BYTES + 1)
  with pytest.raises(nodes_manager.RegistryVersionsError, match="size limit"):
    asyncio.run(
      nodes_manager._fetch_json(Session(Response([too_large])), "https://example.test")
    )


class _FakeRoutes:
  def __init__(self):
    self.handlers = {}

  def get(self, path):
    return self._register("GET", path)

  def post(self, path):
    return self._register("POST", path)

  def _register(self, method, path):
    def register(handler):
      self.handlers[(method, path)] = handler
      return handler

    return register


def _register_fake_routes(monkeypatch, api):
  routes = _FakeRoutes()
  monkeypatch.setitem(
    sys.modules,
    "server",
    SimpleNamespace(
      PromptServer=SimpleNamespace(instance=SimpleNamespace(routes=routes))
    ),
  )
  assert manager_routes.register_routes(api)
  return routes.handlers


def _route_api(*, denied=None, tmp_path=None):
  return SimpleNamespace(
    API_PREFIX="/control-panel",
    _MANAGER_POLICY_GIT_URL="git-url",
    _MANAGER_POLICY_LOW="low",
    _MANAGER_POLICY_MIDDLE="middle",
    control_request_denied_response=lambda request, policy=None: denied,
    _json_response=lambda data: {"status": 200, "data": data},
    _error_response=lambda message, status=500: {"status": status, "error": message},
    controlpanel_manager_cache_source_dir=lambda: tmp_path or Path("."),
    registry_cache_path=lambda _source: Path("missing.db"),
    manager_user_dir=lambda: Path("manager-user"),
    manager_url_cache_filename=lambda _url: "hashed_nodes.json",
    is_allow_flagged_version_as_latest_enabled=lambda: False,
  )


def test_nodes_manager_catalog_route_checks_protection_before_cache_read(monkeypatch):
  denied = {"status": 403}
  api = _route_api(denied=denied)
  handlers = _register_fake_routes(monkeypatch, api)

  def unexpected_read(*_args, **_kwargs):
    raise AssertionError("A denied request must not read the Registry cache.")

  monkeypatch.setattr(nodes_manager, "read_local_catalog", unexpected_read)
  handler = handlers[("GET", "/control-panel/nodes-manager/catalog")]
  result = asyncio.run(handler(SimpleNamespace(query={})))

  assert result is denied


@pytest.mark.parametrize(
  ("error", "expected_status"),
  [
    (ValueError("invalid node ID"), 400),
    (nodes_manager.RegistryVersionsError("Registry unavailable"), 502),
  ],
)
def test_nodes_manager_versions_route_maps_invalid_id_and_registry_errors(
  monkeypatch, error, expected_status
):
  api = _route_api()
  handlers = _register_fake_routes(monkeypatch, api)

  async def fail(_node_id):
    raise error

  monkeypatch.setattr(nodes_manager, "fetch_registry_versions", fail)
  handler = handlers[("GET", "/control-panel/nodes-manager/versions")]
  result = asyncio.run(handler(SimpleNamespace(query={"node_id": "pack"})))

  assert result["status"] == expected_status
  assert "error" in result
