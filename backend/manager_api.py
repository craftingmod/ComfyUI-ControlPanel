from __future__ import annotations

import asyncio
import contextlib
import configparser
import hashlib
import json
import logging
import platform
import threading
import time
import uuid
from dataclasses import dataclass, field
import os
import re
import shutil
import sys
from pathlib import Path
from typing import Any, Awaitable, Callable
from urllib.parse import urlencode, urlparse, urlunparse
from aiohttp import ClientError, ClientSession

from .hash import manager_cache_key_hash


EXTENSION_ROOT = Path(__file__).resolve().parents[1]


def resolve_comfyui_root() -> Path:
    configured_path = os.environ.get("COMFYUI_PATH")
    if configured_path:
        return Path(configured_path).expanduser().resolve()

    try:
        import folder_paths

        return Path(folder_paths.base_path).resolve()
    except Exception:
        return EXTENSION_ROOT.parent.parent.resolve()


def resolve_custom_nodes_dir(comfyui_root: Path) -> Path:
    return (comfyui_root / "custom_nodes").resolve()


def resolve_comfyui_user_dir() -> Path:
    try:
        import folder_paths

        get_user_directory = getattr(folder_paths, "get_user_directory", None)
        if callable(get_user_directory):
            return Path(get_user_directory()).resolve()

        get_system_user_directory = getattr(folder_paths, "get_system_user_directory", None)
        if callable(get_system_user_directory):
            manager_dir = Path(get_system_user_directory("manager")).resolve()
            return manager_dir.parent
    except Exception:
        pass

    if "--user-directory" in sys.argv:
        index = sys.argv.index("--user-directory")
        if index + 1 < len(sys.argv):
            return Path(sys.argv[index + 1]).expanduser().resolve()

    return (COMFYUI_ROOT / "user").resolve()


COMFYUI_ROOT = resolve_comfyui_root()
CUSTOM_NODES_DIR = resolve_custom_nodes_dir(COMFYUI_ROOT)
COMFYUI_USER_DIR = resolve_comfyui_user_dir()
API_PREFIX = "/control-panel"
_ROUTES_REGISTERED = False
_OPERATION_LOCK = asyncio.Lock()
_MANAGER_CACHE_REFRESH_LOCK = threading.Lock()
_JOB_LOCK = asyncio.Lock()
_JOBS: dict[str, "ManagerJob"] = {}
_LATEST_JOB_ID: str | None = None
_JOB_LIMIT = 10
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
LOGGER = logging.getLogger(__name__)


@dataclass
class ManagerJob:
    id: str
    kind: str
    label: str
    status: str = "queued"
    created_at: float = field(default_factory=time.time)
    started_at: float | None = None
    finished_at: float | None = None
    logs: list[str] = field(default_factory=list)
    result: dict[str, Any] | None = None
    error: str | None = None
    restart_required: bool = False

    def append_log(self, message: str) -> None:
        line = message.rstrip()
        self.logs.append(line)
        if line:
            LOGGER.info("[ControlPanel] %s", line)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "kind": self.kind,
            "label": self.label,
            "status": self.status,
            "created_at": self.created_at,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "logs": self.logs,
            "result": self.result,
            "error": self.error,
            "restart_required": self.restart_required,
        }


class ManagerApiError(ValueError):
    pass


def _json_response(data: dict[str, Any], status: int = 200):
    from aiohttp import web

    return web.json_response(data, status=status)


def _error_response(message: str, status: int = 400):
    return _json_response({"ok": False, "error": message}, status=status)


def _command_available(command: str) -> bool:
    return _find_executable(command) is not None


def _find_executable(command: str) -> str | None:
    return shutil.which(command)


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
    parsed = urlparse(url)
    raw_name = Path(parsed.path.rstrip("/")).name
    if raw_name.endswith(".git"):
        raw_name = raw_name[:-4]

    name = re.sub(r"[^A-Za-z0-9_.-]+", "-", raw_name).strip(".-")
    if not name:
        raise ManagerApiError("Cannot infer a folder name from the Git URL.")
    return name


def validate_git_url(url: str) -> str:
    normalized = url.strip()
    parsed = urlparse(normalized)
    if parsed.scheme in {"https", "http", "ssh", "git"} and parsed.netloc:
        return normalized
    if re.match(r"^git@[^:]+:[A-Za-z0-9_.~/-]+(?:\.git)?$", normalized):
        return normalized
    raise ManagerApiError("Only http(s), ssh, git, and git@host:path URLs are supported.")


def resolve_custom_node_destination(name: str) -> Path:
    cleaned = re.sub(r"[^A-Za-z0-9_.-]+", "-", name.strip()).strip(".-")
    if not cleaned:
        raise ManagerApiError("Destination folder name is empty.")

    destination = (CUSTOM_NODES_DIR / cleaned).resolve()
    if not _is_relative_to(destination, CUSTOM_NODES_DIR):
        raise ManagerApiError("Destination must stay inside ComfyUI/custom_nodes.")
    return destination


async def run_command(args: list[str], cwd: Path, timeout: int = 600) -> dict[str, Any]:
    if not args:
        raise ManagerApiError("No command was provided.")
    if not Path(args[0]).is_file() and not _command_available(args[0]):
        raise ManagerApiError(f"Required command is not available on PATH: {args[0]}")

    process = await asyncio.create_subprocess_exec(
        *args,
        cwd=str(cwd),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout)
    except TimeoutError:
        process.kill()
        await process.communicate()
        raise ManagerApiError(f"Command timed out: {' '.join(args)}") from None

    result = {
        "command": args,
        "cwd": str(cwd),
        "returncode": process.returncode,
        "stdout": stdout.decode("utf-8", errors="replace").strip(),
        "stderr": stderr.decode("utf-8", errors="replace").strip(),
    }
    if process.returncode != 0:
        detail = result["stderr"] or result["stdout"] or f"exit code {process.returncode}"
        raise ManagerApiError(f"Command failed: {' '.join(args)}\n{detail}")
    return result


async def run_command_stream(
    args: list[str],
    cwd: Path,
    timeout: int = 1800,
    on_line: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    if not args:
        raise ManagerApiError("No command was provided.")
    if not Path(args[0]).is_file() and not _command_available(args[0]):
        raise ManagerApiError(f"Required command is not available: {args[0]}")

    started = time.monotonic()
    process = await asyncio.create_subprocess_exec(
        *args,
        cwd=str(cwd),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout_lines: list[str] = []
    stderr_lines: list[str] = []

    async def read_stream(stream, prefix: str, sink: list[str]) -> None:
        if stream is None:
            return
        while True:
            line = await stream.readline()
            if not line:
                break
            decoded = line.decode("utf-8", errors="replace").rstrip()
            sink.append(decoded)
            if on_line:
                on_line(f"{prefix}{decoded}")

    readers = [
        asyncio.create_task(read_stream(process.stdout, "", stdout_lines)),
        asyncio.create_task(read_stream(process.stderr, "stderr: ", stderr_lines)),
    ]
    try:
        try:
            await asyncio.wait_for(process.wait(), timeout=max(0.1, timeout - (time.monotonic() - started)))
        except TimeoutError:
            process.kill()
            await process.wait()
            raise ManagerApiError(f"Command timed out: {' '.join(args)}") from None
        await asyncio.gather(*readers)
    finally:
        for reader in readers:
            if not reader.done():
                reader.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await reader

    result = {
        "command": args,
        "cwd": str(cwd),
        "returncode": process.returncode,
        "stdout": "\n".join(stdout_lines).strip(),
        "stderr": "\n".join(stderr_lines).strip(),
    }
    if process.returncode != 0:
        detail = result["stderr"] or result["stdout"] or f"exit code {process.returncode}"
        raise ManagerApiError(f"Command failed: {' '.join(args)}\n{detail}")
    return result


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
    return (user_dir or COMFYUI_USER_DIR) / "__controlpanel" / "manager-cache"


def controlpanel_manager_cache_source_dir(user_dir: Path | None = None, channel: str | None = None) -> Path:
    return controlpanel_manager_cache_dir(user_dir) / "sources" / normalize_manager_repository_data_channel(channel)


def controlpanel_config_path(user_dir: Path | None = None) -> Path:
    return (user_dir or COMFYUI_USER_DIR) / "__controlpanel" / _CONTROLPANEL_CONFIG_FILENAME


def manager_user_dir(user_dir: Path | None = None) -> Path:
    return (user_dir or COMFYUI_USER_DIR) / "__manager"


def read_controlpanel_settings(user_dir: Path | None = None) -> dict[str, Any]:
    config_path = controlpanel_config_path(user_dir)
    if not config_path.exists():
        return {}

    try:
        data = json.loads(config_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        LOGGER.warning("[ControlPanel] Ignoring invalid internal config: %s", config_path)
        return {}
    return data if isinstance(data, dict) else {}


def write_controlpanel_settings(settings: dict[str, Any], user_dir: Path | None = None) -> str:
    return write_json_atomic(controlpanel_config_path(user_dir), settings)


def is_manager_repository_override_enabled(user_dir: Path | None = None) -> bool:
    return bool(read_controlpanel_settings(user_dir).get(_SETTING_MANAGER_REPOSITORY_OVERRIDE))


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
    normalized = normalize_manager_repository_data_channel(channel)
    settings = read_controlpanel_settings(resolved_user_dir)
    settings[_SETTING_MANAGER_REPOSITORY_DATA_CHANNEL] = normalized
    write_controlpanel_settings(settings, resolved_user_dir)

    deployment: dict[str, Any] = {"skipped": "Manager repository data override is disabled."}
    if is_manager_repository_override_enabled(resolved_user_dir):
        manager_dir = manager_user_dir(resolved_user_dir)
        write_manager_config_values(manager_dir, {"channel_url": manager_repository_data_channel_url(normalized)})
        deployment = deploy_controlpanel_manager_cache_to_manager(resolved_user_dir)

    return {
        "channel": normalized,
        "channel_url": manager_repository_data_channel_url(normalized),
        "deployment": deployment,
    }


def manager_repository_data_channel_url(channel: str | None = None) -> str:
    return _MANAGER_REPOSITORY_DATA_CHANNEL_URLS[normalize_manager_repository_data_channel(channel)]


def read_manager_config(manager_dir: Path) -> configparser.ConfigParser:
    parser = configparser.ConfigParser()
    config_path = manager_dir / "config.ini"
    if config_path.exists():
        parser.read(config_path, encoding="utf-8")
    if not parser.has_section("default"):
        parser.add_section("default")
    return parser


def manager_config_path(manager_dir: Path) -> Path:
    return manager_dir / "config.ini"


def manager_config_backup_path(manager_dir: Path) -> Path:
    return manager_dir / "config_org.ini"


def backup_manager_config_once(manager_dir: Path) -> bool:
    backup_path = manager_config_backup_path(manager_dir)
    if backup_path.exists():
        return False

    config_path = manager_config_path(manager_dir)
    manager_dir.mkdir(parents=True, exist_ok=True)
    if config_path.exists():
        shutil.copy2(config_path, backup_path)
    return True


def restore_manager_config_backup(manager_dir: Path) -> bool:
    backup_path = manager_config_backup_path(manager_dir)
    if not backup_path.exists():
        return False

    config_path = manager_config_path(manager_dir)
    manager_dir.mkdir(parents=True, exist_ok=True)
    os.replace(backup_path, config_path)
    return True


def write_manager_config(manager_dir: Path, parser: configparser.ConfigParser) -> None:
    manager_dir.mkdir(parents=True, exist_ok=True)
    config_path = manager_config_path(manager_dir)
    temp_path = config_path.with_name(f".{config_path.name}.{uuid.uuid4().hex}.tmp")
    with temp_path.open("w", encoding="utf-8") as file:
        parser.write(file)
    os.replace(temp_path, config_path)


def read_manager_network_mode(manager_dir: Path) -> str | None:
    config_path = manager_dir / "config.ini"
    if not config_path.exists():
        return None

    parser = read_manager_config(manager_dir)
    value = parser.get("default", "network_mode", fallback="").strip()
    return value or None


def write_manager_network_mode(manager_dir: Path, network_mode: str | None) -> None:
    parser = read_manager_config(manager_dir)
    if network_mode is None:
        parser.remove_option("default", "network_mode")
    else:
        parser.set("default", "network_mode", network_mode)
    write_manager_config(manager_dir, parser)


def read_manager_config_value(manager_dir: Path, option: str) -> str | None:
    config_path = manager_config_path(manager_dir)
    if not config_path.exists():
        return None

    parser = read_manager_config(manager_dir)
    value = parser.get("default", option, fallback="").strip()
    return value or None


def write_manager_config_values(manager_dir: Path, values: dict[str, str | None]) -> None:
    parser = read_manager_config(manager_dir)
    for option, value in values.items():
        if value is None:
            parser.remove_option("default", option)
        else:
            parser.set("default", option, value)
    write_manager_config(manager_dir, parser)


def read_manager_channel_url(manager_dir: Path) -> str:
    config_path = manager_config_path(manager_dir)
    if not config_path.exists():
        return _DEFAULT_MANAGER_CHANNEL_URL

    parser = read_manager_config(manager_dir)
    channel_url = parser.get("default", "channel_url", fallback=_DEFAULT_MANAGER_CHANNEL_URL).strip()
    return channel_url.rstrip("/") or _DEFAULT_MANAGER_CHANNEL_URL


def manager_cache_filename(channel_url: str, filename: str) -> str:
    cache_key_url = f"{channel_url.rstrip('/')}/{filename}"
    return f"{manager_cache_key_hash(cache_key_url)}_{filename}"


def manager_url_cache_filename(url: str) -> str:
    parsed = urlparse(url)
    filename = Path(parsed.path.rstrip("/")).name or "cache"
    if not Path(filename).suffix:
        filename = f"{filename}.json"
    return f"{manager_cache_key_hash(url)}_{filename}"


def is_cache_file_fresh(path: Path, max_age_seconds: int = _CACHE_MAX_AGE_SECONDS) -> bool:
    if not path.exists():
        return False
    return time.time() - path.stat().st_mtime < max_age_seconds


def write_json_atomic(path: Path, data: Any) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True)
    digest = hashlib.sha256(payload.encode("utf-8")).hexdigest()
    temp_path = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    temp_path.write_text(payload, encoding="utf-8")
    os.replace(temp_path, path)
    return digest


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
    params: dict[str, str | int | bool] = {
        "limit": _COMFY_REGISTRY_NODES_PAGE_LIMIT,
        "form_factor": resolved_metadata["form_factor"] or _current_registry_form_factor(),
        # Keep supported_os out of the request so nodes with missing OS metadata stay in the cache.
        # "supported_os": "...",
        # "latest": True,
    }
    comfyui_version = resolved_metadata["comfyui_version"]
    if comfyui_version:
        params["comfyui_version"] = comfyui_version
    if timestamp:
        params["timestamp"] = timestamp
    return params


def _registry_cache_metadata_matches(cache_data: dict[str, Any], metadata: dict[str, str | None]) -> bool:
    cached_metadata = cache_data.get(_COMFY_REGISTRY_CACHE_METADATA_KEY)
    if not isinstance(cached_metadata, dict):
        return False
    return all(cached_metadata.get(key) == metadata.get(key) for key in _COMFY_REGISTRY_CACHE_INVALIDATION_KEYS)


def _with_registry_cache_metadata(
    data: dict[str, Any],
    metadata: dict[str, str | None],
    previous_metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    now = _format_iso_timestamp(time.time())
    created_at = previous_metadata.get("created_at") if isinstance(previous_metadata, dict) else None
    result = dict(data)
    result[_COMFY_REGISTRY_CACHE_METADATA_KEY] = {
        **metadata,
        "created_at": created_at if isinstance(created_at, str) and created_at else now,
        "updated_at": now,
    }
    return result


def _registry_nodes_url(params: dict[str, str | int | bool]) -> str:
    encoded_params = {key: str(value).lower() if isinstance(value, bool) else value for key, value in params.items()}
    return f"{_COMFY_REGISTRY_NODES_URL}?{urlencode(encoded_params)}"


def _parse_iso_datetime(value: Any) -> float | None:
    if not isinstance(value, str) or not value:
        return None
    normalized = value.replace("Z", "+00:00")
    with contextlib.suppress(ValueError):
        return datetime_fromisoformat(normalized)
    return None


def datetime_fromisoformat(value: str) -> float:
    from datetime import datetime

    return datetime.fromisoformat(value).timestamp()


def _format_iso_timestamp(timestamp: float) -> str:
    from datetime import UTC, datetime

    return datetime.fromtimestamp(timestamp, tz=UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _node_updated_timestamp(node: dict[str, Any]) -> float | None:
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

    parsed = [_parse_iso_datetime(value) for value in candidates]
    timestamps = [value for value in parsed if value is not None]
    return max(timestamps) if timestamps else None


def registry_nodes_incremental_timestamp(cache_data: dict[str, Any]) -> str | None:
    nodes = cache_data.get("nodes")
    if not isinstance(nodes, list):
        return None

    timestamps = [_node_updated_timestamp(node) for node in nodes if isinstance(node, dict)]
    latest_timestamp = max((value for value in timestamps if value is not None), default=None)
    if latest_timestamp is None:
        return None
    return _format_iso_timestamp(latest_timestamp - 10)


def merge_registry_nodes_cache(cache_data: dict[str, Any], update_data: dict[str, Any]) -> dict[str, Any]:
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
    result["limit"] = _COMFY_REGISTRY_NODES_PAGE_LIMIT
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
    source_dir: Path,
    manager_cache_dir: Path,
    on_line: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    source_path = source_dir / _COMFY_REGISTRY_NODES_CACHE_FILENAME
    manager_path = manager_cache_dir / manager_url_cache_filename(_COMFY_REGISTRY_NODES_URL)
    if not source_path.exists():
        on_line and on_line(f"Comfy Registry nodes cache source missing: {_COMFY_REGISTRY_NODES_CACHE_FILENAME}")
        return {
            "file": _COMFY_REGISTRY_NODES_CACHE_FILENAME,
            "action": "missing",
            "source_url": _COMFY_REGISTRY_NODES_URL,
            "source_path": str(source_path),
            "manager_cache_path": str(manager_path),
        }

    data = json.loads(source_path.read_text(encoding="utf-8"))
    manager_data = manager_compatible_registry_nodes_cache(data) if isinstance(data, dict) else data
    digest = write_json_atomic(manager_path, manager_data)
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
        "file": _COMFY_REGISTRY_NODES_CACHE_FILENAME,
        "action": "deployed",
        "source_url": _COMFY_REGISTRY_NODES_URL,
        "source_path": str(source_path),
        "manager_cache_path": str(manager_path),
        "filtered": filtered,
        "sha256": digest,
    }


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

    results: list[dict[str, Any]] = []
    for filename in _MANAGER_CACHE_FILES:
        source_path = source_dir / filename
        manager_path = manager_cache_dir / manager_cache_filename(channel_url, filename)
        if not source_path.exists():
            on_line and on_line(f"Manager cache source missing: {filename}")
            results.append({"file": filename, "action": "missing", "source_path": str(source_path)})
            continue

        data = json.loads(source_path.read_text(encoding="utf-8"))
        digest = write_json_atomic(manager_path, data)
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
    settings = read_controlpanel_settings(resolved_user_dir)
    manager_dir = manager_user_dir(resolved_user_dir)
    previous_network_mode = settings.get(_SETTING_PREVIOUS_MANAGER_NETWORK_MODE)
    was_enabled = bool(settings.get(_SETTING_MANAGER_REPOSITORY_OVERRIDE))

    if enabled:
        if not was_enabled:
            config_path = manager_config_path(manager_dir)
            settings[_SETTING_MANAGER_CONFIG_WAS_MISSING] = not config_path.exists()
            backup_manager_config_once(manager_dir)
        current_network_mode = read_manager_network_mode(manager_dir)
        if _SETTING_PREVIOUS_MANAGER_NETWORK_MODE not in settings:
            settings[_SETTING_PREVIOUS_MANAGER_NETWORK_MODE] = current_network_mode
        settings[_SETTING_MANAGER_REPOSITORY_OVERRIDE] = True
        write_manager_config_values(
            manager_dir,
            {
                "network_mode": "offline",
                "channel_url": manager_repository_data_channel_url(
                    read_manager_repository_data_channel(resolved_user_dir)
                ),
            },
        )
        deployment = deploy_controlpanel_manager_cache_to_manager(resolved_user_dir)
    else:
        config_was_missing = settings.get(_SETTING_MANAGER_CONFIG_WAS_MISSING) is True
        restored = restore_manager_config_backup(manager_dir)
        if not restored and config_was_missing:
            with contextlib.suppress(FileNotFoundError):
                manager_config_path(manager_dir).unlink()
        elif not restored and (previous_network_mode is None or isinstance(previous_network_mode, str)):
            write_manager_network_mode(manager_dir, previous_network_mode)
        settings[_SETTING_MANAGER_REPOSITORY_OVERRIDE] = False
        settings.pop(_SETTING_PREVIOUS_MANAGER_NETWORK_MODE, None)
        settings.pop(_SETTING_MANAGER_CONFIG_WAS_MISSING, None)
        deployment = {"skipped": "Manager repository data override is disabled."}

    write_controlpanel_settings(settings, resolved_user_dir)
    return {
        "enabled": bool(settings.get(_SETTING_MANAGER_REPOSITORY_OVERRIDE)),
        "manager_dir": str(manager_dir),
        "network_mode": read_manager_network_mode(manager_dir),
        "deployment": deployment,
    }


def apply_startup_manager_repository_override(user_dir: Path | None = None) -> dict[str, Any]:
    resolved_user_dir = user_dir or COMFYUI_USER_DIR
    if not is_manager_repository_override_enabled(resolved_user_dir):
        return {"enabled": False, "skipped": "Manager repository data override is disabled."}

    manager_dir = manager_user_dir(resolved_user_dir)
    write_manager_config_values(
        manager_dir,
        {
            "network_mode": "offline",
            "channel_url": manager_repository_data_channel_url(read_manager_repository_data_channel(resolved_user_dir)),
        },
    )
    deployment = deploy_controlpanel_manager_cache_to_manager(resolved_user_dir)
    return {
        "enabled": True,
        "manager_dir": str(manager_dir),
        "network_mode": read_manager_network_mode(manager_dir),
        "deployment": deployment,
    }


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
    async with session.get(url) as response:
        text = await response.text()
        if response.status >= 400:
            raise ManagerApiError(f"Failed to fetch {url}: HTTP {response.status}: {text[:500]}")
        try:
            return json.loads(text)
        except json.JSONDecodeError as error:
            raise ManagerApiError(f"Fetched data was not valid JSON: {url}") from error


async def fetch_registry_nodes_pages(
    session: ClientSession,
    *,
    timestamp: str | None = None,
    metadata: dict[str, str | None] | None = None,
    on_line: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    nodes: list[dict[str, Any]] = []
    page = 1
    total_pages = 1
    base_params = _registry_nodes_request_params(timestamp, metadata)

    while page <= total_pages:
        params = {**base_params, "page": page}
        url = _registry_nodes_url(params)
        data = await fetch_json(session, url)
        if not isinstance(data, dict):
            raise ManagerApiError("Comfy Registry nodes response was not an object.")

        page_nodes = data.get("nodes")
        if not isinstance(page_nodes, list):
            raise ManagerApiError("Comfy Registry nodes response did not include a nodes list.")
        nodes.extend(node for node in page_nodes if isinstance(node, dict))

        total_pages_value = data.get("totalPages", 1)
        total_pages = total_pages_value if isinstance(total_pages_value, int) and total_pages_value > 0 else 1
        if on_line and (page % 10 == 0 or page >= total_pages):
            on_line(f"Updating ComfyRegistry nodes ({page}/{total_pages})")
        page += 1

    return {
        "limit": _COMFY_REGISTRY_NODES_PAGE_LIMIT,
        "nodes": nodes,
        "page": 1,
        "total": len(nodes),
        "totalPages": total_pages,
    }


async def refresh_comfy_registry_nodes_cache(
    session: ClientSession,
    source_dir: Path,
    on_line: Callable[[str], None] | None = None,
    channel: str | None = None,
) -> dict[str, Any]:
    cache_path = source_dir / _COMFY_REGISTRY_NODES_CACHE_FILENAME
    cache_data: dict[str, Any] | None = None
    timestamp: str | None = None
    metadata = _current_registry_cache_metadata(channel) if channel is not None else _current_registry_cache_metadata()
    previous_metadata: dict[str, Any] | None = None
    action = "updated"

    if cache_path.exists():
        try:
            loaded = json.loads(cache_path.read_text(encoding="utf-8"))
            cache_data = loaded if isinstance(loaded, dict) else None
        except json.JSONDecodeError:
            cache_data = None
        if cache_data is not None and isinstance(cache_data.get(_COMFY_REGISTRY_CACHE_METADATA_KEY), dict):
            previous_metadata = cache_data[_COMFY_REGISTRY_CACHE_METADATA_KEY]
        if cache_data is not None and _registry_cache_metadata_matches(cache_data, metadata):
            timestamp = registry_nodes_incremental_timestamp(cache_data)
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

    fetched_data = await fetch_registry_nodes_pages(session, timestamp=timestamp, metadata=metadata, on_line=on_line)
    data = merge_registry_nodes_cache(cache_data, fetched_data) if cache_data is not None else fetched_data
    data = _with_registry_cache_metadata(data, metadata, previous_metadata)
    digest = write_json_atomic(cache_path, data)
    return {
        "file": _COMFY_REGISTRY_NODES_CACHE_FILENAME,
        "action": action,
        "source_url": _COMFY_REGISTRY_NODES_URL,
        "source_path": str(cache_path),
        "timestamp": timestamp,
        "cache_metadata": data[_COMFY_REGISTRY_CACHE_METADATA_KEY],
        "total": len(data.get("nodes", [])) if isinstance(data.get("nodes"), list) else 0,
        "sha256": digest,
    }


async def refresh_manager_cache_from_cdn(
    on_line: Callable[[str], None] | None = None,
    *,
    user_dir: Path | None = None,
    max_age_seconds: int = _CACHE_MAX_AGE_SECONDS,
) -> dict[str, Any]:
    resolved_user_dir = user_dir or COMFYUI_USER_DIR
    channel = read_manager_repository_data_channel(resolved_user_dir)
    if not _MANAGER_CACHE_REFRESH_LOCK.acquire(blocking=False):
        message = "Manager cache refresh is already running."
        on_line and on_line(message)
        return {
            "provider": channel,
            "restart_required": False,
            "skipped": message,
            "user_dir": str(resolved_user_dir),
            "manager_dir": str(manager_user_dir(resolved_user_dir)),
        }

    try:
        return await _refresh_manager_cache_from_cdn_unlocked(
            on_line,
            user_dir=resolved_user_dir,
            max_age_seconds=max_age_seconds,
        )
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
        on_line and on_line(f"ComfyUI Manager user directory was not found: {manager_dir}")
        return {
            "provider": read_manager_repository_data_channel(resolved_user_dir),
            "skipped": "ComfyUI Manager user directory was not found.",
            "manager_dir": str(manager_dir),
        }

    channel = read_manager_repository_data_channel(resolved_user_dir)
    repository_data_url = manager_repository_data_channel_url(channel)
    channel_url = read_manager_channel_url(manager_dir)
    source_dir = controlpanel_manager_cache_source_dir(resolved_user_dir, channel)
    manager_cache_dir = manager_dir / "cache"
    manager_cache_dir.mkdir(parents=True, exist_ok=True)

    results: list[dict[str, Any]] = []
    for filename in _MANAGER_CACHE_FILES:
        source_path = source_dir / filename
        manager_path = manager_cache_dir / manager_cache_filename(channel_url, filename)
        source_url = f"{repository_data_url}/{filename}"
        cache_key_url = f"{channel_url.rstrip('/')}/{filename}"

        if is_cache_file_fresh(source_path, max_age_seconds=max_age_seconds):
            on_line and on_line(f"Manager cache fresh: {filename}")
            if not manager_path.exists():
                data = json.loads(source_path.read_text(encoding="utf-8"))
                digest = write_json_atomic(manager_path, data)
                action = "deployed"
            else:
                digest = hashlib.sha256(source_path.read_bytes()).hexdigest()
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
        async with ClientSession() as session:
            data = await fetch_json(session, source_url)
        digest = write_json_atomic(source_path, data)
        write_json_atomic(manager_path, data)
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
    normalized = message.lower()
    return any(
        phrase in normalized
        for phrase in (
            "your local changes to the following files would be overwritten",
            "the following untracked working tree files would be overwritten",
            "would be overwritten by merge",
            "please commit your changes or stash them before you merge",
        )
    )


async def update_git_repository(repo: Path) -> dict[str, Any]:
    try:
        result = await run_command(_command_args("git", "pull", "--ff-only"), repo, timeout=1200)
    except ManagerApiError as error:
        if _is_local_changes_pull_failure(str(error)):
            return {
                "name": repo.name,
                "path": str(repo),
                "skipped": "Git stopped because local changes would be overwritten.",
                "detail": str(error),
            }
        raise
    return {"name": repo.name, "path": str(repo), "result": result}


async def update_all_git_nodes() -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for repo in discover_git_repositories():
        try:
            results.append(await update_git_repository(repo))
        except Exception as error:  # noqa: BLE001 - report per-repository failures.
            results.append({"name": repo.name, "path": str(repo), "error": str(error)})
    return results


def comfy_cli_command(*args: str) -> list[str]:
    return _command_args("comfy", "--workspace", str(COMFYUI_ROOT), *args)


async def update_git_nodes_with_git(on_line: Callable[[str], None] | None = None) -> dict[str, Any]:
    results: list[dict[str, Any]] = []
    for repo in discover_git_repositories():
        on_line and on_line(f"Updating git node: {repo.name}")
        try:
            result = await update_git_repository(repo)
        except Exception as error:  # noqa: BLE001 - report per-repository failures.
            result = {"name": repo.name, "path": str(repo), "error": str(error)}
        if result.get("skipped"):
            on_line and on_line(f"Skipped {repo.name}: {result['skipped']}")
        elif result.get("error"):
            on_line and on_line(f"Failed {repo.name}: {result['error']}")
        else:
            on_line and on_line(f"Updated {repo.name}")
        results.append(result)
    return {
        "provider": "git",
        "restart_required": True,
        "notes": [
            "Only custom nodes installed as Git repositories are updated.",
            "Repositories with local changes are updated when Git can fast-forward without overwriting them.",
            "Updates use git pull --ff-only and never reset local work.",
        ],
        "results": results,
    }


async def sync_dependencies_with_comfy_cli(on_line: Callable[[str], None] | None = None) -> dict[str, Any]:
    command = comfy_cli_command("node", "uv-sync")
    result = await run_command_stream(command, COMFYUI_ROOT, timeout=3600, on_line=on_line)
    return {
        "provider": "comfy-cli",
        "restart_required": True,
        "protected_packages": sorted(_TORCH_PACKAGES),
        "result": result,
    }


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
    results = [{"name": "ComfyUI git", "result": await run_command(_command_args("git", "pull", "--ff-only"), COMFYUI_ROOT)}]
    if (COMFYUI_ROOT / "requirements.txt").exists() and _command_available("uv"):
        results.append(
            {
                "name": "ComfyUI requirements",
                "result": await run_command(
                    _command_args("uv", "pip", "install", "--python", sys.executable, "-r", "requirements.txt"),
                    COMFYUI_ROOT,
                    timeout=1800,
                ),
            }
        )
    else:
        results.append({"name": "ComfyUI dependencies", "skipped": "uv or dependency metadata was not found."})
    return results


_COMFYUI_VERSION_TAG_PATTERN = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)$")


def _latest_version_tag(tag_output: str) -> str:
    versions: list[tuple[tuple[int, int, int], str]] = []
    for tag in (line.strip() for line in tag_output.splitlines()):
        match = _COMFYUI_VERSION_TAG_PATTERN.match(tag)
        if match:
            versions.append(((int(match.group(1)), int(match.group(2)), int(match.group(3))), tag))

    if not versions:
        raise ManagerApiError("No ComfyUI version tags were found in the repository.")

    return max(versions, key=lambda item: item[0])[1]


async def update_comfyui_with_git(on_line: Callable[[str], None] | None = None) -> dict[str, Any]:
    before_torch = await inspect_torch_runtime()
    fetch_result = await run_command_stream(_command_args("git", "fetch", "--tags", "--force"), COMFYUI_ROOT, timeout=1200, on_line=on_line)
    tag_result = await run_command_stream(_command_args("git", "tag", "--list"), COMFYUI_ROOT, timeout=60)
    latest_tag = _latest_version_tag(str(tag_result.get("stdout", "")))
    on_line and on_line(f"Checking out latest tagged ComfyUI release: {latest_tag}")
    checkout_result = await run_command_stream(
        _command_args("git", "-c", "advice.detachedHead=false", "checkout", latest_tag),
        COMFYUI_ROOT,
        timeout=1200,
        on_line=on_line,
    )
    dependency_result: dict[str, Any]
    requirements_path = COMFYUI_ROOT / "requirements.txt"
    if requirements_path.exists() and _command_available("uv"):
        on_line and on_line("Syncing ComfyUI requirements with the current Python runtime.")
        dependency_result = await run_command_stream(
            _command_args("uv", "pip", "install", "--python", sys.executable, "-r", str(requirements_path)),
            COMFYUI_ROOT,
            timeout=1800,
            on_line=on_line,
        )
    else:
        dependency_result = {"skipped": "uv or requirements.txt was not found."}
        on_line and on_line("Dependency sync skipped because uv or requirements.txt was not found.")
    after_torch = await inspect_torch_runtime()
    return {
        "provider": "git",
        "restart_required": True,
        "warning": "Dependency sync uses the active Python runtime; verify torch/CUDA packages after restart if your install uses custom GPU wheels.",
        "version_tag": latest_tag,
        "torch": {"before": before_torch, "after": after_torch},
        "results": [
            {"name": "ComfyUI fetch tags", "result": fetch_result},
            {"name": "ComfyUI latest tag", "result": tag_result, "selected": latest_tag},
            {"name": "ComfyUI checkout", "result": checkout_result},
            {"name": "ComfyUI requirements", "result": dependency_result},
        ],
    }


async def _read_json(request) -> dict[str, Any]:
    try:
        data = await request.json()
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _same_server_url(request, path: str) -> str:
    scheme = request.headers.get("X-Forwarded-Proto", request.scheme)
    host = request.headers.get("Host")
    if not host:
        raise ManagerApiError("Cannot determine the current ComfyUI server host.")
    return urlunparse((scheme, host, path, "", "", ""))


async def request_manager_no_body_post(url: str, provider: str) -> dict[str, Any]:
    try:
        async with ClientSession() as session:
            async with session.post(url) as response:
                text = await response.text()
                if response.status >= 400:
                    raise ManagerApiError(f"ComfyUI Manager request failed with HTTP {response.status}: {text}")
                return {
                    "provider": provider,
                    "status": response.status,
                    "message": text.strip(),
                }
    except ManagerApiError:
        raise
    except ClientError as error:
        raise ManagerApiError(f"ComfyUI Manager route is not available: {error}") from error


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
    try:
        sys.stdout.write(_CLEAR_TERMINAL_CSI)
        sys.stdout.flush()
    except Exception:  # noqa: BLE001 - terminal cleanup must not block restart.
        LOGGER.debug("[ControlPanel] Failed to clear terminal before restart.", exc_info=True)


async def restart_comfyui(_request) -> dict[str, Any]:
    clear_terminal_for_restart()
    schedule_restart()
    return {
        "provider": "local-restart",
        "message": "Local ComfyUI restart was scheduled.",
    }


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


def _prune_jobs() -> None:
    if len(_JOBS) <= _JOB_LIMIT:
        return
    for job_id in sorted(_JOBS, key=lambda key: _JOBS[key].created_at)[: len(_JOBS) - _JOB_LIMIT]:
        del _JOBS[job_id]


async def start_job(kind: str, label: str, operation: Callable[[ManagerJob], Awaitable[dict[str, Any]]]) -> ManagerJob:
    global _LATEST_JOB_ID
    async with _JOB_LOCK:
        if any(job.status in {"queued", "running"} for job in _JOBS.values()):
            raise ManagerApiError("Another manager update job is already running.")
        job = ManagerJob(id=uuid.uuid4().hex, kind=kind, label=label)
        _JOBS[job.id] = job
        _LATEST_JOB_ID = job.id
        _prune_jobs()
        asyncio.create_task(_run_job(job, operation))
        return job


async def _run_job(job: ManagerJob, operation: Callable[[ManagerJob], Awaitable[dict[str, Any]]]) -> None:
    job.status = "running"
    job.started_at = time.time()
    job.append_log(f"{job.label} started.")
    try:
        result = await operation(job)
        job.result = result
        job.restart_required = bool(result.get("restart_required"))
        job.status = "succeeded"
        job.append_log(f"{job.label} completed.")
    except Exception as error:  # noqa: BLE001 - persist job failures for the UI.
        job.error = str(error)
        job.status = "failed"
        job.append_log(f"{job.label} failed: {error}")
    finally:
        job.finished_at = time.time()


def latest_job() -> ManagerJob | None:
    if _LATEST_JOB_ID is None:
        return None
    return _JOBS.get(_LATEST_JOB_ID)


def schedule_restart(delay_seconds: float = 1.0) -> None:
    async def delayed_restart() -> None:
        await asyncio.sleep(delay_seconds)
        restart_current_process()

    asyncio.create_task(delayed_restart())


def restart_exec_args() -> list[str]:
    return [sys.executable, *sys.argv]


def restart_current_process() -> None:
    args = restart_exec_args()
    print("\nRestarting...\n\n", flush=True)
    print(f"Command: {args}", flush=True)
    os.execv(sys.executable, args)


def register_routes() -> bool:
    global _ROUTES_REGISTERED
    if _ROUTES_REGISTERED:
        return False

    try:
        from server import PromptServer
    except Exception:
        return False

    routes = PromptServer.instance.routes

    @routes.get(f"{API_PREFIX}/status")
    async def status(_request):
        repos = [{"name": repo.name, "path": str(repo)} for repo in discover_git_repositories()]
        return _json_response(
            {
                "ok": True,
                "paths": {
                    "extension": str(EXTENSION_ROOT),
                    "custom_nodes": str(CUSTOM_NODES_DIR),
                    "comfyui": str(COMFYUI_ROOT),
                    "user": str(COMFYUI_USER_DIR),
                },
                "tools": {"git": _command_available("git"), "uv": _command_available("uv")},
                "latest_job": latest_job().to_dict() if latest_job() else None,
                "repositories": repos,
                "settings": {
                    "manager_repository_data_override": is_manager_repository_override_enabled(),
                    "manager_repository_data_channel": read_manager_repository_data_channel(),
                    "manager_network_mode": read_manager_network_mode(manager_user_dir()),
                    "manager_channel_url": read_manager_channel_url(manager_user_dir()),
                },
            }
        )

    @routes.get(f"{API_PREFIX}/settings")
    async def get_settings(_request):
        manager_dir = manager_user_dir()
        return _json_response(
            {
                "ok": True,
                "manager_repository_data_override": is_manager_repository_override_enabled(),
                "manager_repository_data_channel": read_manager_repository_data_channel(),
                "manager_network_mode": read_manager_network_mode(manager_dir),
                "manager_channel_url": read_manager_channel_url(manager_dir),
            }
        )

    @routes.post(f"{API_PREFIX}/settings/manager-repository-data-override")
    async def set_manager_repository_data_override(request):
        data = await _read_json(request)
        try:
            result = set_manager_repository_override(data.get("enabled") is True)
            return _json_response({"ok": True, **result})
        except Exception as error:  # noqa: BLE001 - settings errors should surface to the UI.
            return _error_response(str(error), status=500)

    @routes.post(f"{API_PREFIX}/settings/manager-repository-data-channel")
    async def set_manager_repository_data_channel_route(request):
        data = await _read_json(request)
        try:
            result = set_manager_repository_data_channel(data.get("channel"))
            return _json_response({"ok": True, **result})
        except Exception as error:  # noqa: BLE001 - settings errors should surface to the UI.
            return _error_response(str(error), status=500)

    @routes.post(f"{API_PREFIX}/install-git-url")
    async def install(request):
        data = await _read_json(request)
        return await _with_operation_lock(
            lambda: _operation_install_git_url(
                str(data.get("url", "")),
                str(data["name"]) if data.get("name") else None,
            )
        )

    @routes.post(f"{API_PREFIX}/update-all")
    async def update_all(_request):
        return await _start_job_response("git-nodes", "Update Git Nodes", _job_update_git_nodes)

    @routes.post(f"{API_PREFIX}/update/custom-nodes")
    async def update_custom_nodes(_request):
        return await _start_job_response("git-nodes", "Update Git Nodes", _job_update_git_nodes)

    @routes.post(f"{API_PREFIX}/deps/uv-sync")
    async def sync_dependencies(_request):
        return await _start_job_response("deps", "Sync Dependencies", _job_sync_dependencies)

    @routes.post(f"{API_PREFIX}/manager-cache/refresh")
    async def refresh_manager_cache(_request):
        return await _start_job_response("manager-cache", "Update Manager Cache", _job_refresh_manager_cache)

    @routes.post(f"{API_PREFIX}/update-comfyui")
    async def update_core(_request):
        return await _start_job_response("comfyui", "Update ComfyUI", _job_update_comfyui)

    @routes.post(f"{API_PREFIX}/update/comfyui")
    async def update_comfyui_route(_request):
        return await _start_job_response("comfyui", "Update ComfyUI", _job_update_comfyui)

    @routes.get(f"{API_PREFIX}/update/status")
    async def update_status(_request):
        job = latest_job()
        return _json_response({"ok": True, "job": job.to_dict() if job else None})

    @routes.get(f"{API_PREFIX}/update/jobs/{{job_id}}")
    async def update_job_status(request):
        job = _JOBS.get(str(request.match_info["job_id"]))
        if job is None:
            return _error_response("Update job was not found.", status=404)
        return _json_response({"ok": True, "job": job.to_dict()})

    @routes.post(f"{API_PREFIX}/restart")
    async def restart(request):
        data = await _read_json(request)
        if data.get("confirm") is not True:
            return _error_response("Restart requires confirm=true.", status=400)
        try:
            result = await restart_comfyui(request)
            return _json_response({"ok": True, **result})
        except Exception as error:  # noqa: BLE001 - surface restart failures to the UI.
            return _error_response(str(error), status=500)

    _ROUTES_REGISTERED = True
    return True


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


async def _job_refresh_manager_cache(job: ManagerJob) -> dict[str, Any]:
    return await refresh_manager_cache_from_cdn(job.append_log)


async def _job_update_comfyui(job: ManagerJob) -> dict[str, Any]:
    job.append_log("Using built-in ComfyUI updater; ComfyUI Manager update route is disabled.")
    return await update_comfyui_with_git(job.append_log)


async def _operation_update_all() -> dict[str, Any]:
    return {"results": await update_all_git_nodes()}


async def _operation_update_comfyui() -> dict[str, Any]:
    return {"results": await update_comfyui()}


async def _operation_install_git_url(url: str, name: str | None) -> dict[str, Any]:
    return {"install": await install_git_url(url, name)}
