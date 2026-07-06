from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any


def resolve_comfyui_root(extension_root: Path, configured_path: str | None) -> Path:
    if configured_path:
        return Path(configured_path).expanduser().resolve()

    try:
        import folder_paths

        return Path(folder_paths.base_path).resolve()
    except Exception:
        return extension_root.parent.parent.resolve()


def resolve_custom_nodes_dir(comfyui_root: Path) -> Path:
    return (comfyui_root / "custom_nodes").resolve()


def resolve_comfyui_user_dir(comfyui_root: Path, argv: list[str]) -> Path:
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

    if "--user-directory" in argv:
        index = argv.index("--user-directory")
        if index + 1 < len(argv):
            return Path(argv[index + 1]).expanduser().resolve()

    return (comfyui_root / "user").resolve()


def clear_terminal_for_restart(stdout: Any, clear_sequence: str, logger: Any) -> None:
    try:
        stdout.write(clear_sequence)
        stdout.flush()
    except Exception:  # noqa: BLE001 - terminal cleanup must not block restart.
        logger.debug("[ControlPanel] Failed to clear terminal before restart.", exc_info=True)


async def restart_comfyui(clear_terminal, schedule_restart) -> dict[str, Any]:
    clear_terminal()
    schedule_restart()
    return {
        "provider": "local-restart",
        "message": "Local ComfyUI restart was scheduled.",
    }


def schedule_restart(restart_current_process, delay_seconds: float = 1.0) -> None:
    async def delayed_restart() -> None:
        await asyncio.sleep(delay_seconds)
        restart_current_process()

    asyncio.create_task(delayed_restart())


def restart_exec_args(executable: str, argv: list[str]) -> list[str]:
    return [executable, *argv]


def restart_current_process(executable: str, argv: list[str], execv) -> None:
    args = restart_exec_args(executable, argv)
    print("\nRestarting...\n\n", flush=True)
    print(f"Command: {args}", flush=True)
    execv(executable, args)
