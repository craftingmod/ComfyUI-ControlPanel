from __future__ import annotations

from pathlib import Path


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
