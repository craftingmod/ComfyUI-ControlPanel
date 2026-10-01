from __future__ import annotations

import hashlib
import json
import math
import os
import re
import sqlite3
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

from .manager_cache import format_iso_timestamp, parse_iso_datetime

DB_FILENAME = "registry.db"
SCHEMA_VERSION = 1
SYNC_INTERVAL_SECONDS = 3600
FULL_RESET_SECONDS = 30 * 86400
PAGE_SIZE = 100
RECENT_SEEN_LIMIT = 300
_SEMVER = re.compile(
    r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
    r"(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
)


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _create_schema(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
        CREATE TABLE nodes (node_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
        CREATE TABLE installed_node_versions (
            node_id TEXT PRIMARY KEY,
            latest_active TEXT,
            latest_flagged TEXT,
            newest_observed TEXT,
            version_seeded_at REAL,
            last_reconciled_at REAL,
            needs_version_reconcile INTEGER NOT NULL DEFAULT 0,
            last_active_refresh REAL
        );
        CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        """
    )


def _state(connection: sqlite3.Connection) -> dict[str, Any]:
    return {row[0]: json.loads(row[1]) for row in connection.execute("SELECT key, value FROM sync_state")}


def _set_state(connection: sqlite3.Connection, **values: Any) -> None:
    connection.executemany(
        "INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        ((key, _json(value)) for key, value in values.items()),
    )


def _catalog(connection: sqlite3.Connection) -> list[dict[str, Any]]:
    nodes = [json.loads(row[0]) for row in connection.execute("SELECT payload FROM nodes ORDER BY rowid")]
    if any(not isinstance(node, dict) for node in nodes):
        raise ValueError("Comfy Registry catalog cache contained an invalid node.")
    for node in nodes:
        _node_id(node)
    return nodes


def _node_id(node: dict[str, Any]) -> str:
    value = node.get("id") or node.get("node_id")
    if not isinstance(value, str) or not value:
        raise ValueError("Comfy Registry node did not include an id.")
    return value


def _save_nodes(connection: sqlite3.Connection, data: Any) -> None:
    if not isinstance(data, dict) or not isinstance(data.get("nodes"), list):
        raise ValueError("Comfy Registry nodes response did not include a nodes list.")
    rows = []
    for node in data["nodes"]:
        if not isinstance(node, dict):
            raise ValueError("Comfy Registry node was not an object.")
        rows.append((_node_id(node), _json(node)))
    connection.executemany(
        "INSERT INTO nodes (node_id, payload) VALUES (?, ?) ON CONFLICT(node_id) DO UPDATE SET payload=excluded.payload",
        rows,
    )


def _catalog_cursor(data: dict, previous: str | None, now: float) -> str:
    timestamps = [parse_iso_datetime(node.get("created_at") or node.get("createdAt")) for node in data["nodes"]]
    created_at = max((value for value in timestamps if value is not None), default=None)
    if created_at is None:
        return previous or format_iso_timestamp(now - 10)
    cursor = created_at - 10
    previous_timestamp = parse_iso_datetime(previous)
    return format_iso_timestamp(max(cursor, previous_timestamp) if previous_timestamp is not None else cursor)


def _semver_key(version: dict[str, Any]) -> tuple:
    value = version.get("version")
    match = _SEMVER.fullmatch(value) if isinstance(value, str) else None
    if match is None:
        raise ValueError(f"Comfy Registry version was not valid SemVer: {value!r}")
    prerelease = match[4]
    identifiers = []
    for identifier in prerelease.split(".") if prerelease else []:
        if identifier.isdigit():
            if len(identifier) > 1 and identifier.startswith("0"):
                raise ValueError(f"Comfy Registry version was not valid SemVer: {value!r}")
            identifiers.append((0, int(identifier)))
        else:
            identifiers.append((1, identifier))
    return (int(match[1]), int(match[2]), int(match[3]), int(prerelease is None), tuple(identifiers))


def _status(version: dict[str, Any]) -> str:
    status = version.get("status", "")
    if not isinstance(status, str):
        raise ValueError("Comfy Registry version status was not a string.")
    status = status.removeprefix("NodeVersionStatus").lower()
    if status not in {"active", "pending", "flagged", "deleted", "banned"}:
        raise ValueError(f"Comfy Registry version status was invalid: {status!r}")
    return status


def _created_at(version: dict[str, Any]) -> float:
    value = parse_iso_datetime(version.get("createdAt") or version.get("created_at"))
    if value is None:
        raise ValueError("Comfy Registry version did not include a valid createdAt.")
    return value


def _version_id(version: dict[str, Any]) -> str:
    value = version.get("id")
    if not isinstance(value, str) or not value:
        raise ValueError("Comfy Registry version did not include an id.")
    return value


def _latest(versions: list[dict[str, Any]]) -> dict[str, Any] | None:
    return max(versions, key=lambda version: (_semver_key(version), _created_at(version)), default=None)


def _needs_reconcile(newest: dict[str, Any] | None, active: dict[str, Any] | None) -> bool:
    if newest is None:
        return False
    if active is None or _status(newest) != "active":
        return True
    if newest.get("id") and active.get("id"):
        return newest["id"] != active["id"]
    return _semver_key(newest) != _semver_key(active)


def _same_version(left: dict | None, right: dict | None) -> bool:
    if left is None or right is None:
        return left is right
    if left.get("id") and right.get("id"):
        return left["id"] == right["id"]
    return _semver_key(left) == _semver_key(right)


def _summaries(connection: sqlite3.Connection) -> dict[str, dict[str, Any]]:
    columns = (
        "node_id", "latest_active", "latest_flagged", "newest_observed", "version_seeded_at",
        "last_reconciled_at", "needs_version_reconcile", "last_active_refresh",
    )
    result = {}
    for row in connection.execute(f"SELECT {', '.join(columns)} FROM installed_node_versions"):
        summary = dict(zip(columns, row))
        if not isinstance(summary["node_id"], str) or not summary["node_id"]:
            raise ValueError("Comfy Registry summary cache contained an invalid node_id.")
        for field in ("version_seeded_at", "last_reconciled_at", "last_active_refresh"):
            value = summary[field]
            if value is not None and (not isinstance(value, (int, float)) or not math.isfinite(value)):
                raise ValueError("Comfy Registry summary cache contained an invalid timestamp.")
        if summary["needs_version_reconcile"] not in (0, 1):
            raise ValueError("Comfy Registry summary cache contained an invalid reconciliation flag.")
        for field in ("latest_active", "latest_flagged", "newest_observed"):
            summary[field] = json.loads(summary[field]) if summary[field] is not None else None
            if summary[field] is not None and not isinstance(summary[field], dict):
                raise ValueError("Comfy Registry summary cache contained an invalid version.")
            if summary[field] is not None:
                _semver_key(summary[field])
                if summary[field].get("status"):
                    _status(summary[field])
                if field != "latest_active":
                    _version_id(summary[field])
                    _created_at(summary[field])
        summary["needs_version_reconcile"] = bool(summary["needs_version_reconcile"])
        result[summary.pop("node_id")] = summary
    return result


def read_registry_cache(db_path: Path) -> dict[str, Any]:
    connection = sqlite3.connect(f"{db_path.resolve().as_uri()}?mode=ro", uri=True)
    try:
        connection.execute("BEGIN")
        state = _state(connection)
        summaries = _summaries(connection)
        nodes = _catalog(connection)
        for node in nodes:
            summary = summaries.get(_node_id(node))
            if summary is not None:
                node["latest_version"] = summary["latest_active"]
        return {
            "nodes": nodes,
            "cache_metadata": state.get("cache_metadata", {}),
            "installed_node_versions": summaries,
            "page": 1,
            "limit": PAGE_SIZE,
            "total": len(nodes),
            "totalPages": 1,
        }
    finally:
        connection.close()


def _url(base: str, params: list[tuple[str, Any]]) -> str:
    return f"{base}?{urlencode(params)}"


async def _version_page(session: Any, *, fetch_json: Callable, versions_url: str, page: int, node_id: str | None = None) -> dict:
    params = [("page", page), ("pageSize", PAGE_SIZE)]
    if node_id is not None:
        params.append(("nodeId", node_id))
    data = await fetch_json(session, _url(versions_url, params))
    if not isinstance(data, dict) or not isinstance(data.get("versions"), list):
        raise ValueError("Comfy Registry versions response did not include a versions list.")
    total_pages = data.get("totalPages")
    response_page = data.get("page", page)
    if type(total_pages) is not int or total_pages < 0 or type(response_page) is not int or response_page != page:
        raise ValueError("Comfy Registry versions response had invalid pagination.")
    if "pageSize" in data and (type(data["pageSize"]) is not int or data["pageSize"] != PAGE_SIZE):
        raise ValueError("Comfy Registry versions response had an unexpected pageSize.")
    versions = data["versions"]
    if len(versions) > PAGE_SIZE or (page < total_pages and len(versions) < PAGE_SIZE) or (total_pages == 0 and versions):
        raise ValueError("Comfy Registry versions response included a partial page.")
    for version in versions:
        if not isinstance(version, dict) or not isinstance(version.get("node_id"), str) or not version["node_id"]:
            raise ValueError("Comfy Registry version did not include a node_id.")
        _version_id(version)
        _created_at(version)
        _status(version)
        if not isinstance(version.get("version"), str) or not version["version"]:
            raise ValueError("Comfy Registry version did not include a version.")
        if node_id is not None and version["node_id"] != node_id:
            raise ValueError("Comfy Registry returned versions for a different node.")
    if not versions and total_pages > 0:
        total = data.get("total")
        if total != 0 or page != 1:
            raise ValueError("Comfy Registry versions response was unexpectedly empty.")
    return data


async def _node_versions(session: Any, *, fetch_json: Callable, versions_url: str, node_id: str) -> list[dict[str, Any]]:
    versions = {}
    page = 1
    while True:
        data = await _version_page(session, fetch_json=fetch_json, versions_url=versions_url, page=page, node_id=node_id)
        for version in data["versions"]:
            versions[_version_id(version)] = version
        if page >= data["totalPages"]:
            return list(versions.values())
        page += 1


def _save_summary(connection: sqlite3.Connection, node_id: str, versions: list[dict], now: float, *, seeded: bool) -> None:
    latest_active = _latest([version for version in versions if _status(version) == "active"])
    latest_flagged = _latest([version for version in versions if _status(version) == "flagged"])
    newest = _latest(versions)
    if seeded:
        connection.execute(
            "INSERT INTO installed_node_versions (node_id, latest_active, latest_flagged, newest_observed, "
            "version_seeded_at, last_reconciled_at, needs_version_reconcile) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (node_id, _json(latest_active) if latest_active else None, _json(latest_flagged) if latest_flagged else None,
             _json(newest) if newest else None, now, now, int(_needs_reconcile(newest, latest_active))),
        )
    else:
        active_payload = connection.execute("SELECT latest_active FROM installed_node_versions WHERE node_id=?", (node_id,)).fetchone()[0]
        compatible_active = json.loads(active_payload) if active_payload is not None else None
        connection.execute(
            "UPDATE installed_node_versions SET latest_flagged=?, newest_observed=?, last_reconciled_at=?, "
            "needs_version_reconcile=? WHERE node_id=?",
            (_json(latest_flagged) if latest_flagged else None, _json(newest) if newest else None,
             now, int(_needs_reconcile(newest, compatible_active)), node_id),
        )


async def seed_installed_nodes(
    connection: sqlite3.Connection, session: Any, *, node_ids: set[str], fetch_json: Callable,
    versions_url: str, now: float,
) -> set[str]:
    summaries = _summaries(connection)
    seeded = set()
    for node_id in sorted(node_ids):
        if node_id in summaries and summaries[node_id]["version_seeded_at"] is not None:
            continue
        versions = await _node_versions(session, fetch_json=fetch_json, versions_url=versions_url, node_id=node_id)
        _save_summary(connection, node_id, versions, now, seeded=node_id not in summaries)
        if node_id in summaries:
            connection.execute("UPDATE installed_node_versions SET version_seeded_at=? WHERE node_id=?", (now, node_id))
        seeded.add(node_id)
    return seeded


async def reconcile_installed_nodes(
    connection: sqlite3.Connection, session: Any, *, fetch_json: Callable, versions_url: str,
    now: float, exclude_node_ids: set[str] | None = None,
) -> None:
    for node_id, summary in _summaries(connection).items():
        if not summary["needs_version_reconcile"] or node_id in (exclude_node_ids or set()):
            continue
        versions = await _node_versions(session, fetch_json=fetch_json, versions_url=versions_url, node_id=node_id)
        _save_summary(connection, node_id, versions, now, seeded=False)


async def _refresh_latest_active(
    connection: sqlite3.Connection, session: Any, *, fetch_json: Callable, nodes_url: str,
    metadata: dict[str, Any], now: float, force: bool = False,
) -> None:
    summaries = _summaries(connection)
    node_ids = sorted(node_id for node_id, summary in summaries.items()
                      if force or summary["last_active_refresh"] is None or now - summary["last_active_refresh"] >= SYNC_INTERVAL_SECONDS)
    for offset in range(0, len(node_ids), PAGE_SIZE):
        batch = node_ids[offset:offset + PAGE_SIZE]
        params = [("limit", PAGE_SIZE), ("page", 1), ("latest", "true")]
        for key in ("form_factor", "comfyui_version"):
            if metadata.get(key):
                params.append((key, metadata[key]))
        params.extend(("node_id", node_id) for node_id in batch)
        data = await fetch_json(session, _url(nodes_url, params))
        if not isinstance(data, dict) or not isinstance(data.get("nodes"), list):
            raise ValueError("Comfy Registry active nodes response did not include a nodes list.")
        if data.get("totalPages", 1) not in (0, 1):
            raise ValueError("Comfy Registry active nodes response was incomplete.")
        if "total" in data and (type(data["total"]) is not int or data["total"] != len(data["nodes"])):
            raise ValueError("Comfy Registry active nodes response included a partial batch.")
        nodes = {}
        for node in data["nodes"]:
            if not isinstance(node, dict) or _node_id(node) not in batch:
                raise ValueError("Comfy Registry active nodes response included an unexpected node.")
            nodes[_node_id(node)] = node
        for node_id in batch:
            active = nodes.get(node_id, {}).get("latest_version")
            if active is not None and not isinstance(active, dict):
                raise ValueError("Comfy Registry active version was not an object.")
            if not active or not active.get("version"):
                active = None
            if active is not None:
                _semver_key(active)
                if active.get("status") and _status(active) != "active":
                    raise ValueError("Comfy Registry latest_version was not Active.")
            summary = summaries[node_id]
            changed = not _same_version(active, summary["latest_active"])
            dirty = summary["needs_version_reconcile"] or changed or _needs_reconcile(summary["newest_observed"], active)
            connection.execute(
                "UPDATE installed_node_versions SET latest_active=?, last_active_refresh=?, needs_version_reconcile=? WHERE node_id=?",
                (_json(active) if active else None, now, int(dirty), node_id),
            )


def _apply_activity(connection: sqlite3.Connection, versions: list[dict], previous_seen: set[str]) -> set[str]:
    summaries = _summaries(connection)
    touched = set()
    for version in versions:
        node_id = version["node_id"]
        if node_id not in summaries or _version_id(version) in previous_seen:
            continue
        summary = summaries[node_id]
        newest = _latest([candidate for candidate in (summary["newest_observed"], version) if candidate is not None])
        dirty = summary["needs_version_reconcile"] or _status(version) != "active" or _needs_reconcile(newest, summary["latest_active"])
        connection.execute(
            "UPDATE installed_node_versions SET newest_observed=?, needs_version_reconcile=? WHERE node_id=?",
            (_json(newest), int(dirty), node_id),
        )
        summary["newest_observed"] = newest
        summary["needs_version_reconcile"] = dirty
        touched.add(node_id)
    return touched


async def _sync_activity(connection: sqlite3.Connection, session: Any, *, fetch_json: Callable, versions_url: str) -> set[str]:
    state = _state(connection)
    anchor_id = state.get("versions_anchor_id")
    anchor_time = parse_iso_datetime(state.get("versions_anchor_created_at"))
    old_seen = state.get("recent_seen_version_ids", [])
    seen = set()
    observed = []
    last_created_at = None
    head = None
    boundary_page = None
    page = 1
    while True:
        data = await _version_page(session, fetch_json=fetch_json, versions_url=versions_url, page=page)
        versions = data["versions"]
        if page == 1 and versions:
            head = versions[0]
        page_times = [_created_at(version) for version in versions]
        if any(left < right for left, right in zip(page_times, page_times[1:])):
            raise ValueError("Comfy Registry global versions were not ordered by descending createdAt.")
        for version in versions:
            version_id = _version_id(version)
            created_at = _created_at(version)
            if boundary_page is None and (
                version_id == anchor_id
                or (anchor_time is not None and created_at < anchor_time)
                or (anchor_time is None and version_id in old_seen)
            ):
                boundary_page = page
            if version_id in seen:
                continue
            if last_created_at is not None and created_at > last_created_at:
                raise ValueError("Comfy Registry global versions changed ordering during pagination.")
            last_created_at = created_at
            seen.add(version_id)
            observed.append(version)
        if page >= data["totalPages"] or (boundary_page is not None and page >= boundary_page + 1):
            break
        page += 1
    activity = [version for version in observed if anchor_time is None or _created_at(version) >= anchor_time]
    touched = _apply_activity(connection, activity, set(old_seen))
    recent = list(dict.fromkeys([_version_id(version) for version in observed] + old_seen))[:RECENT_SEEN_LIMIT]
    _set_state(
        connection,
        versions_anchor_id=_version_id(head) if head else anchor_id,
        versions_anchor_created_at=(head.get("createdAt") or head.get("created_at")) if head else state.get("versions_anchor_created_at"),
        recent_seen_version_ids=recent,
    )
    return touched


def _installed_ids(connection: sqlite3.Connection, installed: set[str] | Callable) -> set[str]:
    catalog_nodes = _catalog(connection)
    ids = set(installed(catalog_nodes) if callable(installed) else installed)
    if any(not isinstance(node_id, str) or not node_id for node_id in ids):
        raise ValueError("Installed Comfy Registry node IDs must be nonempty strings.")
    # /nodes filters are case-sensitive; keep the catalog's Registry spelling.
    catalog_ids = {_node_id(node).lower(): _node_id(node) for node in catalog_nodes}
    ids = {catalog_ids.get(node_id.lower(), node_id) for node_id in ids}
    for (node_id,) in connection.execute("SELECT node_id FROM installed_node_versions").fetchall():
        if node_id not in ids:
            connection.execute("DELETE FROM installed_node_versions WHERE node_id=?", (node_id,))
    return ids


def _sync_metadata(connection: sqlite3.Connection, metadata: dict, now: float, *, full: bool = False) -> None:
    state = _state(connection)
    previous = state.get("cache_metadata", {})
    cache_metadata = {
        **metadata,
        "created_at": previous.get("created_at", format_iso_timestamp(now)),
        "updated_at": format_iso_timestamp(now),
    }
    values = {"cache_metadata": cache_metadata, "schema_version": SCHEMA_VERSION,
              "comfyui_version": metadata.get("comfyui_version"), "form_factor": metadata.get("form_factor")}
    if full:
        values["last_full_sync_time"] = now
    _set_state(connection, **values)


async def initial_sync(
    connection: sqlite3.Connection, session: Any, *, metadata: dict, installed_node_ids: set[str] | Callable,
    fetch_json: Callable, fetch_nodes: Callable, nodes_url: str, now: float, on_line: Callable | None = None,
) -> None:
    on_line and on_line("Building Comfy Registry SQLite cache")
    data = await fetch_nodes(session, timestamp=None, metadata=metadata, on_line=on_line)
    _save_nodes(connection, data)
    versions_url = nodes_url.rsplit("/", 1)[0] + "/versions"
    head_page = await _version_page(session, fetch_json=fetch_json, versions_url=versions_url, page=1)
    head = head_page["versions"][0] if head_page["versions"] else None
    _set_state(connection, versions_anchor_id=_version_id(head) if head else None,
               versions_anchor_created_at=(head.get("createdAt") or head.get("created_at")) if head else None,
               recent_seen_version_ids=[_version_id(version) for version in head_page["versions"]])
    ids = _installed_ids(connection, installed_node_ids)
    seeded = await seed_installed_nodes(connection, session, node_ids=ids, fetch_json=fetch_json, versions_url=versions_url, now=now)
    await _refresh_latest_active(connection, session, fetch_json=fetch_json, nodes_url=nodes_url, metadata=metadata, now=now)
    touched = await _sync_activity(connection, session, fetch_json=fetch_json, versions_url=versions_url)
    await reconcile_installed_nodes(connection, session, fetch_json=fetch_json, versions_url=versions_url,
                                    now=now, exclude_node_ids=seeded - touched)
    _set_state(connection, nodes_incremental_cursor=_catalog_cursor(data, None, now), last_incremental_sync_time=now)
    _sync_metadata(connection, metadata, now, full=True)


async def incremental_sync(
    connection: sqlite3.Connection, session: Any, *, metadata: dict, installed_node_ids: set[str] | Callable,
    fetch_json: Callable, fetch_nodes: Callable, nodes_url: str, now: float, on_line: Callable | None = None,
    full_catalog: bool = False,
) -> bool:
    state = _state(connection)
    due = now - state.get("last_incremental_sync_time", 0) >= SYNC_INTERVAL_SECONDS
    compatibility_changed = any(state.get(key) != metadata.get(key) for key in ("comfyui_version", "form_factor"))
    if due or full_catalog:
        timestamp = None if full_catalog else state.get("nodes_incremental_cursor")
        on_line and on_line("Reconciling Comfy Registry node catalog" if full_catalog else f"Updating Comfy Registry nodes since {timestamp}")
        data = await fetch_nodes(session, timestamp=timestamp, metadata=metadata, on_line=on_line)
        if full_catalog:
            connection.execute("DELETE FROM nodes")
        _save_nodes(connection, data)
    versions_url = nodes_url.rsplit("/", 1)[0] + "/versions"
    ids = _installed_ids(connection, installed_node_ids)
    seeded = await seed_installed_nodes(connection, session, node_ids=ids, fetch_json=fetch_json, versions_url=versions_url, now=now)
    await _refresh_latest_active(connection, session, fetch_json=fetch_json, nodes_url=nodes_url,
                                 metadata=metadata, now=now, force=compatibility_changed)
    if due:
        touched = await _sync_activity(connection, session, fetch_json=fetch_json, versions_url=versions_url)
        await reconcile_installed_nodes(connection, session, fetch_json=fetch_json, versions_url=versions_url,
                                        now=now, exclude_node_ids=seeded - touched)
        _set_state(connection, last_incremental_sync_time=now)
    if due or full_catalog:
        _set_state(connection, nodes_incremental_cursor=_catalog_cursor(data, None if full_catalog else state.get("nodes_incremental_cursor"), now))
    if due or seeded or full_catalog:
        _sync_metadata(connection, metadata, now, full=full_catalog)
    return due or bool(seeded) or full_catalog


def _usable_state(state: dict[str, Any]) -> bool:
    if state.get("schema_version") != SCHEMA_VERSION or not isinstance(state.get("cache_metadata"), dict):
        return False
    for key in ("last_full_sync_time", "last_incremental_sync_time"):
        value = state.get(key)
        if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
            return False
    if parse_iso_datetime(state.get("nodes_incremental_cursor")) is None:
        return False
    recent = state.get("recent_seen_version_ids")
    if not isinstance(recent, list) or any(not isinstance(value, str) or not value for value in recent):
        return False
    anchor = state.get("versions_anchor_id")
    created_at = state.get("versions_anchor_created_at")
    if anchor is not None and (not isinstance(anchor, str) or not anchor):
        return False
    if created_at is not None and parse_iso_datetime(created_at) is None:
        return False
    if anchor is None and created_at is None:
        return bool(recent) or ("versions_anchor_id" in state and "versions_anchor_created_at" in state)
    # A lost id is recoverable from its timestamp; a lost timestamp from recent ids.
    return created_at is not None or bool(recent)


async def sync_registry_cache(
    session: Any, *, db_path: Path, metadata: dict, installed_node_ids: set[str] | Callable,
    fetch_json: Callable, fetch_nodes: Callable, nodes_url: str, now: float,
    force_rebuild: bool = False, on_line: Callable | None = None,
) -> dict[str, Any]:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    existed = db_path.exists()
    state = {}
    if existed:
        connection = sqlite3.connect(f"{db_path.resolve().as_uri()}?mode=ro", uri=True)
        try:
            if connection.execute("PRAGMA quick_check").fetchone()[0] == "ok":
                state = _state(connection)
                _catalog(connection)
                _summaries(connection)
        except (sqlite3.DatabaseError, json.JSONDecodeError, TypeError, ValueError):
            state = {}
        finally:
            connection.close()
    rebuild = not existed or not _usable_state(state)
    if rebuild:
        state = {}
    full_catalog = force_rebuild or any(state.get(key) != metadata.get(key) for key in ("comfyui_version", "form_factor"))
    full_catalog = full_catalog or now - state.get("last_full_sync_time", 0) >= FULL_RESET_SECONDS
    timestamp = None if rebuild or full_catalog else state.get("nodes_incremental_cursor")
    target = db_path.with_name(f".{db_path.name}.{uuid.uuid4().hex}.tmp") if rebuild else db_path
    connection = sqlite3.connect(target)
    committed = False
    try:
        if rebuild:
            _create_schema(connection)
        connection.execute("BEGIN IMMEDIATE")
        params = dict(metadata=metadata, installed_node_ids=installed_node_ids, fetch_json=fetch_json,
                      fetch_nodes=fetch_nodes, nodes_url=nodes_url, now=now, on_line=on_line)
        if rebuild:
            await initial_sync(connection, session, **params)
            action = "invalidated" if existed else "updated"
        else:
            changed = await incremental_sync(connection, session, **params, full_catalog=full_catalog)
            action = "updated" if full_catalog else "incremental" if changed else "fresh"
        connection.commit()
        committed = True
    except BaseException:
        connection.rollback()
        raise
    finally:
        connection.close()
        if rebuild and target.exists() and not committed:
            target.unlink()
    if rebuild:
        try:
            os.replace(target, db_path)
        finally:
            if target.exists():
                target.unlink()
    cache = read_registry_cache(db_path)
    return {
        "file": DB_FILENAME,
        "action": action,
        "source_url": nodes_url,
        "source_path": str(db_path),
        "timestamp": timestamp,
        "cache_metadata": cache["cache_metadata"],
        "total": len(cache["nodes"]),
        "sha256": hashlib.sha256(db_path.read_bytes()).hexdigest(),
    }
