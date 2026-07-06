from __future__ import annotations

import asyncio
import contextlib
import os
import platform
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any, Callable


class ManagerApiError(ValueError):
    pass


def command_available(command: str) -> bool:
    return find_executable(command) is not None


def find_executable(command: str) -> str | None:
    return shutil.which(command)


def command_args(command: str, *args: str) -> list[str]:
    executable = find_executable(command)
    if executable is None:
        raise ManagerApiError(f"Required command is not available: {command}")
    return [executable, *args]


async def run_command(args: list[str], cwd: Path, timeout: int = 600) -> dict[str, Any]:
    if not args:
        raise ManagerApiError("No command was provided.")
    if not Path(args[0]).is_file() and not command_available(args[0]):
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
    if not Path(args[0]).is_file() and not command_available(args[0]):
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


def open_path_in_file_manager(path: Path) -> dict[str, Any]:
    target = path.resolve()
    if not target.exists():
        raise ManagerApiError(f"Path does not exist: {target}")

    system = platform.system()
    if system == "Windows":
        startfile = getattr(os, "startfile", None)
        if not callable(startfile):
            raise ManagerApiError("Windows file manager opener is not available.")
        startfile(str(target))
        command = ["os.startfile", str(target)]
    elif system == "Darwin":
        command = command_args("open", str(target))
        subprocess.Popen(command)
    else:
        command = command_args("xdg-open", str(target))
        subprocess.Popen(command)

    return {
        "provider": "local-file-manager",
        "path": str(target),
        "command": command,
    }
