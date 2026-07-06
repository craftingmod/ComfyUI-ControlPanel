from __future__ import annotations

import hashlib
import json
import os
import uuid
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlencode, urlparse


def manager_cache_filename(channel_url: str, filename: str, hash_func: Callable[[str], str]) -> str:
    cache_key_url = f"{channel_url.rstrip('/')}/{filename}"
    return f"{hash_func(cache_key_url)}_{filename}"


def manager_url_cache_filename(url: str, hash_func: Callable[[str], str]) -> str:
    parsed = urlparse(url)
    filename = Path(parsed.path.rstrip("/")).name or "cache"
    if not Path(filename).suffix:
        filename = f"{filename}.json"
    return f"{hash_func(url)}_{filename}"


def is_cache_file_fresh(path: Path, max_age_seconds: int, now: Callable[[], float]) -> bool:
    if not path.exists():
        return False
    return now() - path.stat().st_mtime < max_age_seconds


def write_json_atomic(path: Path, data: Any) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True)
    digest = hashlib.sha256(payload.encode("utf-8")).hexdigest()
    temp_path = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    temp_path.write_text(payload, encoding="utf-8")
    os.replace(temp_path, path)
    return digest


def registry_nodes_request_params(
    *,
    page_limit: int,
    form_factor: str,
    comfyui_version: str | None,
    timestamp: str | None = None,
) -> dict[str, str | int | bool]:
    params: dict[str, str | int | bool] = {
        "limit": page_limit,
        "form_factor": form_factor,
        # Keep supported_os out of the request so nodes with missing OS metadata stay in the cache.
        # "supported_os": "...",
        # "latest": True,
    }
    if comfyui_version:
        params["comfyui_version"] = comfyui_version
    if timestamp:
        params["timestamp"] = timestamp
    return params


async def fetch_json(session: Any, url: str, api_error_type: type[Exception]) -> Any:
    async with session.get(url) as response:
        text = await response.text()
        if response.status >= 400:
            raise api_error_type(f"Failed to fetch {url}: HTTP {response.status}: {text[:500]}")
        try:
            return json.loads(text)
        except json.JSONDecodeError as error:
            raise api_error_type(f"Fetched data was not valid JSON: {url}") from error


async def fetch_registry_nodes_pages(
    session: Any,
    *,
    page_limit: int,
    registry_nodes_url: Callable[[dict[str, str | int | bool]], str],
    fetch_json_func: Callable[[Any, str], Any],
    api_error_type: type[Exception],
    timestamp: str | None = None,
    request_metadata: dict[str, str | None] | None = None,
    current_metadata: Callable[[], dict[str, str | None]],
    current_form_factor: Callable[[], str],
    on_line: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    nodes: list[dict[str, Any]] = []
    page = 1
    total_pages = 1
    metadata = request_metadata or current_metadata()
    base_params = registry_nodes_request_params(
        page_limit=page_limit,
        form_factor=metadata["form_factor"] or current_form_factor(),
        comfyui_version=metadata["comfyui_version"],
        timestamp=timestamp,
    )

    while page <= total_pages:
        params = {**base_params, "page": page}
        url = registry_nodes_url(params)
        data = await fetch_json_func(session, url)
        if not isinstance(data, dict):
            raise api_error_type("Comfy Registry nodes response was not an object.")

        page_nodes = data.get("nodes")
        if not isinstance(page_nodes, list):
            raise api_error_type("Comfy Registry nodes response did not include a nodes list.")
        nodes.extend(node for node in page_nodes if isinstance(node, dict))

        total_pages_value = data.get("totalPages", 1)
        total_pages = total_pages_value if isinstance(total_pages_value, int) and total_pages_value > 0 else 1
        if on_line and (page % 10 == 0 or page >= total_pages):
            on_line(f"Updating ComfyRegistry nodes ({page}/{total_pages})")
        page += 1

    return {
        "limit": page_limit,
        "nodes": nodes,
        "page": 1,
        "total": len(nodes),
        "totalPages": total_pages,
    }


def registry_cache_metadata_matches(
    cache_data: dict[str, Any],
    metadata: dict[str, str | None],
    metadata_key: str,
    invalidation_keys: tuple[str, ...],
) -> bool:
    cached_metadata = cache_data.get(metadata_key)
    if not isinstance(cached_metadata, dict):
        return False
    return all(cached_metadata.get(key) == metadata.get(key) for key in invalidation_keys)


async def refresh_comfy_registry_nodes_cache(
    *,
    session: Any,
    source_dir: Path,
    filename: str,
    source_url: str,
    metadata_key: str,
    current_metadata: Callable[[str | None], dict[str, str | None]],
    metadata_matches: Callable[[dict[str, Any], dict[str, str | None]], bool],
    incremental_timestamp: Callable[[dict[str, Any]], str | None],
    fetch_pages: Callable[..., Any],
    merge_cache: Callable[[dict[str, Any], dict[str, Any]], dict[str, Any]],
    with_metadata: Callable[[dict[str, Any], dict[str, str | None], dict[str, Any] | None], dict[str, Any]],
    write_json: Callable[[Path, Any], str],
    channel: str | None = None,
    on_line: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    cache_path = source_dir / filename
    cache_data: dict[str, Any] | None = None
    timestamp: str | None = None
    metadata = current_metadata(channel) if channel is not None else current_metadata(None)
    previous_metadata: dict[str, Any] | None = None
    action = "updated"

    if cache_path.exists():
        try:
            loaded = json.loads(cache_path.read_text(encoding="utf-8"))
            cache_data = loaded if isinstance(loaded, dict) else None
        except json.JSONDecodeError:
            cache_data = None
        if cache_data is not None and isinstance(cache_data.get(metadata_key), dict):
            previous_metadata = cache_data[metadata_key]
        if cache_data is not None and metadata_matches(cache_data, metadata):
            timestamp = incremental_timestamp(cache_data)
            if timestamp:
                action = "incremental"
        elif cache_data is not None:
            cache_data = None
            previous_metadata = None
            action = "invalidated"

    if timestamp:
        on_line and on_line(f"Updating Comfy Registry nodes since {timestamp}")
    else:
        on_line and on_line("Building Comfy Registry nodes cache")

    fetched_data = await fetch_pages(session, timestamp=timestamp, metadata=metadata, on_line=on_line)
    data = merge_cache(cache_data, fetched_data) if cache_data is not None else fetched_data
    data = with_metadata(data, metadata, previous_metadata)
    digest = write_json(cache_path, data)
    return {
        "file": filename,
        "action": action,
        "source_url": source_url,
        "source_path": str(cache_path),
        "timestamp": timestamp,
        "cache_metadata": data[metadata_key],
        "total": len(data.get("nodes", [])) if isinstance(data.get("nodes"), list) else 0,
        "sha256": digest,
    }


def locked_refresh_skipped_response(
    *,
    channel: str,
    user_dir: Path,
    manager_dir: Path,
    on_line: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    message = "Manager cache refresh is already running."
    on_line and on_line(message)
    return {
        "provider": channel,
        "restart_required": False,
        "skipped": message,
        "user_dir": str(user_dir),
        "manager_dir": str(manager_dir),
    }


def missing_manager_dir_response(
    *,
    channel: str,
    manager_dir: Path,
    on_line: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    on_line and on_line(f"ComfyUI Manager user directory was not found: {manager_dir}")
    return {
        "provider": channel,
        "skipped": "ComfyUI Manager user directory was not found.",
        "manager_dir": str(manager_dir),
    }


async def refresh_repository_cache_files(
    *,
    filenames: tuple[str, ...],
    source_dir: Path,
    manager_cache_dir: Path,
    repository_data_url: str,
    channel_url: str,
    max_age_seconds: int,
    cache_filename: Callable[[str, str], str],
    is_fresh: Callable[[Path, int], bool],
    write_json: Callable[[Path, Any], str],
    fetch_json_func: Callable[[Any, str], Any],
    client_session_factory: Callable[[], Any],
    sha256_bytes: Callable[[bytes], str],
    on_line: Callable[[str], None] | None = None,
) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for filename in filenames:
        source_path = source_dir / filename
        manager_path = manager_cache_dir / cache_filename(channel_url, filename)
        source_url = f"{repository_data_url}/{filename}"
        cache_key_url = f"{channel_url.rstrip('/')}/{filename}"

        if is_fresh(source_path, max_age_seconds):
            on_line and on_line(f"Manager cache fresh: {filename}")
            if not manager_path.exists():
                data = json.loads(source_path.read_text(encoding="utf-8"))
                digest = write_json(manager_path, data)
                action = "deployed"
            else:
                digest = sha256_bytes(source_path.read_bytes())
                action = "fresh"
            results.append(
                {
                    "file": filename,
                    "action": action,
                    "source_path": str(source_path),
                    "manager_cache_path": str(manager_path),
                    "sha256": digest,
                }
            )
            continue

        on_line and on_line(f"Fetching Manager cache: {filename}")
        async with client_session_factory() as session:
            data = await fetch_json_func(session, source_url)
        digest = write_json(source_path, data)
        write_json(manager_path, data)
        results.append(
            {
                "file": filename,
                "action": "updated",
                "source_url": source_url,
                "cache_key_url": cache_key_url,
                "source_path": str(source_path),
                "manager_cache_path": str(manager_path),
                "sha256": digest,
            }
        )
    return results


def with_registry_cache_metadata(
    data: dict[str, Any],
    metadata: dict[str, str | None],
    metadata_key: str,
    timestamp: float,
    previous_metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    now = format_iso_timestamp(timestamp)
    created_at = previous_metadata.get("created_at") if isinstance(previous_metadata, dict) else None
    result = dict(data)
    result[metadata_key] = {
        **metadata,
        "created_at": created_at if isinstance(created_at, str) and created_at else now,
        "updated_at": now,
    }
    return result


def registry_nodes_url(base_url: str, params: dict[str, str | int | bool]) -> str:
    encoded_params = {key: str(value).lower() if isinstance(value, bool) else value for key, value in params.items()}
    return f"{base_url}?{urlencode(encoded_params)}"


def parse_iso_datetime(value: Any) -> float | None:
    if not isinstance(value, str) or not value:
        return None
    normalized = value.replace("Z", "+00:00")
    try:
        return datetime_fromisoformat(normalized)
    except ValueError:
        return None


def datetime_fromisoformat(value: str) -> float:
    from datetime import datetime

    return datetime.fromisoformat(value).timestamp()


def format_iso_timestamp(timestamp: float) -> str:
    from datetime import UTC, datetime

    return datetime.fromtimestamp(timestamp, tz=UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def node_updated_timestamp(node: dict[str, Any]) -> float | None:
    candidates = (
        node.get("updated_at"),
        node.get("updatedAt"),
        node.get("updated"),
        node.get("created_at"),
        node.get("createdAt"),
    )
    latest_version = node.get("latest_version")
    if isinstance(latest_version, dict):
        candidates += (
            latest_version.get("updated_at"),
            latest_version.get("updatedAt"),
            latest_version.get("createdAt"),
            latest_version.get("created_at"),
        )

    parsed = [parse_iso_datetime(value) for value in candidates]
    timestamps = [value for value in parsed if value is not None]
    return max(timestamps) if timestamps else None


def registry_nodes_incremental_timestamp(cache_data: dict[str, Any]) -> str | None:
    nodes = cache_data.get("nodes")
    if not isinstance(nodes, list):
        return None

    timestamps = [node_updated_timestamp(node) for node in nodes if isinstance(node, dict)]
    latest_timestamp = max((value for value in timestamps if value is not None), default=None)
    if latest_timestamp is None:
        return None
    return format_iso_timestamp(latest_timestamp - 10)


def merge_registry_nodes_cache(cache_data: dict[str, Any], update_data: dict[str, Any], page_limit: int) -> dict[str, Any]:
    cached_nodes = cache_data.get("nodes")
    update_nodes = update_data.get("nodes")
    if not isinstance(cached_nodes, list) or not isinstance(update_nodes, list):
        return update_data

    merged: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    for node in cached_nodes + update_nodes:
        if not isinstance(node, dict):
            continue
        key = str(node.get("id") or node.get("node_id") or node.get("name") or "")
        if not key:
            continue
        if key not in merged:
            order.append(key)
        merged[key] = node

    nodes = [merged[key] for key in order]
    result = dict(update_data)
    result["nodes"] = nodes
    result["page"] = 1
    result["limit"] = page_limit
    result["total"] = len(nodes)
    result["totalPages"] = 1
    return result


def manager_compatible_registry_nodes_cache(data: dict[str, Any]) -> dict[str, Any]:
    nodes = data.get("nodes")
    if not isinstance(nodes, list):
        return data

    compatible_nodes = []
    for node in nodes:
        if not isinstance(node, dict):
            continue
        latest_version = node.get("latest_version")
        if not isinstance(latest_version, dict) or not latest_version.get("version"):
            continue
        compatible_nodes.append(node)

    result = dict(data)
    result["nodes"] = compatible_nodes
    result["total"] = len(compatible_nodes)
    result["page"] = 1
    result["totalPages"] = 1
    return result


def deploy_registry_nodes_cache_to_manager(
    *,
    source_path: Path,
    manager_path: Path,
    filename: str,
    source_url: str,
    compatible_cache: Callable[[dict[str, Any]], dict[str, Any]],
    write_json: Callable[[Path, Any], str],
    on_line: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    if not source_path.exists():
        on_line and on_line(f"Comfy Registry nodes cache source missing: {filename}")
        return {
            "file": filename,
            "action": "missing",
            "source_url": source_url,
            "source_path": str(source_path),
            "manager_cache_path": str(manager_path),
        }

    data = json.loads(source_path.read_text(encoding="utf-8"))
    manager_data = compatible_cache(data) if isinstance(data, dict) else data
    digest = write_json(manager_path, manager_data)
    filtered = 0
    if (
        isinstance(data, dict)
        and isinstance(manager_data, dict)
        and isinstance(data.get("nodes"), list)
        and isinstance(manager_data.get("nodes"), list)
    ):
        filtered = len(data["nodes"]) - len(manager_data["nodes"])
    on_line and on_line("Comfy Registry nodes cache deployed for Manager")
    return {
        "file": filename,
        "action": "deployed",
        "source_url": source_url,
        "source_path": str(source_path),
        "manager_cache_path": str(manager_path),
        "filtered": filtered,
        "sha256": digest,
    }


def deploy_repository_cache_files(
    *,
    source_dir: Path,
    manager_cache_dir: Path,
    channel_url: str,
    filenames: tuple[str, ...],
    cache_filename: Callable[[str, str], str],
    write_json: Callable[[Path, Any], str],
    on_line: Callable[[str], None] | None = None,
) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for filename in filenames:
        source_path = source_dir / filename
        manager_path = manager_cache_dir / cache_filename(channel_url, filename)
        if not source_path.exists():
            on_line and on_line(f"Manager cache source missing: {filename}")
            results.append({"file": filename, "action": "missing", "source_path": str(source_path)})
            continue

        data = json.loads(source_path.read_text(encoding="utf-8"))
        digest = write_json(manager_path, data)
        on_line and on_line(f"Manager repository data deployed: {filename}")
        results.append(
            {
                "file": filename,
                "action": "deployed",
                "source_path": str(source_path),
                "manager_cache_path": str(manager_path),
                "sha256": digest,
            }
        )
    return results
