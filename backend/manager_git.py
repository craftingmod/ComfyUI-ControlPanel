from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Awaitable, Callable
from urllib.parse import urlparse

from .manager_process import ManagerApiError


COMFYUI_VERSION_TAG_PATTERN = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)$")


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


def is_local_changes_pull_failure(message: str) -> bool:
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


def latest_version_tag(tag_output: str) -> str:
    versions: list[tuple[tuple[int, int, int], str]] = []
    for tag in (line.strip() for line in tag_output.splitlines()):
        match = COMFYUI_VERSION_TAG_PATTERN.match(tag)
        if match:
            versions.append(((int(match.group(1)), int(match.group(2)), int(match.group(3))), tag))

    if not versions:
        raise ManagerApiError("No ComfyUI version tags were found in the repository.")

    return max(versions, key=lambda item: item[0])[1]


async def update_git_repository(
    repo: Path,
    *,
    command_args: Callable[..., list[str]],
    run_command: Callable[..., Awaitable[dict[str, Any]]],
) -> dict[str, Any]:
    try:
        result = await run_command(command_args("git", "pull", "--ff-only"), repo, timeout=1200)
    except ManagerApiError as error:
        if is_local_changes_pull_failure(str(error)):
            return {
                "name": repo.name,
                "path": str(repo),
                "skipped": "Git stopped because local changes would be overwritten.",
                "detail": str(error),
            }
        raise
    return {"name": repo.name, "path": str(repo), "result": result}


async def update_all_git_nodes(
    *,
    repositories: Callable[[], list[Path]],
    update_repository: Callable[[Path], Awaitable[dict[str, Any]]],
) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for repo in repositories():
        try:
            results.append(await update_repository(repo))
        except Exception as error:  # noqa: BLE001 - report per-repository failures.
            results.append({"name": repo.name, "path": str(repo), "error": str(error)})
    return results


async def update_git_nodes_with_git(
    *,
    repositories: Callable[[], list[Path]],
    update_repository: Callable[[Path], Awaitable[dict[str, Any]]],
    on_line: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    results: list[dict[str, Any]] = []
    for repo in repositories():
        on_line and on_line(f"Updating git node: {repo.name}")
        try:
            result = await update_repository(repo)
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


async def update_comfyui(
    *,
    workspace: Path,
    python_executable: str,
    command_args: Callable[..., list[str]],
    command_available: Callable[[str], bool],
    run_command: Callable[..., Awaitable[dict[str, Any]]],
) -> list[dict[str, Any]]:
    results = [{"name": "ComfyUI git", "result": await run_command(command_args("git", "pull", "--ff-only"), workspace)}]
    if (workspace / "requirements.txt").exists() and command_available("uv"):
        results.append(
            {
                "name": "ComfyUI requirements",
                "result": await run_command(
                    command_args("uv", "pip", "install", "--python", python_executable, "-r", "requirements.txt"),
                    workspace,
                    timeout=1800,
                ),
            }
        )
    else:
        results.append({"name": "ComfyUI dependencies", "skipped": "uv or dependency metadata was not found."})
    return results


async def update_comfyui_with_git(
    *,
    workspace: Path,
    python_executable: str,
    command_args: Callable[..., list[str]],
    command_available: Callable[[str], bool],
    run_command_stream: Callable[..., Awaitable[dict[str, Any]]],
    inspect_torch_runtime: Callable[[], Awaitable[dict[str, Any]]],
    on_line: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    before_torch = await inspect_torch_runtime()
    fetch_result = await run_command_stream(command_args("git", "fetch", "--tags", "--force"), workspace, timeout=1200, on_line=on_line)
    tag_result = await run_command_stream(command_args("git", "tag", "--list"), workspace, timeout=60)
    latest_tag = latest_version_tag(str(tag_result.get("stdout", "")))
    on_line and on_line(f"Checking out latest tagged ComfyUI release: {latest_tag}")
    checkout_result = await run_command_stream(
        command_args("git", "-c", "advice.detachedHead=false", "checkout", latest_tag),
        workspace,
        timeout=1200,
        on_line=on_line,
    )
    requirements_path = workspace / "requirements.txt"
    if requirements_path.exists() and command_available("uv"):
        on_line and on_line("Syncing ComfyUI requirements with the current Python runtime.")
        dependency_result: dict[str, Any] = await run_command_stream(
            command_args("uv", "pip", "install", "--python", python_executable, "-r", str(requirements_path)),
            workspace,
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
