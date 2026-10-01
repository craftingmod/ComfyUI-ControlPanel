import asyncio
import copy
import json
import sqlite3
from contextlib import closing
from urllib.parse import parse_qs, urlsplit

import pytest

from backend import registry_cache


ACTIVE = "NodeVersionStatusActive"
FLAGGED = "NodeVersionStatusFlagged"
PENDING = "NodeVersionStatusPending"
NOW = 1780272000.0
METADATA = {"comfyui_version": "0.28.0", "form_factor": "git-windows", "platform": "windows", "channel": "jsdelivr"}


def version(node_id, number, status=ACTIVE, created_at="2026-06-01T00:00:00Z", identifier=None):
    return {"id": identifier or f"{node_id}-{number}", "node_id": node_id, "version": number,
            "status": status, "createdAt": created_at}


class Registry:
    def __init__(self, tmp_path):
        self.path = tmp_path / registry_cache.DB_FILENAME
        self.active = {"a": version("a", "0.9.0"), "b": version("b", "1.0.0")}
        self.histories = {key: [copy.deepcopy(value)] for key, value in self.active.items()}
        self.feed = [copy.deepcopy(self.active["a"])]
        self.catalog = [{"id": key, "created_at": "2026-05-01T00:00:00Z", "latest_version": copy.deepcopy(value)}
                        for key, value in self.active.items()]
        self.node_updates = []
        self.requests = []
        self.installed = {"a"}
        self.seed_hook = None
        self.page_hook = None
        self.fail = None
        self.now = NOW
        self.metadata = dict(METADATA)

    async def fetch_nodes(self, session, *, timestamp=None, metadata=None, on_line=None):
        self.requests.append(("catalog", timestamp))
        if self.fail == "catalog":
            raise RuntimeError("catalog unavailable")
        return {"nodes": copy.deepcopy(self.node_updates if timestamp else self.catalog), "totalPages": 1}

    async def fetch_json(self, session, url):
        parsed = urlsplit(url)
        params = parse_qs(parsed.query)
        self.requests.append((parsed.path, params))
        if self.fail == parsed.path:
            raise RuntimeError("API unavailable")
        if parsed.path == "/nodes":
            assert params.get("latest") == ["true"]
            assert params.get("comfyui_version") == [self.metadata["comfyui_version"]]
            nodes = [{"id": key, "latest_version": copy.deepcopy(self.active.get(key))}
                     for key in params["node_id"]]
            return {"nodes": nodes, "totalPages": 1, "total": len(nodes)}
        assert parsed.path == "/versions"
        assert params["pageSize"] == ["100"]
        page = int(params["page"][0])
        node_id = params.get("nodeId", [None])[0]
        source = self.histories[node_id.lower()] if node_id else self.feed
        rows = copy.deepcopy(source[(page - 1) * 100:page * 100])
        if node_id and self.seed_hook:
            hook, self.seed_hook = self.seed_hook, None
            hook()
        if not node_id and self.page_hook:
            self.page_hook(page)
        return {"versions": rows, "page": page, "pageSize": 100, "total": len(source),
                "totalPages": max(1, (len(source) + 99) // 100)}

    def sync(self, *, force=False, metadata=None):
        self.metadata = metadata or dict(METADATA)
        return asyncio.run(registry_cache.sync_registry_cache(
            None, db_path=self.path, metadata=self.metadata, installed_node_ids=self.installed,
            fetch_json=self.fetch_json, fetch_nodes=self.fetch_nodes, nodes_url="https://api.comfy.org/nodes",
            now=self.now, force_rebuild=force,
        ))

    def data(self):
        return registry_cache.read_registry_cache(self.path)

    def summary(self, node_id="a"):
        return self.data()["installed_node_versions"][node_id]

    def state(self):
        with closing(sqlite3.connect(self.path)) as connection:
            return {key: json.loads(value) for key, value in connection.execute("SELECT key, value FROM sync_state")}

    def history_calls(self, node_id=None):
        return [params for path, params in self.requests if path == "/versions" and "nodeId" in params
                and (node_id is None or params["nodeId"] == [node_id])]


def test_bootstrap_seeds_only_installed_summaries_and_records_empty_flagged(tmp_path):
    api = Registry(tmp_path)
    api.sync()
    data = api.data()
    assert len(data["nodes"]) == 2
    assert set(data["installed_node_versions"]) == {"a"}
    summary = api.summary()
    assert summary["latest_active"]["version"] == "0.9.0"
    assert summary["latest_flagged"] is None
    assert summary["version_seeded_at"] is not None
    assert summary["last_reconciled_at"] is not None
    assert len(api.history_calls()) == 1
    assert api.state()["versions_anchor_id"] == "a-0.9.0"
    with closing(sqlite3.connect(api.path)) as connection:
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"nodes", "installed_node_versions", "sync_state"} <= tables
    assert "versions" not in tables
    api.requests.clear()
    api.sync()
    assert api.history_calls() == []
    assert api.requests == []


@pytest.mark.parametrize("use_resolver", [False, True])
def test_installed_ids_preserve_registry_casing_across_bootstrap_and_incremental_sync(tmp_path, use_resolver):
    api = Registry(tmp_path)
    node_id = "ComfyUI-MixedCase"
    active = version(node_id, "0.9.0")
    api.active = {node_id: active}
    api.histories = {node_id.lower(): [copy.deepcopy(active)]}
    api.feed = [copy.deepcopy(active)]
    api.catalog = [{"id": node_id, "created_at": "2026-05-01T00:00:00Z",
                    "latest_version": version(node_id, "0.8.0")}]
    installed = {node_id.lower()}
    api.installed = (lambda nodes: installed) if use_resolver else installed

    api.sync()
    assert set(api.data()["installed_node_versions"]) == {node_id}
    assert api.summary(node_id)["latest_active"] == active
    assert api.data()["nodes"][0]["latest_version"] == active
    assert len(api.history_calls(node_id)) == 1
    assert next(params["node_id"] for path, params in api.requests if path == "/nodes") == [node_id]

    flagged = version(node_id, "0.10.0", FLAGGED, "2026-06-01T00:10:00Z")
    api.histories[node_id.lower()].insert(0, flagged)
    api.feed.insert(0, flagged)
    api.now += 3600
    api.sync()
    assert api.summary(node_id)["latest_flagged"] == flagged
    assert api.summary(node_id)["newest_observed"] == flagged
    assert api.summary(node_id)["latest_active"] == active

    api.requests.clear()
    api.sync()
    assert api.requests == []


def test_bootstrap_rejects_versions_for_another_node_without_publishing_db(tmp_path):
    api = Registry(tmp_path)
    api.histories["a"] = [version("b", "1.0.0")]
    with pytest.raises(ValueError, match="versions for a different node"):
        api.sync()
    assert not api.path.exists()
    assert not list(tmp_path.glob("*.tmp"))


def test_bootstrap_catches_version_created_after_head_capture_during_seed(tmp_path):
    api = Registry(tmp_path)
    pending = version("a", "0.10.0", PENDING, "2026-06-01T00:00:01Z")

    def publish_during_seed():
        api.feed.insert(0, pending)
        api.histories["a"].insert(0, pending)

    api.seed_hook = publish_during_seed
    api.sync()
    assert api.summary()["newest_observed"]["id"] == pending["id"]
    assert api.summary()["needs_version_reconcile"]
    assert api.state()["versions_anchor_id"] == pending["id"]
    first_head = next(index for index, (path, params) in enumerate(api.requests)
                      if path == "/versions" and "nodeId" not in params)
    first_seed = next(index for index, (path, params) in enumerate(api.requests)
                      if path == "/versions" and "nodeId" in params)
    assert first_head < first_seed


def test_hourly_incremental_uses_catalog_cursor_and_batch_without_node_histories(tmp_path):
    api = Registry(tmp_path)
    api.installed = {"a", "b"}
    api.sync()
    cursor = api.state()["nodes_incremental_cursor"]
    api.requests.clear()
    api.now += 3600
    api.node_updates = [{"id": "new", "created_at": "2026-06-01T00:30:00Z"}]
    api.sync()
    assert ("catalog", cursor) in api.requests
    batches = [params for path, params in api.requests if path == "/nodes"]
    assert len(batches) == 1
    assert set(batches[0]["node_id"]) == {"a", "b"}
    assert api.history_calls() == []
    assert {node["id"] for node in api.data()["nodes"]} == {"a", "b", "new"}


def test_new_install_seeds_once_even_inside_hourly_ttl_and_survives_restart(tmp_path):
    api = Registry(tmp_path)
    api.sync()
    api.requests.clear()
    api.installed.add("b")
    api.now += 5
    api.sync()
    assert len(api.history_calls("b")) == 1
    assert api.history_calls("a") == []
    assert api.summary("b")["version_seeded_at"] is not None
    api.requests.clear()
    # Every sync opens the persisted DB again, just as a process restart does.
    api.sync()
    assert api.history_calls() == []


def test_newer_flagged_summary_preserves_active_and_compares_semver(tmp_path):
    api = Registry(tmp_path)
    api.sync()
    flagged = version("a", "0.10.0", FLAGGED, "2026-06-01T00:10:00Z")
    api.feed.insert(0, flagged)
    api.histories["a"].insert(0, flagged)
    api.now += 3600
    api.sync()
    summary = api.summary()
    assert summary["latest_active"]["version"] == "0.9.0"
    assert summary["latest_flagged"] == flagged
    assert summary["newest_observed"] == flagged
    assert summary["needs_version_reconcile"]
    assert next(node for node in api.data()["nodes"] if node["id"] == "a")["latest_version"]["version"] == "0.9.0"


def test_pending_to_active_is_reconciled_without_new_created_row(tmp_path):
    api = Registry(tmp_path)
    pending = version("a", "0.10.0", PENDING, "2026-06-01T00:01:00Z")
    api.histories["a"].insert(0, pending)
    api.feed.insert(0, copy.deepcopy(pending))
    api.sync()
    assert api.summary()["needs_version_reconcile"]
    pending["status"] = ACTIVE
    api.active["a"] = copy.deepcopy(pending)
    api.requests.clear()
    api.now += 3600
    api.sync()
    summary = api.summary()
    assert summary["latest_active"]["id"] == pending["id"]
    assert summary["newest_observed"]["status"] == ACTIVE
    assert not summary["needs_version_reconcile"]
    assert len(api.history_calls("a")) == 1


def test_active_to_flagged_batch_regression_marks_reconcile(tmp_path):
    api = Registry(tmp_path)
    api.sync()
    api.histories["a"][0]["status"] = FLAGGED
    api.active["a"] = None
    api.now += 3600
    api.sync()
    assert api.summary()["latest_active"] is None
    assert api.summary()["latest_flagged"]["id"] == "a-0.9.0"
    assert api.summary()["needs_version_reconcile"]


@pytest.mark.parametrize("stage", ["catalog", "/nodes", "/versions"])
def test_incremental_failure_rolls_back_anchor_catalog_and_summaries(tmp_path, stage):
    api = Registry(tmp_path)
    api.sync()
    previous = api.data()
    previous_state = api.state()
    api.feed.insert(0, version("a", "0.10.0", FLAGGED, "2026-06-01T00:20:00Z"))
    api.node_updates = [{"id": "failed-new"}]
    api.now += 3600
    api.fail = stage
    with pytest.raises(RuntimeError):
        api.sync()
    assert api.data() == previous
    assert api.state() == previous_state
    api.fail = None
    api.histories["a"].insert(0, api.feed[0])
    api.sync()
    assert api.state()["versions_anchor_id"] == api.feed[0]["id"]


@pytest.mark.parametrize("reset", ["version", "30days", "manual"])
def test_full_catalog_reconciliation_preserves_summaries_anchor_and_old_db_on_failure(tmp_path, reset):
    api = Registry(tmp_path)
    api.sync()
    previous = api.data()
    previous_state = api.state()
    metadata = dict(METADATA)
    if reset == "version":
        metadata["comfyui_version"] = "0.29.0"
    elif reset == "30days":
        api.now += 30 * 86400
    api.fail = "catalog"
    with pytest.raises(RuntimeError):
        api.sync(force=reset == "manual", metadata=metadata)
    assert api.data() == previous
    assert api.state() == previous_state
    api.fail = None
    api.catalog = [node for node in api.catalog if node["id"] == "a"]
    api.requests.clear()
    api.sync(force=reset == "manual", metadata=metadata)
    assert {node["id"] for node in api.data()["nodes"]} == {"a"}
    assert api.summary()["version_seeded_at"] == previous["installed_node_versions"]["a"]["version_seeded_at"]
    assert api.summary()["last_reconciled_at"] == previous["installed_node_versions"]["a"]["last_reconciled_at"]
    assert api.state()["versions_anchor_id"] == previous_state["versions_anchor_id"]
    assert api.history_calls() == []
    assert ("catalog", None) in api.requests


def test_catalog_cursor_uses_server_node_creation_time_despite_client_clock_skew(tmp_path):
    api = Registry(tmp_path)
    api.now += 3600
    api.sync()
    assert api.state()["nodes_incremental_cursor"] == "2026-04-30T23:59:50Z"
    api.now += 3600
    api.sync()
    assert api.state()["nodes_incremental_cursor"] == "2026-04-30T23:59:50Z"


def test_comfyui_change_refreshes_active_batch_inside_ttl_without_reseeding(tmp_path):
    api = Registry(tmp_path)
    api.sync()
    previous_seed = api.summary()["version_seeded_at"]
    previous_anchor = api.state()["versions_anchor_id"]
    api.requests.clear()
    api.now += 10
    api.sync(metadata={**METADATA, "comfyui_version": "0.29.0"})
    batches = [params for path, params in api.requests if path == "/nodes"]
    assert len(batches) == 1
    assert batches[0]["comfyui_version"] == ["0.29.0"]
    assert api.history_calls() == []
    assert api.summary()["version_seeded_at"] == previous_seed
    assert api.state()["versions_anchor_id"] == previous_anchor


def test_summary_compares_semver_prerelease_numbers_and_release_precedence(tmp_path):
    api = Registry(tmp_path)
    api.histories["a"] += [version("a", "1.0.0-rc.2", FLAGGED), version("a", "1.0.0-rc.10", FLAGGED)]
    api.sync()
    assert api.summary()["latest_flagged"]["version"] == "1.0.0-rc.10"
    release = version("a", "1.0.0", FLAGGED, "2026-06-01T00:01:00Z")
    api.histories["a"].append(release)
    api.feed.insert(0, release)
    api.now += 3600
    api.sync()
    assert api.summary()["latest_flagged"]["version"] == "1.0.0"


def test_schema_mismatch_hard_rebuilds_only_after_success(tmp_path):
    api = Registry(tmp_path)
    api.sync()
    old_seed = api.summary()["version_seeded_at"]
    with closing(sqlite3.connect(api.path)) as connection, connection:
        connection.execute("UPDATE sync_state SET value = '-1' WHERE key = 'schema_version'")
    corrupt_state = api.state()
    api.now += 120
    api.fail = "catalog"
    with pytest.raises(RuntimeError):
        api.sync()
    assert api.state() == corrupt_state
    api.fail = None
    api.requests.clear()
    api.sync()
    assert api.state()["schema_version"] != -1
    assert api.summary()["version_seeded_at"] != old_seed
    assert len(api.history_calls("a")) == 1


def test_sqlite_integrity_failure_preserves_corrupt_file_until_replacement_succeeds(tmp_path):
    api = Registry(tmp_path)
    api.path.write_bytes(b"invalid sqlite data")
    api.fail = "catalog"
    with pytest.raises(RuntimeError):
        api.sync()
    assert api.path.read_bytes() == b"invalid sqlite data"
    api.fail = None
    api.sync()
    assert api.summary()["version_seeded_at"] is not None


def test_unrecoverable_anchor_state_hard_rebuilds(tmp_path):
    api = Registry(tmp_path)
    api.sync()
    with closing(sqlite3.connect(api.path)) as connection, connection:
        connection.execute("DELETE FROM sync_state WHERE key IN ('versions_anchor_id', 'versions_anchor_created_at', 'recent_seen_version_ids')")
    api.requests.clear()
    api.now += 120
    api.sync()
    assert len(api.history_calls("a")) == 1
    assert api.state()["versions_anchor_id"] == "a-0.9.0"


def test_missing_anchor_timestamp_uses_recent_seen_boundary_without_full_mirror(tmp_path):
    api = Registry(tmp_path)
    api.feed = [version("other", "1.0.0", created_at="2026-05-01T00:00:00Z", identifier=f"old-{index}")
                for index in range(400)]
    api.sync()
    seed_time = api.summary()["version_seeded_at"]
    with closing(sqlite3.connect(api.path)) as connection, connection:
        connection.execute("DELETE FROM sync_state WHERE key = 'versions_anchor_created_at'")
    api.feed = api.feed[1:]
    api.feed.insert(0, version("other", "1.0.0", created_at="2026-06-01T00:01:00Z", identifier="new-head"))
    api.requests.clear()
    api.now += 3600
    api.sync()
    global_pages = [params["page"] for path, params in api.requests if path == "/versions" and "nodeId" not in params]
    assert global_pages == [["1"], ["2"]]
    assert api.summary()["version_seeded_at"] == seed_time
    assert api.state()["versions_anchor_id"] == "new-head"


@pytest.mark.parametrize("corrupt_value", ["invalid", None, []])
def test_typed_invalid_sync_state_recovers_by_hard_rebuild(tmp_path, corrupt_value):
    api = Registry(tmp_path)
    api.sync()
    with closing(sqlite3.connect(api.path)) as connection, connection:
        connection.execute("UPDATE sync_state SET value=? WHERE key='last_full_sync_time'", (json.dumps(corrupt_value),))
    api.requests.clear()
    api.now += 120
    api.sync()
    assert api.state()["last_full_sync_time"] == api.now
    assert len(api.history_calls("a")) == 1


@pytest.mark.parametrize("table,field", [("nodes", "payload"), ("installed_node_versions", "latest_active")])
def test_invalid_cache_payload_is_rebuilt(tmp_path, table, field):
    api = Registry(tmp_path)
    api.sync()
    with closing(sqlite3.connect(api.path)) as connection, connection:
        connection.execute(f"UPDATE {table} SET {field}='[]'")
    api.requests.clear()
    api.sync()
    assert len(api.history_calls("a")) == 1


def test_feed_reads_boundary_overlap_dedupes_drift_and_restores_persisted_anchor(tmp_path):
    api = Registry(tmp_path)
    api.sync()
    old_anchor = api.feed[0]
    unrelated = [version("other", "1.0.0", created_at="2026-06-01T00:01:00Z", identifier=f"other-{index}")
                 for index in range(150)]
    flagged = version("a", "0.10.0", FLAGGED, "2026-06-01T00:02:00Z")
    api.feed = [flagged, *unrelated, old_anchor,
                *[version("other", "1.0.0", created_at="2026-05-01T00:00:00Z", identifier=f"older-{index}")
                  for index in range(300)]]
    api.histories["a"].insert(0, flagged)
    api.requests.clear()

    def drift(page):
        if page == 1:
            api.feed.insert(0, version("other", "2.0.0", created_at="2026-06-01T00:03:00Z", identifier="racing-head"))

    api.page_hook = drift
    api.now += 3600
    api.sync()
    global_pages = [params["page"] for path, params in api.requests if path == "/versions" and "nodeId" not in params]
    assert global_pages == [["1"], ["2"], ["3"]]
    assert api.summary()["newest_observed"]["id"] == flagged["id"]
    assert api.state()["versions_anchor_id"] == flagged["id"]
    seen = api.state()["recent_seen_version_ids"]
    assert len(seen) == len(set(seen))
    api.page_hook = None
    api.requests.clear()
    api.now += 3600
    api.sync()
    assert api.state()["versions_anchor_id"] == "racing-head"
    assert api.summary()["newest_observed"]["id"] == flagged["id"]


def test_deleted_anchor_uses_created_at_boundary_without_full_mirror(tmp_path):
    api = Registry(tmp_path)
    api.sync()
    api.feed = [version("other", "1.0.0", created_at="2026-06-01T00:01:00Z", identifier="new-head"),
                *[version("other", "1.0.0", created_at="2026-05-01T00:00:00Z", identifier=f"older-{index}")
                  for index in range(399)]]
    api.requests.clear()
    api.now += 3600
    api.sync()
    global_pages = [params["page"] for path, params in api.requests if path == "/versions" and "nodeId" not in params]
    assert global_pages == [["1"], ["2"]]
    assert api.state()["versions_anchor_id"] == "new-head"


def test_installed_resolver_sees_full_catalog_before_bootstrap_seed(tmp_path):
    api = Registry(tmp_path)
    catalogs = []

    def resolve(nodes):
        catalogs.append(nodes)
        return {"b"}

    api.installed = resolve
    api.sync()
    assert {node["id"] for node in catalogs[0]} == {"a", "b"}
    assert set(api.data()["installed_node_versions"]) == {"b"}
