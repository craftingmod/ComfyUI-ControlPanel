from __future__ import annotations

import configparser
import contextlib
import json
import os
import shutil
import uuid
from pathlib import Path
from typing import Any, Callable


def controlpanel_manager_cache_dir(user_dir: Path) -> Path:
    return user_dir / "__controlpanel" / "manager-cache"


def controlpanel_manager_cache_source_dir(user_dir: Path, channel: str) -> Path:
    return controlpanel_manager_cache_dir(user_dir) / "sources" / channel


def controlpanel_config_path(user_dir: Path, filename: str) -> Path:
    return user_dir / "__controlpanel" / filename


def manager_user_dir(user_dir: Path) -> Path:
    return user_dir / "__manager"


def manager_snapshot_dir(user_dir: Path) -> Path:
    return manager_user_dir(user_dir) / "snapshots"


def read_controlpanel_settings(config_path: Path, warn: Callable[[str, Path], None]) -> dict[str, Any]:
    if not config_path.exists():
        return {}

    try:
        data = json.loads(config_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        warn("[ControlPanel] Ignoring invalid internal config: %s", config_path)
        return {}
    return data if isinstance(data, dict) else {}


def write_controlpanel_settings(config_path: Path, settings: dict[str, Any], write_json: Callable[[Path, Any], str]) -> str:
    return write_json(config_path, settings)


def read_manager_config(manager_dir: Path) -> configparser.ConfigParser:
    parser = configparser.ConfigParser()
    config_path = manager_config_path(manager_dir)
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
    config_path = manager_config_path(manager_dir)
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


def read_manager_channel_url(manager_dir: Path, default_url: str) -> str:
    config_path = manager_config_path(manager_dir)
    if not config_path.exists():
        return default_url

    parser = read_manager_config(manager_dir)
    channel_url = parser.get("default", "channel_url", fallback=default_url).strip()
    return channel_url.rstrip("/") or default_url


def set_manager_repository_data_channel(
    *,
    channel: Any,
    user_dir: Path,
    setting_channel_key: str,
    is_override_enabled: Callable[[Path], bool],
    normalize_channel: Callable[[Any], str],
    channel_url: Callable[[str], str],
    manager_channel_url: Callable[[str], str],
    read_settings: Callable[[Path], dict[str, Any]],
    write_settings: Callable[[dict[str, Any], Path], str],
    deploy_cache: Callable[[Path], dict[str, Any]],
) -> dict[str, Any]:
    normalized = normalize_channel(channel)
    settings = read_settings(user_dir)
    settings[setting_channel_key] = normalized
    write_settings(settings, user_dir)

    deployment: dict[str, Any] = {"skipped": "Manager repository data override is disabled."}
    if is_override_enabled(user_dir):
        manager_dir = manager_user_dir(user_dir)
        write_manager_config_values(manager_dir, {"channel_url": manager_channel_url(normalized)})
        deployment = deploy_cache(user_dir)

    return {
        "channel": normalized,
        "channel_url": channel_url(normalized),
        "deployment": deployment,
    }


def set_manager_repository_override(
    *,
    enabled: bool,
    user_dir: Path,
    setting_override_key: str,
    setting_channel_key: str,
    setting_previous_network_mode_key: str,
    setting_config_missing_key: str,
    normalize_channel: Callable[[Any], str],
    manager_channel_url: Callable[[str], str],
    read_settings: Callable[[Path], dict[str, Any]],
    write_settings: Callable[[dict[str, Any], Path], str],
    deploy_cache: Callable[[Path], dict[str, Any]],
) -> dict[str, Any]:
    settings = read_settings(user_dir)
    manager_dir = manager_user_dir(user_dir)
    previous_network_mode = settings.get(setting_previous_network_mode_key)
    was_enabled = bool(settings.get(setting_override_key))

    if enabled:
        if not was_enabled:
            config_path = manager_config_path(manager_dir)
            settings[setting_config_missing_key] = not config_path.exists()
            backup_manager_config_once(manager_dir)
        current_network_mode = read_manager_network_mode(manager_dir)
        if setting_previous_network_mode_key not in settings:
            settings[setting_previous_network_mode_key] = current_network_mode
        settings[setting_override_key] = True
        normalized_channel = normalize_channel(settings.get(setting_channel_key))
        write_manager_config_values(
            manager_dir,
            {
                "network_mode": "offline",
                "channel_url": manager_channel_url(normalized_channel),
            },
        )
        deployment = deploy_cache(user_dir)
    else:
        config_was_missing = settings.get(setting_config_missing_key) is True
        restored = restore_manager_config_backup(manager_dir)
        if not restored and config_was_missing:
            with contextlib.suppress(FileNotFoundError):
                manager_config_path(manager_dir).unlink()
        elif not restored and (previous_network_mode is None or isinstance(previous_network_mode, str)):
            write_manager_network_mode(manager_dir, previous_network_mode)
        settings[setting_override_key] = False
        settings.pop(setting_previous_network_mode_key, None)
        settings.pop(setting_config_missing_key, None)
        deployment = {"skipped": "Manager repository data override is disabled."}

    write_settings(settings, user_dir)
    return {
        "enabled": bool(settings.get(setting_override_key)),
        "manager_dir": str(manager_dir),
        "network_mode": read_manager_network_mode(manager_dir),
        "deployment": deployment,
    }


def apply_startup_manager_repository_override(
    *,
    user_dir: Path,
    channel: str,
    manager_channel_url: Callable[[str], str],
    deploy_cache: Callable[[Path], dict[str, Any]],
) -> dict[str, Any]:
    manager_dir = manager_user_dir(user_dir)
    write_manager_config_values(
        manager_dir,
        {
            "network_mode": "offline",
            "channel_url": manager_channel_url(channel),
        },
    )
    deployment = deploy_cache(user_dir)
    return {
        "enabled": True,
        "manager_dir": str(manager_dir),
        "network_mode": read_manager_network_mode(manager_dir),
        "deployment": deployment,
    }
