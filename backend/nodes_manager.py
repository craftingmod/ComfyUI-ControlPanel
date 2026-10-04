from __future__ import annotations

import json
import re
import sqlite3
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

from aiohttp import ClientSession, ClientTimeout

from . import registry_cache

REGISTRY_VERSIONS_URL = "https://api.comfy.org/versions"
REGISTRY_NODES_URL = "https://api.comfy.org/nodes"
LEGACY_CATALOG_FILENAME = "registry-node-list.json"
VERSION_PAGE_SIZE = 5
MAX_VERSION_RESPONSE_BYTES = 2 * 1024 * 1024
NODE_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$")


class CatalogUnavailableError(RuntimeError):
  pass


class RegistryVersionsError(RuntimeError):
  pass


def discover_local_folders(roots: list[Path]) -> list[dict[str, Any]]:
  packs = []
  seen: set[str] = set()
  for root in roots:
    for directory, enabled in ((root, True), (root / ".disabled", False)):
      try:
        children = sorted(directory.iterdir(), key=lambda child: child.name.lower())
      except OSError:
        continue
      for child in children:
        if (
          child.name.startswith(".")
          or child.name == "__pycache__"
          or not child.is_dir()
          or (child / ".git").exists()
          or (child / ".tracking").is_file()
        ):
          continue
        path = str(child.resolve())
        if path in seen:
          continue
        seen.add(path)
        packs.append(
          {"key": path, "name": child.name, "enabled": enabled, "local": True}
        )
  return packs


def resolve_local_folder(roots: list[Path], node_id: Any) -> Path | None:
  if (
    not isinstance(node_id, str)
    or not node_id
    or node_id.startswith(".")
    or node_id.endswith((".", " "))
    or node_id == "__pycache__"
    or any(char in '<>:"/\\|?*' or ord(char) < 32 for char in node_id)
  ):
    return None
  matches: set[Path] = set()
  for root in roots:
    try:
      resolved_root = root.resolve(strict=True)
      for directory in (root, root / ".disabled"):
        candidate = directory / node_id
        if not candidate.is_dir():
          continue
        target = candidate.resolve(strict=True)
        if (
          target.parent == directory.resolve()
          and target.is_relative_to(resolved_root)
          and not (candidate / ".git").exists()
          and not (candidate / ".tracking").is_file()
        ):
          matches.add(target)
    except (OSError, RuntimeError):
      continue
  return next(iter(matches)) if len(matches) == 1 else None


def _catalog_payload(data: Any, source: str) -> dict[str, Any]:
  raw_nodes = data.get("nodes") if isinstance(data, dict) else None
  if isinstance(raw_nodes, dict):
    nodes = [
      {**node, "id": node.get("id") or node.get("node_id") or node_id}
      for node_id, node in raw_nodes.items()
      if isinstance(node_id, str) and isinstance(node, dict)
    ]
  elif isinstance(raw_nodes, list):
    nodes = raw_nodes
  else:
    raise TypeError("Registry catalog did not contain a nodes list or map.")
  for node in nodes:
    if (
      not isinstance(node, dict)
      or not isinstance(node.get("id") or node.get("node_id"), str)
      or not (node.get("id") or node.get("node_id"))
    ):
      raise ValueError("Registry catalog contained an invalid node entry.")
  metadata = data.get("cache_metadata")
  summaries = data.get("installed_node_versions")
  if isinstance(summaries, dict):
    nodes = [
      {**node, "latest_flagged_version": summary.get("latest_flagged")}
      if isinstance(
        summary := summaries.get(node.get("id") or node.get("node_id")), dict
      )
      else node
      for node in nodes
    ]
  return {
    "nodes": nodes,
    "total": len(nodes),
    "source": source,
    "cache_metadata": metadata if isinstance(metadata, dict) else {},
  }


def read_local_catalog(
  database_path: Path,
  legacy_json_path: Path,
  *,
  allow_flagged: bool = False,
  manager_json_path: Path | None = None,
) -> dict[str, Any]:
  sqlite_error: Exception | None = None
  legacy_error: Exception | None = None
  if database_path.is_file():
    try:
      data = registry_cache.read_registry_cache(
        database_path, allow_flagged=allow_flagged
      )
      return _catalog_payload(data, "sqlite")
    except (
      OSError,
      sqlite3.DatabaseError,
      ValueError,
      TypeError,
      json.JSONDecodeError,
    ) as error:
      sqlite_error = error

  if legacy_json_path.is_file():
    try:
      data = json.loads(legacy_json_path.read_text(encoding="utf-8"))
      result = _catalog_payload(data, "legacy-json")
      if sqlite_error is not None:
        result["warning"] = (
          "The SQLite Registry cache could not be read, so the older cached catalog is in use."
        )
      return result
    except (OSError, json.JSONDecodeError, ValueError, TypeError) as error:
      legacy_error = error

  if manager_json_path is not None and manager_json_path.is_file():
    try:
      data = json.loads(manager_json_path.read_text(encoding="utf-8"))
      result = _catalog_payload(data, "manager-json")
      warnings = [
        "Using Manager's locally cached Registry catalog; its data may be stale."
      ]
      if sqlite_error is not None or legacy_error is not None:
        warnings.append("The ControlPanel Registry cache could not be read.")
      result["warning"] = " ".join(warnings)
      return result
    except (OSError, json.JSONDecodeError, ValueError, TypeError) as error:
      legacy_error = error

  if sqlite_error is not None:
    raise CatalogUnavailableError(
      "The ControlPanel Registry catalog is invalid and no usable Manager catalog is available. Enable Replace Manager Repository Data in ControlPanel settings, then choose Update Manager Cache."
    ) from (legacy_error or sqlite_error)
  if legacy_error is not None:
    raise CatalogUnavailableError(
      "The cached Registry catalog is invalid and no usable Manager catalog is available. Enable Replace Manager Repository Data in ControlPanel settings, then choose Update Manager Cache."
    ) from legacy_error
  raise CatalogUnavailableError(
    "No local Registry catalog is available yet. Enable Replace Manager Repository Data in ControlPanel settings, then choose Update Manager Cache."
  )


def validate_registry_node_id(node_id: str) -> str:
  normalized = node_id.strip()
  if not NODE_ID_PATTERN.fullmatch(normalized):
    raise ValueError(
      "Registry node ID must contain only letters, numbers, dots, underscores, and hyphens."
    )
  return normalized


async def _fetch_json(session: ClientSession, url: str) -> Any:
  async with session.get(url) as response:
    if response.status < 200 or response.status >= 300:
      detail = (await response.content.read(1000)).decode("utf-8", errors="replace")
      raise RegistryVersionsError(
        f"Comfy Registry returned HTTP {response.status}: {detail.strip() or response.reason}"
      )
    if (
      response.content_length is not None
      and response.content_length > MAX_VERSION_RESPONSE_BYTES
    ):
      raise RegistryVersionsError(
        "Comfy Registry version response exceeded the size limit."
      )
    body = bytearray()
    async for chunk in response.content.iter_chunked(64 * 1024):
      body.extend(chunk)
      if len(body) > MAX_VERSION_RESPONSE_BYTES:
        raise RegistryVersionsError(
          "Comfy Registry version response exceeded the size limit."
        )
    try:
      return json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
      raise RegistryVersionsError(
        "Comfy Registry returned invalid JSON for node versions."
      ) from error


def _validate_versions_page(
  data: Any, node_id: str, page: int
) -> tuple[list[dict], int | None]:
  if isinstance(data, list):
    versions = data
    total_pages = None
  elif isinstance(data, dict) and isinstance(data.get("versions"), list):
    versions = data["versions"]
    total_pages = data.get("totalPages")
    response_page = data.get("page", page)
    if type(total_pages) is not int or total_pages < 0 or response_page != page:
      raise RegistryVersionsError(
        "Comfy Registry returned invalid version pagination data."
      )
    if "pageSize" in data and data["pageSize"] != VERSION_PAGE_SIZE:
      raise RegistryVersionsError(
        "Comfy Registry returned an unexpected version page size."
      )
  else:
    raise RegistryVersionsError(
      "Comfy Registry response did not contain a version list."
    )

  if len(versions) > VERSION_PAGE_SIZE:
    raise RegistryVersionsError(
      "Comfy Registry returned more versions than the page limit."
    )
  for version in versions:
    if not isinstance(version, dict) or not isinstance(version.get("version"), str):
      raise RegistryVersionsError("Comfy Registry returned an invalid version entry.")
    version_node_id = version.get("node_id") or version.get("nodeId")
    if version_node_id is not None and version_node_id != node_id:
      raise RegistryVersionsError("Comfy Registry returned versions for another node.")
  return versions, total_pages


async def fetch_registry_versions(
  node_id: str,
  *,
  fetch_json: Callable[[str], Awaitable[Any]] | None = None,
) -> list[dict[str, Any]]:
  normalized_id = validate_registry_node_id(node_id)

  if fetch_json is None:
    timeout = ClientTimeout(total=12)
    async with ClientSession(timeout=timeout) as session:

      async def request(url: str) -> Any:
        return await _fetch_json(session, url)

      return await fetch_registry_versions(normalized_id, fetch_json=request)

  versions: list[dict[str, Any]] = []
  for statuses in (
    ["NodeVersionStatusActive"],
    ["NodeVersionStatusFlagged", "NodeVersionStatusPending"],
  ):
    query = urlencode(
      {
        "nodeId": normalized_id,
        # Scanner histories can exceed the response limit even for one version.
        "include_status_reason": "false",
        "statuses": statuses,
        "page": 1,
        "pageSize": VERSION_PAGE_SIZE,
      },
      doseq=True,
    )
    data = await fetch_json(f"{REGISTRY_VERSIONS_URL}?{query}")
    page_versions, _ = _validate_versions_page(data, normalized_id, 1)
    for version in page_versions:
      if registry_cache._status(version) in {
        status.removeprefix("NodeVersionStatus").lower() for status in statuses
      } and not any(item["version"] == version["version"] for item in versions):
        versions.append(version)
  return sorted(versions, key=registry_cache._semver_key, reverse=True)
