from __future__ import annotations

import asyncio
import contextlib
import configparser
import hashlib
import ipaddress
import json
import logging
import platform
import threading
import time
import uuid
import os
import re
import shutil
import sys
import importlib
from pathlib import Path
from typing import Any, Awaitable, Callable
from aiohttp import ClientSession

from .hash import manager_cache_key_hash
from . import manager_cache
from . import manager_cli
from . import manager_git
from . import manager_http
from . import manager_runtime
from . import manager_routes
from . import manager_settings
from .manager_jobs import JOBS as _JOBS
from .manager_jobs import ManagerJob, latest_job, start_job
from . import manager_process
from .manager_process import ManagerApiError
from .manager_process import run_command, run_command_stream


EXTENSION_ROOT = Path(__file__).resolve().parents[1]


def resolve_comfyui_root() -> Path:
    return manager_runtime.resolve_comfyui_root(EXTENSION_ROOT, os.environ.get("COMFYUI_PATH"))


def resolve_custom_nodes_dir(comfyui_root: Path) -> Path:
    return manager_runtime.resolve_custom_nodes_dir(comfyui_root)


def resolve_comfyui_user_dir() -> Path:
    return manager_runtime.resolve_comfyui_user_dir(COMFYUI_ROOT, sys.argv)


COMFYUI_ROOT = resolve_comfyui_root()
CUSTOM_NODES_DIR = resolve_custom_nodes_dir(COMFYUI_ROOT)
COMFYUI_USER_DIR = resolve_comfyui_user_dir()
API_PREFIX = "/control-panel"
_ROUTES_REGISTERED = False
_OPERATION_LOCK = asyncio.Lock()
_MANAGER_CACHE_REFRESH_LOCK = threading.Lock()
_TORCH_PACKAGES = {"torch", "torchvision", "torchaudio"}
_CLEAR_TERMINAL_CSI = "\033[2J\033[H"
_MANAGER_CACHE_FILES = (
    "custom-node-list.json",
    "extension-node-map.json",
    "model-list.json",
    "alter-list.json",
    "github-stats.json",
)
_DEFAULT_MANAGER_CHANNEL_URL = "https://raw.githubusercontent.com/Comfy-Org/ComfyUI-Manager/main"
_OVERRIDE_MANAGER_CHANNEL_URL = "https://raw.githubusercontent.com/ltdrdata/ComfyUI-Manager/main"
_JSDELIVR_MANAGER_CHANNEL_URL = "https://cdn.jsdelivr.net/gh/Comfy-Org/ComfyUI-Manager@main"
_MANAGER_REPOSITORY_DATA_CHANNEL_GITHUB = "github"
_MANAGER_REPOSITORY_DATA_CHANNEL_JSDELIVR = "jsdelivr"
_DEFAULT_MANAGER_REPOSITORY_DATA_CHANNEL = _MANAGER_REPOSITORY_DATA_CHANNEL_JSDELIVR
_MANAGER_REPOSITORY_DATA_CHANNEL_URLS = {
    _MANAGER_REPOSITORY_DATA_CHANNEL_GITHUB: _DEFAULT_MANAGER_CHANNEL_URL,
    _MANAGER_REPOSITORY_DATA_CHANNEL_JSDELIVR: _JSDELIVR_MANAGER_CHANNEL_URL,
}
_COMFY_REGISTRY_NODES_URL = "https://api.comfy.org/nodes"
_COMFY_REGISTRY_NODES_CACHE_FILENAME = "registry-node-list.json"
_COMFY_REGISTRY_NODES_PAGE_LIMIT = 30
_COMFY_REGISTRY_CACHE_METADATA_KEY = "cache_metadata"
_COMFY_REGISTRY_CACHE_INVALIDATION_KEYS = ("comfyui_version", "form_factor", "channel")
_CACHE_MAX_AGE_SECONDS = 86400
_CONTROLPANEL_CONFIG_FILENAME = "config.json"
_SETTING_MANAGER_REPOSITORY_OVERRIDE = "manager_repository_data_override_enabled"
_SETTING_MANAGER_REPOSITORY_DATA_CHANNEL = "manager_repository_data_channel"
_SETTING_PREVIOUS_MANAGER_NETWORK_MODE = "manager_network_mode_before_override"
_SETTING_MANAGER_CONFIG_WAS_MISSING = "manager_config_was_missing_before_override"
_SETTING_ALLOW_REMOTE_CONTROL = "allow_remote_control"
LOGGER = logging.getLogger(__name__)


def _json_response(data: dict[str, Any], status: int = 200):
    from aiohttp import web

    return web.json_response(data, status=status)


def _error_response(message: str, status: int = 400):
    return _json_response({"ok": False, "error": message}, status=status)


def _command_available(command: str) -> bool:
    return _find_executable(command) is not None


def _find_executable(command: str) -> str | None:
    return manager_process.find_executable(command)


def _command_args(command: str, *args: str) -> list[str]:
    executable = _find_executable(command)
    if executable is None:
        raise ManagerApiError(f"Required command is not available: {command}")
    return [executable, *args]


def _is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def repo_name_from_git_url(url: str) -> str:
    return manager_git.repo_name_from_git_url(url)


def validate_git_url(url: str) -> str:
    return manager_git.validate_git_url(url)


def resolve_custom_node_destination(name: str) -> Path:
    cleaned = re.sub(r"[^A-Za-z0-9_.-]+", "-", name.strip()).strip(".-")
    if not cleaned:
        raise ManagerApiError("Destination folder name is empty.")

    destination = (CUSTOM_NODES_DIR / cleaned).resolve()
    if not _is_relative_to(destination, CUSTOM_NODES_DIR):
        raise ManagerApiError("Destination must stay inside ComfyUI/custom_nodes.")
    return destination


def discover_git_repositories(root: Path = CUSTOM_NODES_DIR) -> list[Path]:
    repos: list[Path] = []
    for child in sorted(root.iterdir(), key=lambda item: item.name.lower()):
        if child.is_dir() and (child / ".git").exists():
            repos.append(child)
    return repos


async def install_git_url(url: str, name: str | None = None) -> dict[str, Any]:
    git_url = validate_git_url(url)
    destination = resolve_custom_node_destination(name or repo_name_from_git_url(git_url))
    if destination.exists():
        raise ManagerApiError(f"Destination already exists: {destination.name}")

    result = await run_command(["git", "clone", git_url, str(destination)], CUSTOM_NODES_DIR)
    return {"destination": str(destination), "result": result}


def controlpanel_manager_cache_dir(user_dir: Path | None = None) -> Path:
    return manager_settings.controlpanel_manager_cache_dir(user_dir or COMFYUI_USER_DIR)


def controlpanel_manager_cache_source_dir(user_dir: Path | None = None, channel: str | None = None) -> Path:
    return manager_settings.controlpanel_manager_cache_source_dir(
        user_dir or COMFYUI_USER_DIR,
        normalize_manager_repository_data_channel(channel),
    )


def controlpanel_config_path(user_dir: Path | None = None) -> Path:
    return manager_settings.controlpanel_config_path(user_dir or COMFYUI_USER_DIR, _CONTROLPANEL_CONFIG_FILENAME)


def manager_user_dir(user_dir: Path | None = None) -> Path:
    return manager_settings.manager_user_dir(user_dir or COMFYUI_USER_DIR)


def manager_snapshot_dir(user_dir: Path | None = None) -> Path:
    return manager_settings.manager_snapshot_dir(user_dir or COMFYUI_USER_DIR)


def read_controlpanel_settings(user_dir: Path | None = None) -> dict[str, Any]:
    return manager_settings.read_controlpanel_settings(controlpanel_config_path(user_dir), LOGGER.warning)


def write_controlpanel_settings(settings: dict[str, Any], user_dir: Path | None = None) -> str:
    return manager_settings.write_controlpanel_settings(controlpanel_config_path(user_dir), settings, write_json_atomic)


def is_manager_repository_override_enabled(user_dir: Path | None = None) -> bool:
    return bool(read_controlpanel_settings(user_dir).get(_SETTING_MANAGER_REPOSITORY_OVERRIDE))


def is_remote_control_allowed(user_dir: Path | None = None) -> bool:
    return bool(read_controlpanel_settings(user_dir).get(_SETTING_ALLOW_REMOTE_CONTROL))


def warn_if_remote_control_enabled(user_dir: Path | None = None) -> dict[str, Any]:
    resolved_user_dir = user_dir or COMFYUI_USER_DIR
    if not is_remote_control_allowed(resolved_user_dir):
        return {"enabled": False}
    LOGGER.warning(
        "[ControlPanel][SECURITY WARNING] allow_remote_control is enabled. "
        "ControlPanel routes can be used from non-local clients. "
        "Do not expose this ComfyUI instance to untrusted networks."
    )
    return {"enabled": True, "user_dir": str(resolved_user_dir)}


def _request_remote_host(request) -> str | None:
    remote = getattr(request, "remote", None)
    if isinstance(remote, str) and remote:
        return remote

    transport = getattr(request, "transport", None)
    if transport is None:
        return None
    peername = transport.get_extra_info("peername")
    if isinstance(peername, tuple) and peername:
        return str(peername[0])
    if isinstance(peername, str) and peername:
        return peername
    return None


def is_loopback_host(host: str | None) -> bool:
    if not host:
        return False
    normalized = host.strip().strip("[]").lower()
    if normalized == "localhost":
        return True
    try:
        return ipaddress.ip_address(normalized).is_loopback
    except ValueError:
        return False


def is_loopback_request(request) -> bool:
    return is_loopback_host(_request_remote_host(request))


def is_control_request_allowed(request) -> bool:
    return is_remote_control_allowed() or is_loopback_request(request)


def control_request_denied_response(request):
    if is_control_request_allowed(request):
        return None
    host = _request_remote_host(request) or "unknown"
    path = getattr(request, "path", None) or getattr(request, "rel_url", "")
    LOGGER.warning("[ControlPanel][SECURITY WARNING] Blocked remote control request from %s: %s", host, path)
    return _error_response(
        "ComfyUI-ControlPanel is available only from localhost by default. "
        "Set allow_remote_control=true in the ControlPanel config only for trusted private deployments.",
        status=403,
    )


def normalize_manager_repository_data_channel(channel: Any) -> str:
    if isinstance(channel, str):
        normalized = channel.strip().lower()
        if normalized in _MANAGER_REPOSITORY_DATA_CHANNEL_URLS:
            return normalized
    return _DEFAULT_MANAGER_REPOSITORY_DATA_CHANNEL


def read_manager_repository_data_channel(user_dir: Path | None = None) -> str:
    settings = read_controlpanel_settings(user_dir)
    return normalize_manager_repository_data_channel(settings.get(_SETTING_MANAGER_REPOSITORY_DATA_CHANNEL))


def set_manager_repository_data_channel(channel: Any, user_dir: Path | None = None) -> dict[str, Any]:
    resolved_user_dir = user_dir or COMFYUI_USER_DIR
    return manager_settings.set_manager_repository_data_channel(
        channel=channel,
        user_dir=resolved_user_dir,
        setting_channel_key=_SETTING_MANAGER_REPOSITORY_DATA_CHANNEL,
        is_override_enabled=is_manager_repository_override_enabled,
        normalize_channel=normalize_manager_repository_data_channel,
        channel_url=manager_repository_data_channel_url,
        read_settings=read_controlpanel_settings,
        write_settings=write_controlpanel_settings,
        deploy_cache=deploy_controlpanel_manager_cache_to_manager,
    )


def manager_repository_data_channel_url(channel: str | None = None) -> str:
    return _MANAGER_REPOSITORY_DATA_CHANNEL_URLS[normalize_manager_repository_data_channel(channel)]


def read_manager_config(manager_dir: Path) -> configparser.ConfigParser:
    return manager_settings.read_manager_config(manager_dir)


def manager_config_path(manager_dir: Path) -> Path:
    return manager_settings.manager_config_path(manager_dir)


def manager_config_backup_path(manager_dir: Path) -> Path:
    return manager_settings.manager_config_backup_path(manager_dir)


def backup_manager_config_once(manager_dir: Path) -> bool:
    return manager_settings.backup_manager_config_once(manager_dir)


def restore_manager_config_backup(manager_dir: Path) -> bool:
    return manager_settings.restore_manager_config_backup(manager_dir)


def write_manager_config(manager_dir: Path, parser: configparser.ConfigParser) -> None:
    manager_settings.write_manager_config(manager_dir, parser)


def read_manager_network_mode(manager_dir: Path) -> str | None:
    return manager_settings.read_manager_network_mode(manager_dir)


def write_manager_network_mode(manager_dir: Path, network_mode: str | None) -> None:
    manager_settings.write_manager_network_mode(manager_dir, network_mode)


def read_manager_config_value(manager_dir: Path, option: str) -> str | None:
    return manager_settings.read_manager_config_value(manager_dir, option)


def write_manager_config_values(manager_dir: Path, values: dict[str, str | None]) -> None:
    manager_settings.write_manager_config_values(manager_dir, values)


def read_manager_channel_url(manager_dir: Path) -> str:
    return manager_settings.read_manager_channel_url(manager_dir, _DEFAULT_MANAGER_CHANNEL_URL)


def manager_cache_filename(channel_url: str, filename: str) -> str:
    return manager_cache.manager_cache_filename(channel_url, filename, manager_cache_key_hash)


def manager_url_cache_filename(url: str) -> str:
    return manager_cache.manager_url_cache_filename(url, manager_cache_key_hash)


def is_cache_file_fresh(path: Path, max_age_seconds: int = _CACHE_MAX_AGE_SECONDS) -> bool:
    return manager_cache.is_cache_file_fresh(path, max_age_seconds, time.time)


def write_json_atomic(path: Path, data: Any) -> str:
    return manager_cache.write_json_atomic(path, data)


def _current_registry_form_factor() -> str:
    return f"git-{platform.system().lower()}"


def _current_comfyui_version() -> str | None:
    candidates = (
        ("comfyui_version", "__version__"),
        ("comfy.version", "__version__"),
    )
    for module_name, attribute in candidates:
        with contextlib.suppress(Exception):
            module = __import__(module_name, fromlist=[attribute])
            value = getattr(module, attribute, None)
            if value:
                return str(value)
    return None


def _current_registry_cache_metadata(channel: str | None = None) -> dict[str, str | None]:
    return {
        "comfyui_version": _current_comfyui_version(),
        "platform": platform.system().lower(),
        "form_factor": _current_registry_form_factor(),
        "channel": normalize_manager_repository_data_channel(channel)
        if channel is not None
        else read_manager_repository_data_channel(),
    }


def _registry_nodes_request_params(
    timestamp: str | None = None,
    metadata: dict[str, str | None] | None = None,
) -> dict[str, str | int | bool]:
    resolved_metadata = metadata or _current_registry_cache_metadata()
    return manager_cache.registry_nodes_request_params(
        page_limit=_COMFY_REGISTRY_NODES_PAGE_LIMIT,
        form_factor=resolved_metadata["form_factor"] or _current_registry_form_factor(),
        comfyui_version=resolved_metadata["comfyui_version"],
        timestamp=timestamp,
    )


def _registry_cache_metadata_matches(cache_data: dict[str, Any], metadata: dict[str, str | None]) -> bool:
    return manager_cache.registry_cache_metadata_matches(
        cache_data,
        metadata,
        _COMFY_REGISTRY_CACHE_METADATA_KEY,
        _COMFY_REGISTRY_CACHE_INVALIDATION_KEYS,
    )


def _with_registry_cache_metadata(
    data: dict[str, Any],
    metadata: dict[str, str | None],
    previous_metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return manager_cache.with_registry_cache_metadata(
        data,
        metadata,
        _COMFY_REGISTRY_CACHE_METADATA_KEY,
        time.time(),
        previous_metadata,
    )


def _registry_nodes_url(params: dict[str, str | int | bool]) -> str:
    return manager_cache.registry_nodes_url(_COMFY_REGISTRY_NODES_URL, params)


def _parse_iso_datetime(value: Any) -> float | None:
    return manager_cache.parse_iso_datetime(value)


def datetime_fromisoformat(value: str) -> float:
    return manager_cache.datetime_fromisoformat(value)


def _format_iso_timestamp(timestamp: float) -> str:
    return manager_cache.format_iso_timestamp(timestamp)


def _node_updated_timestamp(node: dict[str, Any]) -> float | None:
    return manager_cache.node_updated_timestamp(node)


def registry_nodes_incremental_timestamp(cache_data: dict[str, Any]) -> str | None:
    return manager_cache.registry_nodes_incremental_timestamp(cache_data)


def merge_registry_nodes_cache(cache_data: dict[str, Any], update_data: dict[str, Any]) -> dict[str, Any]:
    return manager_cache.merge_registry_nodes_cache(cache_data, update_data, _COMFY_REGISTRY_NODES_PAGE_LIMIT)


def manager_compatible_registry_nodes_cache(data: dict[str, Any]) -> dict[str, Any]:
    return manager_cache.manager_compatible_registry_nodes_cache(data)


def deploy_registry_nodes_cache_to_manager(
    source_dir: Path,
    manager_cache_dir: Path,
    on_line: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    source_path = source_dir / _COMFY_REGISTRY_NODES_CACHE_FILENAME
    manager_path = manager_cache_dir / manager_url_cache_filename(_COMFY_REGISTRY_NODES_URL)
    return manager_cache.deploy_registry_nodes_cache_to_manager(
        source_path=source_path,
        manager_path=manager_path,
        filename=_COMFY_REGISTRY_NODES_CACHE_FILENAME,
        source_url=_COMFY_REGISTRY_NODES_URL,
        compatible_cache=manager_compatible_registry_nodes_cache,
        write_json=write_json_atomic,
        on_line=on_line,
    )


def deploy_controlpanel_manager_cache_to_manager(
    user_dir: Path | None = None,
    on_line: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    resolved_user_dir = user_dir or COMFYUI_USER_DIR
    manager_dir = manager_user_dir(resolved_user_dir)
    if not manager_dir.exists():
        on_line and on_line(f"ComfyUI Manager user directory was not found: {manager_dir}")
        return {
            "skipped": "ComfyUI Manager user directory was not found.",
            "manager_dir": str(manager_dir),
        }

    channel = read_manager_repository_data_channel(resolved_user_dir)
    source_dir = controlpanel_manager_cache_source_dir(resolved_user_dir, channel)
    if not source_dir.exists():
        on_line and on_line(f"ControlPanel Manager cache source directory was not found: {source_dir}")
        return {
            "skipped": "ControlPanel Manager cache source directory was not found.",
            "source_dir": str(source_dir),
            "manager_dir": str(manager_dir),
        }

    channel_url = read_manager_channel_url(manager_dir)
    manager_cache_dir = manager_dir / "cache"
    manager_cache_dir.mkdir(parents=True, exist_ok=True)

    results = manager_cache.deploy_repository_cache_files(
        source_dir=source_dir,
        manager_cache_dir=manager_cache_dir,
        channel_url=channel_url,
        filenames=_MANAGER_CACHE_FILES,
        cache_filename=manager_cache_filename,
        write_json=write_json_atomic,
        on_line=on_line,
    )

    registry_nodes = deploy_registry_nodes_cache_to_manager(source_dir, manager_cache_dir, on_line)

    return {
        "manager_dir": str(manager_dir),
        "source_dir": str(source_dir),
        "manager_cache_dir": str(manager_cache_dir),
        "channel_url": channel_url,
        "repository_data_channel": channel,
        "results": results,
        "registry_nodes": registry_nodes,
    }


def set_manager_repository_override(enabled: bool, user_dir: Path | None = None) -> dict[str, Any]:
    resolved_user_dir = user_dir or COMFYUI_USER_DIR
    return manager_settings.set_manager_repository_override(
        enabled=enabled,
        user_dir=resolved_user_dir,
        setting_override_key=_SETTING_MANAGER_REPOSITORY_OVERRIDE,
        setting_channel_key=_SETTING_MANAGER_REPOSITORY_DATA_CHANNEL,
        setting_previous_network_mode_key=_SETTING_PREVIOUS_MANAGER_NETWORK_MODE,
        setting_config_missing_key=_SETTING_MANAGER_CONFIG_WAS_MISSING,
        normalize_channel=normalize_manager_repository_data_channel,
        channel_url=manager_repository_data_channel_url,
        read_settings=read_controlpanel_settings,
        write_settings=write_controlpanel_settings,
        deploy_cache=deploy_controlpanel_manager_cache_to_manager,
    )


def apply_startup_manager_repository_override(user_dir: Path | None = None) -> dict[str, Any]:
    resolved_user_dir = user_dir or COMFYUI_USER_DIR
    if not is_manager_repository_override_enabled(resolved_user_dir):
        return {"enabled": False, "skipped": "Manager repository data override is disabled."}

    return manager_settings.apply_startup_manager_repository_override(
        user_dir=resolved_user_dir,
        channel=read_manager_repository_data_channel(resolved_user_dir),
        channel_url=manager_repository_data_channel_url,
        deploy_cache=deploy_controlpanel_manager_cache_to_manager,
    )


def schedule_startup_manager_cache_refresh(user_dir: Path | None = None) -> dict[str, Any]:
    resolved_user_dir = user_dir or COMFYUI_USER_DIR
    if not is_manager_repository_override_enabled(resolved_user_dir):
        return {"scheduled": False, "skipped": "Manager repository data override is disabled."}

    def on_line(message: str) -> None:
        LOGGER.info("[ControlPanel] [Startup] %s", message)

    async def refresh() -> None:
        try:
            result = await refresh_manager_cache_from_cdn(on_line, user_dir=resolved_user_dir)
            LOGGER.info("[ControlPanel] [Startup] Updating cache completed: %s", result.get("provider"))
        except Exception as err:
            LOGGER.warning("[ControlPanel] [Startup] Updating cache failed: %s", err, exc_info=True)

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        thread = threading.Thread(
            target=lambda: asyncio.run(refresh()),
            name="ControlPanelManagerCacheRefresh",
            daemon=True,
        )
        thread.start()
        runner = "thread"
    else:
        loop.create_task(refresh())
        runner = "event-loop"

    return {
        "scheduled": True,
        "runner": runner,
        "user_dir": str(resolved_user_dir),
    }


async def fetch_json(session: ClientSession, url: str) -> Any:
    return await manager_cache.fetch_json(session, url, ManagerApiError)


async def fetch_registry_nodes_pages(
    session: ClientSession,
    *,
    timestamp: str | None = None,
    metadata: dict[str, str | None] | None = None,
    on_line: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    return await manager_cache.fetch_registry_nodes_pages(
        session,
        page_limit=_COMFY_REGISTRY_NODES_PAGE_LIMIT,
        registry_nodes_url=_registry_nodes_url,
        fetch_json_func=fetch_json,
        api_error_type=ManagerApiError,
        timestamp=timestamp,
        request_metadata=metadata,
        current_metadata=_current_registry_cache_metadata,
        current_form_factor=_current_registry_form_factor,
        on_line=on_line,
    )


async def refresh_comfy_registry_nodes_cache(
    session: ClientSession,
    source_dir: Path,
    on_line: Callable[[str], None] | None = None,
    channel: str | None = None,
) -> dict[str, Any]:
    def current_metadata_adapter(resolved_channel: str | None = None) -> dict[str, str | None]:
        if resolved_channel is None:
            return _current_registry_cache_metadata()
        return _current_registry_cache_metadata(resolved_channel)

    return await manager_cache.refresh_comfy_registry_nodes_cache(
        session=session,
        source_dir=source_dir,
        filename=_COMFY_REGISTRY_NODES_CACHE_FILENAME,
        source_url=_COMFY_REGISTRY_NODES_URL,
        metadata_key=_COMFY_REGISTRY_CACHE_METADATA_KEY,
        current_metadata=current_metadata_adapter,
        metadata_matches=_registry_cache_metadata_matches,
        incremental_timestamp=registry_nodes_incremental_timestamp,
        fetch_pages=fetch_registry_nodes_pages,
        merge_cache=merge_registry_nodes_cache,
        with_metadata=_with_registry_cache_metadata,
        write_json=write_json_atomic,
        channel=channel,
        on_line=on_line,
    )


async def refresh_manager_cache_from_cdn(
    on_line: Callable[[str], None] | None = None,
    *,
    user_dir: Path | None = None,
    max_age_seconds: int = _CACHE_MAX_AGE_SECONDS,
) -> dict[str, Any]:
    resolved_user_dir = user_dir or COMFYUI_USER_DIR
    channel = read_manager_repository_data_channel(resolved_user_dir)
    if not _MANAGER_CACHE_REFRESH_LOCK.acquire(blocking=False):
        return manager_cache.locked_refresh_skipped_response(
            channel=channel,
            user_dir=resolved_user_dir,
            manager_dir=manager_user_dir(resolved_user_dir),
            on_line=on_line,
        )

    try:
        return await _refresh_manager_cache_from_cdn_unlocked(
            on_line,
            user_dir=resolved_user_dir,
            max_age_seconds=max_age_seconds,
        )
    finally:
        _MANAGER_CACHE_REFRESH_LOCK.release()


async def rebuild_manager_cache_from_cdn(
    on_line: Callable[[str], None] | None = None,
    *,
    user_dir: Path | None = None,
) -> dict[str, Any]:
    resolved_user_dir = user_dir or COMFYUI_USER_DIR
    channel = read_manager_repository_data_channel(resolved_user_dir)
    if not _MANAGER_CACHE_REFRESH_LOCK.acquire(blocking=False):
        return manager_cache.locked_refresh_skipped_response(
            channel=channel,
            user_dir=resolved_user_dir,
            manager_dir=manager_user_dir(resolved_user_dir),
            on_line=on_line,
        )

    source_dir = controlpanel_manager_cache_source_dir(resolved_user_dir, channel)
    try:
        if source_dir.exists():
            on_line and on_line(f"Removing ControlPanel Manager cache source: {source_dir}")
            shutil.rmtree(source_dir)
        on_line and on_line("Rebuilding Manager cache from repository data sources.")
        result = await _refresh_manager_cache_from_cdn_unlocked(
            on_line,
            user_dir=resolved_user_dir,
            max_age_seconds=0,
        )
        result["rebuilt"] = True
        return result
    finally:
        _MANAGER_CACHE_REFRESH_LOCK.release()


async def _refresh_manager_cache_from_cdn_unlocked(
    on_line: Callable[[str], None] | None = None,
    *,
    user_dir: Path | None = None,
    max_age_seconds: int = _CACHE_MAX_AGE_SECONDS,
) -> dict[str, Any]:
    resolved_user_dir = user_dir or COMFYUI_USER_DIR
    manager_dir = manager_user_dir(resolved_user_dir)
    if not manager_dir.exists():
        return manager_cache.missing_manager_dir_response(
            channel=read_manager_repository_data_channel(resolved_user_dir),
            manager_dir=manager_dir,
            on_line=on_line,
        )

    channel = read_manager_repository_data_channel(resolved_user_dir)
    repository_data_url = manager_repository_data_channel_url(channel)
    channel_url = read_manager_channel_url(manager_dir)
    source_dir = controlpanel_manager_cache_source_dir(resolved_user_dir, channel)
    manager_cache_dir = manager_dir / "cache"
    manager_cache_dir.mkdir(parents=True, exist_ok=True)

    results = await manager_cache.refresh_repository_cache_files(
        filenames=_MANAGER_CACHE_FILES,
        source_dir=source_dir,
        manager_cache_dir=manager_cache_dir,
        repository_data_url=repository_data_url,
        channel_url=channel_url,
        max_age_seconds=max_age_seconds,
        cache_filename=manager_cache_filename,
        is_fresh=lambda path, max_age: is_cache_file_fresh(path, max_age_seconds=max_age),
        write_json=write_json_atomic,
        fetch_json_func=fetch_json,
        client_session_factory=ClientSession,
        sha256_bytes=lambda data: hashlib.sha256(data).hexdigest(),
        on_line=on_line,
    )

    async with ClientSession() as session:
        registry_result = await refresh_comfy_registry_nodes_cache(session, source_dir, on_line, channel)
    registry_manager_cache = deploy_registry_nodes_cache_to_manager(source_dir, manager_cache_dir, on_line)

    return {
        "provider": channel,
        "restart_required": False,
        "user_dir": str(resolved_user_dir),
        "manager_dir": str(manager_dir),
        "controlpanel_cache_dir": str(controlpanel_manager_cache_dir(resolved_user_dir)),
        "source_dir": str(source_dir),
        "manager_cache_dir": str(manager_cache_dir),
        "channel_url": channel_url,
        "repository_data_channel": channel,
        "repository_data_url": repository_data_url,
        "max_age_seconds": max_age_seconds,
        "results": results,
        "registry_nodes": registry_result,
        "registry_manager_cache": registry_manager_cache,
    }


def _is_local_changes_pull_failure(message: str) -> bool:
    return manager_git.is_local_changes_pull_failure(message)


async def update_git_repository(repo: Path) -> dict[str, Any]:
    return await manager_git.update_git_repository(repo, command_args=_command_args, run_command=run_command)


async def update_all_git_nodes() -> list[dict[str, Any]]:
    return await manager_git.update_all_git_nodes(
        repositories=discover_git_repositories,
        update_repository=update_git_repository,
    )


def comfy_cli_command(*args: str) -> list[str]:
    return _command_args("comfy", "--workspace", str(COMFYUI_ROOT), *args)


async def update_git_nodes_with_git(on_line: Callable[[str], None] | None = None) -> dict[str, Any]:
    return await manager_git.update_git_nodes_with_git(
        repositories=discover_git_repositories,
        update_repository=update_git_repository,
        on_line=on_line,
    )


async def sync_dependencies_with_comfy_cli(on_line: Callable[[str], None] | None = None) -> dict[str, Any]:
    command = comfy_cli_command("node", "uv-sync")
    result = await run_command_stream(command, COMFYUI_ROOT, timeout=3600, on_line=on_line)
    return manager_cli.sync_dependencies_response(result, _TORCH_PACKAGES)


async def show_environment_with_comfy_cli() -> dict[str, Any]:
    command = comfy_cli_command("--json", "env")
    result = await run_command_stream(command, COMFYUI_ROOT, timeout=120)
    return manager_cli.environment_response(result)


def validate_snapshot_name(name: str) -> str:
    return manager_cli.validate_snapshot_name(name)


def list_manager_snapshots(user_dir: Path | None = None) -> dict[str, Any]:
    return manager_cli.list_manager_snapshots(manager_snapshot_dir(user_dir))


async def save_snapshot_with_comfy_cli(on_line: Callable[[str], None] | None = None) -> dict[str, Any]:
    command = comfy_cli_command("node", "save-snapshot")
    result = await run_command_stream(command, COMFYUI_ROOT, timeout=1800, on_line=on_line)
    return manager_cli.save_snapshot_response(result, list_manager_snapshots())


async def restore_snapshot_with_comfy_cli(
    snapshot_name: str,
    on_line: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    target = validate_snapshot_name(snapshot_name)
    snapshot_path = manager_snapshot_dir() / f"{target}.json"
    if not snapshot_path.exists():
        raise ManagerApiError(f"Snapshot was not found: {target}")

    command = comfy_cli_command("node", "restore-snapshot", target)
    result = await run_command_stream(command, COMFYUI_ROOT, timeout=3600, on_line=on_line)
    return manager_cli.restore_snapshot_response(target, snapshot_path, result)


async def inspect_torch_runtime() -> dict[str, Any]:
    code = (
        "import json\n"
        "try:\n"
        "    import torch\n"
        "    print(json.dumps({'available': True, 'version': torch.__version__, 'cuda': torch.version.cuda}))\n"
        "except Exception as error:\n"
        "    print(json.dumps({'available': False, 'error': str(error)}))\n"
    )
    result = await run_command_stream([sys.executable, "-c", code], COMFYUI_ROOT, timeout=60)
    return {"python": sys.executable, "stdout": result["stdout"]}


async def update_comfyui() -> list[dict[str, Any]]:
    return await manager_git.update_comfyui(
        workspace=COMFYUI_ROOT,
        python_executable=sys.executable,
        command_args=_command_args,
        command_available=_command_available,
        run_command=run_command,
    )


def _latest_version_tag(tag_output: str) -> str:
    return manager_git.latest_version_tag(tag_output)


async def update_comfyui_with_git(on_line: Callable[[str], None] | None = None) -> dict[str, Any]:
    return await manager_git.update_comfyui_with_git(
        workspace=COMFYUI_ROOT,
        python_executable=sys.executable,
        command_args=_command_args,
        command_available=_command_available,
        run_command_stream=run_command_stream,
        inspect_torch_runtime=inspect_torch_runtime,
        on_line=on_line,
    )


async def _read_json(request) -> dict[str, Any]:
    try:
        data = await request.json()
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _same_server_url(request, path: str) -> str:
    return manager_http.same_server_url(request, path)


async def request_manager_no_body_post(url: str, provider: str) -> dict[str, Any]:
    return await manager_http.request_manager_no_body_post(url, provider)


async def request_first_manager_route(request, paths: list[str], provider: str) -> dict[str, Any]:
    errors: list[str] = []
    for path in paths:
        try:
            return await request_manager_no_body_post(_same_server_url(request, path), provider)
        except ManagerApiError as error:
            errors.append(f"{path}: {error}")
    raise ManagerApiError("; ".join(errors))


async def request_manager_update_comfyui(request) -> dict[str, Any]:
    result = await request_first_manager_route(
        request,
        ["/v2/manager/queue/update_comfyui"],
        "manager-rest",
    )
    return {
        **result,
        "message": result["message"] or "ComfyUI update was queued through ComfyUI Manager.",
        "restart_required": True,
        "notes": [
            "ComfyUI Manager performs the update asynchronously in its own queue.",
            "Use the Manager logs or task queue for detailed update progress.",
        ],
    }


def clear_terminal_for_restart() -> None:
    manager_runtime.clear_terminal_for_restart(sys.stdout, _CLEAR_TERMINAL_CSI, LOGGER)


async def restart_comfyui(_request) -> dict[str, Any]:
    return await manager_runtime.restart_comfyui(clear_terminal_for_restart, schedule_restart)


def open_path_in_file_manager(path: Path) -> dict[str, Any]:
    return manager_process.open_path_in_file_manager(path)


async def _with_operation_lock(operation):
    if _OPERATION_LOCK.locked():
        return _error_response("Another manager operation is already running.", status=409)
    async with _OPERATION_LOCK:
        try:
            payload = await operation()
            return _json_response({"ok": True, **payload})
        except ManagerApiError as error:
            return _error_response(str(error), status=400)
        except Exception as error:  # noqa: BLE001 - surface backend failures to the UI.
            return _error_response(str(error), status=500)


def schedule_restart(delay_seconds: float = 1.0) -> None:
    manager_runtime.schedule_restart(restart_current_process, delay_seconds)


def restart_exec_args() -> list[str]:
    return manager_runtime.restart_exec_args(sys.executable, sys.argv)


def restart_current_process() -> None:
    manager_runtime.restart_current_process(sys.executable, sys.argv, os.execv)


def register_routes() -> bool:
    global _ROUTES_REGISTERED
    if _ROUTES_REGISTERED:
        return False

    current_module = importlib.import_module(__name__)
    registered = manager_routes.register_routes(current_module)
    _ROUTES_REGISTERED = registered
    return registered


async def _start_job_response(kind: str, label: str, operation: Callable[[ManagerJob], Awaitable[dict[str, Any]]]):
    try:
        job = await start_job(kind, label, operation)
        return _json_response({"ok": True, "job": job.to_dict()}, status=202)
    except ManagerApiError as error:
        return _error_response(str(error), status=409)


async def _job_update_git_nodes(job: ManagerJob) -> dict[str, Any]:
    return await update_git_nodes_with_git(job.append_log)


async def _job_sync_dependencies(job: ManagerJob) -> dict[str, Any]:
    return await sync_dependencies_with_comfy_cli(job.append_log)


async def _job_save_snapshot(job: ManagerJob) -> dict[str, Any]:
    return await save_snapshot_with_comfy_cli(job.append_log)


async def _job_restore_snapshot(job: ManagerJob, target: str) -> dict[str, Any]:
    job.append_log(f"Restoring snapshot: {target}")
    return await restore_snapshot_with_comfy_cli(target, job.append_log)


async def _job_refresh_manager_cache(job: ManagerJob) -> dict[str, Any]:
    return await refresh_manager_cache_from_cdn(job.append_log)


async def _job_rebuild_manager_cache(job: ManagerJob) -> dict[str, Any]:
    return await rebuild_manager_cache_from_cdn(job.append_log)


async def _job_update_comfyui(job: ManagerJob) -> dict[str, Any]:
    job.append_log("Using built-in ComfyUI updater; ComfyUI Manager update route is disabled.")
    return await update_comfyui_with_git(job.append_log)


async def _operation_update_all() -> dict[str, Any]:
    return {"results": await update_all_git_nodes()}


async def _operation_update_comfyui() -> dict[str, Any]:
    return {"results": await update_comfyui()}


async def _operation_install_git_url(url: str, name: str | None) -> dict[str, Any]:
    return {"install": await install_git_url(url, name)}


async def _operation_open_custom_nodes() -> dict[str, Any]:
    return open_path_in_file_manager(CUSTOM_NODES_DIR)


async def _operation_open_snapshots() -> dict[str, Any]:
    snapshot_dir = manager_snapshot_dir()
    snapshot_dir.mkdir(parents=True, exist_ok=True)
    return open_path_in_file_manager(snapshot_dir)


async def _operation_show_environment() -> dict[str, Any]:
    return await show_environment_with_comfy_cli()
