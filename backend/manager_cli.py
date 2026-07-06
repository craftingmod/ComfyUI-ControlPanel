from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .manager_process import ManagerApiError


def sync_dependencies_response(result: dict[str, Any], protected_packages: set[str]) -> dict[str, Any]:
    return {
        "provider": "comfy-cli",
        "restart_required": True,
        "protected_packages": sorted(protected_packages),
        "result": result,
    }


def environment_response(result: dict[str, Any]) -> dict[str, Any]:
    try:
        envelope = json.loads(str(result.get("stdout", "")))
    except json.JSONDecodeError as error:
        raise ManagerApiError(f"comfy --json env returned invalid JSON: {error}") from error
    if not isinstance(envelope, dict):
        raise ManagerApiError("comfy --json env returned an unexpected payload.")
    if envelope.get("ok") is not True:
        raise ManagerApiError(str(envelope.get("error") or "comfy env failed."))
    return {
        "provider": "comfy-cli",
        "cli": {
            "command": envelope.get("command"),
            "version": envelope.get("version"),
            "where": envelope.get("where"),
        },
        "environment": envelope.get("data") if isinstance(envelope.get("data"), dict) else {},
        "result": result,
    }


def validate_snapshot_name(name: str) -> str:
    normalized = name.strip()
    if not normalized:
        raise ManagerApiError("Snapshot name is required.")
    if "/" in normalized or "\\" in normalized or ".." in normalized or "\x00" in normalized:
        raise ManagerApiError("Snapshot name is invalid.")
    if normalized.endswith(".json"):
        normalized = normalized[:-5]
    if not normalized:
        raise ManagerApiError("Snapshot name is required.")
    return normalized


def list_manager_snapshots(snapshot_dir: Path) -> dict[str, Any]:
    snapshots: list[dict[str, Any]] = []
    if snapshot_dir.exists():
        for path in sorted(snapshot_dir.glob("*.json"), key=lambda item: item.name, reverse=True):
            stat = path.stat()
            snapshots.append(
                {
                    "name": path.stem,
                    "path": str(path),
                    "mtime": stat.st_mtime,
                    "size": stat.st_size,
                }
            )
    return {
        "snapshot_dir": str(snapshot_dir),
        "snapshots": snapshots,
    }


def save_snapshot_response(result: dict[str, Any], snapshots: dict[str, Any]) -> dict[str, Any]:
    return {
        "provider": "comfy-cli",
        "restart_required": False,
        "result": result,
        **snapshots,
    }


def restore_snapshot_response(snapshot: str, snapshot_path: Path, result: dict[str, Any]) -> dict[str, Any]:
    return {
        "provider": "comfy-cli",
        "restart_required": True,
        "snapshot": snapshot,
        "snapshot_path": str(snapshot_path),
        "result": result,
    }
