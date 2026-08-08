from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Awaitable, Callable

from .manager_git import repo_name_from_git_url, validate_git_url
from .manager_process import ManagerApiError


MANIFEST_VERSION = 1
MAX_MANIFEST_NODES = 1000
_NODE_ID_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9_.-]{0,99}$")
_FOLDER_PATTERN = re.compile(r"^[A-Za-z0-9_.-]+$")


def _require_object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ManagerApiError(f"{label} must be an object.")
    return value


def _require_array(value: Any, label: str) -> list[Any]:
    if not isinstance(value, list):
        raise ManagerApiError(f"{label} must be an array.")
    if len(value) > MAX_MANIFEST_NODES:
        raise ManagerApiError(f"{label} cannot contain more than {MAX_MANIFEST_NODES} entries.")
    return value


def _validate_registry_id(value: Any) -> str:
    if not isinstance(value, str) or not _NODE_ID_PATTERN.fullmatch(value.strip()):
        raise ManagerApiError("Registry node id is invalid.")
    return value.strip()


def _validate_folder(value: Any) -> str:
    if not isinstance(value, str):
        raise ManagerApiError("Git node folder must be a string.")
    folder = value.strip()
    if folder in {"", ".", ".."} or not _FOLDER_PATTERN.fullmatch(folder):
        raise ManagerApiError("Git node folder is invalid.")
    return folder


def _validate_unmanaged_folder(value: Any) -> str:
    if not isinstance(value, str):
        raise ManagerApiError("Unmanaged node folder must be a string.")
    folder = value.strip()
    if not folder or "\x00" in folder or "/" in folder or "\\" in folder:
        raise ManagerApiError("Unmanaged node folder is invalid.")
    return folder


def validate_node_restore_manifest(value: Any) -> dict[str, Any]:
    manifest = _require_object(value, "Node restore manifest")
    if manifest.get("format_version") != MANIFEST_VERSION:
        raise ManagerApiError(f"Unsupported node restore manifest version: {manifest.get('format_version')!r}")

    registry_nodes: list[dict[str, str]] = []
    registry_ids: set[str] = set()
    for raw_entry in _require_array(manifest.get("registry_nodes"), "registry_nodes"):
        entry = _require_object(raw_entry, "Registry node entry")
        node_id = _validate_registry_id(entry.get("id"))
        if node_id in registry_ids:
            raise ManagerApiError(f"Duplicate registry node id: {node_id}")
        registry_ids.add(node_id)
        registry_nodes.append({"id": node_id})

    git_nodes: list[dict[str, str]] = []
    git_destinations: set[str] = set()
    for raw_entry in _require_array(manifest.get("git_nodes"), "git_nodes"):
        entry = _require_object(raw_entry, "Git node entry")
        url = validate_git_url(str(entry.get("url", "")))
        folder = _validate_folder(entry["folder"]) if "folder" in entry else repo_name_from_git_url(url)
        destination_key = folder.casefold()
        if destination_key in git_destinations:
            raise ManagerApiError(f"Duplicate Git node destination: {folder}")
        git_destinations.add(destination_key)
        normalized_entry = {"url": url}
        if "folder" in entry:
            normalized_entry["folder"] = folder
        git_nodes.append(normalized_entry)

    unmanaged_nodes: list[dict[str, str]] = []
    for raw_entry in _require_array(manifest.get("unmanaged_nodes", []), "unmanaged_nodes"):
        entry = _require_object(raw_entry, "Unmanaged node entry")
        unmanaged_nodes.append({"folder": _validate_unmanaged_folder(entry.get("folder"))})

    return {
        "format_version": MANIFEST_VERSION,
        "registry_nodes": registry_nodes,
        "git_nodes": git_nodes,
        "unmanaged_nodes": unmanaged_nodes,
    }


async def collect_node_restore_inventory(
    root: Path,
    repositories: Callable[[], list[Path]],
    command_args: Callable[..., list[str]],
    run_command: Callable[..., Awaitable[dict[str, Any]]],
) -> dict[str, Any]:
    git_repositories = {repo.resolve(): repo for repo in repositories()}
    nodes: list[dict[str, str]] = []
    if not root.exists():
        return {"nodes": nodes}

    for folder in sorted((path for path in root.iterdir() if path.is_dir()), key=lambda path: path.name.casefold()):
        entry = {"folder": folder.name}
        repository = git_repositories.get(folder.resolve())
        if repository is not None:
            try:
                result = await run_command(
                    command_args("git", "config", "--get", "remote.origin.url"),
                    repository,
                    timeout=60,
                )
                entry["git_url"] = validate_git_url(str(result.get("stdout", "")))
            except Exception as error:  # noqa: BLE001 - keep the rest of the inventory usable.
                entry["git_error"] = str(error)
        nodes.append(entry)
    return {"nodes": nodes}


async def restore_node_manifest(
    manifest_value: Any,
    *,
    workspace: Path,
    custom_nodes_dir: Path,
    comfy_command: Callable[..., list[str]],
    install_git: Callable[[str, str | None], Awaitable[dict[str, Any]]],
    run_command_stream: Callable[..., Awaitable[dict[str, Any]]],
    on_line: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    manifest = validate_node_restore_manifest(manifest_value)
    registry_results: list[dict[str, Any]] = []
    git_results: list[dict[str, Any]] = []
    installed_count = 0

    for entry in manifest["registry_nodes"]:
        node_id = entry["id"]
        on_line and on_line(f"Installing registry node: {node_id}")
        try:
            result = await run_command_stream(
                comfy_command("node", "install", node_id),
                workspace,
                timeout=1800,
                on_line=on_line,
            )
            registry_results.append({"id": node_id, "result": result})
            installed_count += 1
            on_line and on_line(f"Installed registry node: {node_id}")
        except Exception as error:  # noqa: BLE001 - continue restoring independent nodes.
            registry_results.append({"id": node_id, "error": str(error)})
            on_line and on_line(f"Failed registry node {node_id}: {error}")

    for entry in manifest["git_nodes"]:
        url = entry["url"]
        folder = entry.get("folder")
        destination_name = folder or repo_name_from_git_url(url)
        destination = (custom_nodes_dir / destination_name).resolve()
        if destination.exists():
            git_results.append({"url": url, "folder": destination_name, "skipped": "Destination already exists."})
            on_line and on_line(f"Skipped Git node {destination_name}: destination already exists.")
            continue
        on_line and on_line(f"Cloning Git node: {destination_name}")
        try:
            result = await install_git(url, folder)
            git_results.append({"url": url, "folder": destination_name, "result": result})
            installed_count += 1
            on_line and on_line(f"Cloned Git node: {destination_name}")
        except Exception as error:  # noqa: BLE001 - continue restoring independent nodes.
            git_results.append({"url": url, "folder": destination_name, "error": str(error)})
            on_line and on_line(f"Failed Git node {destination_name}: {error}")

    failed_count = sum("error" in result for result in [*registry_results, *git_results])
    skipped_count = sum("skipped" in result for result in git_results)
    dependency_sync_required = installed_count > 0
    dependency_sync_command = ["comfy", "--workspace", str(workspace), "node", "uv-sync"]
    on_line and on_line(
        f"Node restore completed: {installed_count} installed, {skipped_count} skipped, {failed_count} failed."
    )
    if dependency_sync_required:
        on_line and on_line("Close ComfyUI, then run `comfy node uv-sync` for this workspace to sync dependencies.")
    return {
        "provider": "node-restore-manifest",
        "restart_required": installed_count > 0,
        "installed": installed_count,
        "skipped": skipped_count,
        "failed": failed_count,
        "registry_nodes": registry_results,
        "git_nodes": git_results,
        "dependency_sync_required": dependency_sync_required,
        "dependency_sync_command": dependency_sync_command if dependency_sync_required else None,
        "unmanaged_nodes": manifest["unmanaged_nodes"],
    }
