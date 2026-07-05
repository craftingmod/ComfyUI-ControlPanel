from __future__ import annotations

import asyncio
import os
import re
import shutil
import sys
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


EXTENSION_ROOT = Path(__file__).resolve().parents[1]
CUSTOM_NODES_DIR = EXTENSION_ROOT.parent
COMFYUI_ROOT = CUSTOM_NODES_DIR.parent
API_PREFIX = "/manager-extension"
_ROUTES_REGISTERED = False
_OPERATION_LOCK = asyncio.Lock()


class ManagerApiError(ValueError):
    pass


def _json_response(data: dict[str, Any], status: int = 200):
    from aiohttp import web

    return web.json_response(data, status=status)


def _error_response(message: str, status: int = 400):
    return _json_response({"ok": False, "error": message}, status=status)


def _command_available(command: str) -> bool:
    return shutil.which(command) is not None


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
    if not _command_available(args[0]):
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


async def update_git_repository(repo: Path) -> dict[str, Any]:
    result = await run_command(["git", "pull", "--ff-only"], repo)
    return {"name": repo.name, "path": str(repo), "result": result}


async def update_all_custom_nodes() -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for repo in discover_git_repositories():
        try:
            results.append(await update_git_repository(repo))
        except Exception as error:  # noqa: BLE001 - report per-repository failures.
            results.append({"name": repo.name, "path": str(repo), "error": str(error)})
    return results


async def update_comfyui() -> list[dict[str, Any]]:
    results = [{"name": "ComfyUI git", "result": await run_command(["git", "pull", "--ff-only"], COMFYUI_ROOT)}]
    if (COMFYUI_ROOT / "pyproject.toml").exists() and _command_available("uv"):
        results.append({"name": "ComfyUI uv sync", "result": await run_command(["uv", "sync"], COMFYUI_ROOT, timeout=1200)})
    elif (COMFYUI_ROOT / "requirements.txt").exists() and _command_available("uv"):
        results.append(
            {
                "name": "ComfyUI requirements",
                "result": await run_command(["uv", "pip", "install", "-r", "requirements.txt"], COMFYUI_ROOT, timeout=1200),
            }
        )
    else:
        results.append({"name": "ComfyUI dependencies", "skipped": "uv or dependency metadata was not found."})
    return results


async def _read_json(request) -> dict[str, Any]:
    try:
        data = await request.json()
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


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
    async def delayed_restart() -> None:
        await asyncio.sleep(delay_seconds)
        restart_current_process()

    asyncio.create_task(delayed_restart())


def restart_current_process() -> None:
    args = list(getattr(sys, "orig_argv", None) or [sys.executable, *sys.argv])
    if not args:
        args = [sys.executable]
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
                },
                "tools": {"git": _command_available("git"), "uv": _command_available("uv")},
                "repositories": repos,
            }
        )

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
        return await _with_operation_lock(lambda: _operation_update_all())

    @routes.post(f"{API_PREFIX}/update-comfyui")
    async def update_core(_request):
        return await _with_operation_lock(lambda: _operation_update_comfyui())

    @routes.post(f"{API_PREFIX}/restart")
    async def restart(request):
        data = await _read_json(request)
        if data.get("confirm") is not True:
            return _error_response("Restart requires confirm=true.", status=400)
        schedule_restart()
        return _json_response({"ok": True, "message": "Restart requested. The ComfyUI process will restart shortly."})

    _ROUTES_REGISTERED = True
    return True


async def _operation_update_all() -> dict[str, Any]:
    return {"results": await update_all_custom_nodes()}


async def _operation_update_comfyui() -> dict[str, Any]:
    return {"results": await update_comfyui()}


async def _operation_install_git_url(url: str, name: str | None) -> dict[str, Any]:
    return {"install": await install_git_url(url, name)}
