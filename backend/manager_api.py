from __future__ import annotations

import asyncio
import contextlib
import logging
import time
import uuid
from dataclasses import dataclass, field
import os
import re
import shutil
import sys
from pathlib import Path
from typing import Any, Awaitable, Callable
from urllib.parse import urlparse, urlunparse
from aiohttp import ClientError, ClientSession


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


COMFYUI_ROOT = resolve_comfyui_root()
CUSTOM_NODES_DIR = resolve_custom_nodes_dir(COMFYUI_ROOT)
API_PREFIX = "/control-panel"
_ROUTES_REGISTERED = False
_OPERATION_LOCK = asyncio.Lock()
_JOB_LOCK = asyncio.Lock()
_JOBS: dict[str, "ManagerJob"] = {}
_LATEST_JOB_ID: str | None = None
_JOB_LIMIT = 10
_TORCH_PACKAGES = {"torch", "torchvision", "torchaudio"}
_CLEAR_TERMINAL_CSI = "\033[2J\033[H"
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


async def request_manager_reboot(request) -> dict[str, Any]:
    result = await request_first_manager_route(request, ["/v2/manager/reboot", "/manager/reboot"], "manager-rest")
    return {
        **result,
        "message": result["message"] or "Restart requested through ComfyUI Manager.",
    }


def clear_terminal_for_restart() -> None:
    try:
        sys.stdout.write(_CLEAR_TERMINAL_CSI)
        sys.stdout.flush()
    except Exception:  # noqa: BLE001 - terminal cleanup must not block restart.
        LOGGER.debug("[ControlPanel] Failed to clear terminal before restart.", exc_info=True)


async def restart_comfyui(request) -> dict[str, Any]:
    clear_terminal_for_restart()
    try:
        return await request_manager_reboot(request)
    except ManagerApiError as error:
        schedule_restart()
        return {
            "provider": "execv-fallback",
            "message": "ComfyUI Manager reboot route failed; local process restart fallback was scheduled.",
            "manager_error": str(error),
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
                "latest_job": latest_job().to_dict() if latest_job() else None,
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
        return await _start_job_response("git-nodes", "Update Git Nodes", _job_update_git_nodes)

    @routes.post(f"{API_PREFIX}/update/custom-nodes")
    async def update_custom_nodes(_request):
        return await _start_job_response("git-nodes", "Update Git Nodes", _job_update_git_nodes)

    @routes.post(f"{API_PREFIX}/deps/uv-sync")
    async def sync_dependencies(_request):
        return await _start_job_response("deps", "Sync Dependencies", _job_sync_dependencies)

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


async def _job_update_comfyui(job: ManagerJob) -> dict[str, Any]:
    job.append_log("Using built-in ComfyUI updater; ComfyUI Manager update route is disabled.")
    return await update_comfyui_with_git(job.append_log)


async def _operation_update_all() -> dict[str, Any]:
    return {"results": await update_all_git_nodes()}


async def _operation_update_comfyui() -> dict[str, Any]:
    return {"results": await update_comfyui()}


async def _operation_install_git_url(url: str, name: str | None) -> dict[str, Any]:
    return {"install": await install_git_url(url, name)}
