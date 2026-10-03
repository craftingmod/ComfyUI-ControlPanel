from __future__ import annotations

import configparser
import tomllib
from pathlib import Path
from urllib.parse import urlsplit


def _repository_key(value: object) -> str | None:
  if not isinstance(value, str) or not value.strip():
    return None
  value = value.strip()
  if "://" not in value and "@" in value and ":" in value:
    value = "ssh://" + value.replace(":", "/", 1)
  try:
    parsed = urlsplit(value)
    host = parsed.hostname
  except ValueError:
    return None
  if not host:
    return None
  path = parsed.path.rstrip("/")
  path = path.removesuffix(".git")
  if host.lower() == "github.com":
    path = path.lower()
  return host.lower() + path


def _git_dirs(path: Path) -> list[Path]:
  git_dir = path / ".git"
  if git_dir.is_file():
    try:
      marker = git_dir.read_text(encoding="utf-8").strip()
      if not marker.startswith("gitdir:"):
        return []
      git_dir = (path / marker.partition(":")[2].strip()).resolve()
    except (OSError, UnicodeError):
      return []
  if not git_dir.is_dir():
    return []
  try:
    common_dir = (
      git_dir / (git_dir / "commondir").read_text(encoding="utf-8").strip()
    ).resolve()
  except (OSError, UnicodeError):
    return [git_dir]
  return [git_dir, common_dir] if common_dir != git_dir else [git_dir]


def _installed_id(
  path: Path, catalog_ids: set[str], repositories: dict[str, str]
) -> str | None:
  git_dirs = _git_dirs(path)
  for git_dir in git_dirs:
    try:
      node_id = (git_dir / ".cnr-id").read_text(encoding="utf-8").strip().lower()
      if node_id:
        return node_id
    except (OSError, UnicodeError):
      pass

  try:
    with (path / "pyproject.toml").open("rb") as file:
      metadata = tomllib.load(file)
  except (OSError, UnicodeError, tomllib.TOMLDecodeError):
    metadata = {}
  project = metadata.get("project", {})
  name = project.get("name") if isinstance(project, dict) else None
  node_id = name.strip().lower() if isinstance(name, str) else ""
  if node_id and (path / ".tracking").is_file():
    return node_id
  tool = metadata.get("tool", {})
  if (
    git_dirs
    and node_id in catalog_ids
    and isinstance(tool, dict)
    and isinstance(tool.get("comfy"), dict)
  ):
    return node_id

  for git_dir in git_dirs:
    config = configparser.ConfigParser(strict=False, interpolation=None)
    try:
      config.read(git_dir / "config", encoding="utf-8")
      for section in config.sections():
        if section.startswith("remote "):
          repository = _repository_key(config.get(section, "url", fallback=None))
          if repository in repositories:
            return repositories[repository]
    except (OSError, UnicodeError, configparser.Error):
      pass
  return None


def discover_installed_registry_nodes(
  roots: list[Path], catalog_nodes: list[dict] | None = None
) -> set[str]:
  """Read Registry identities from enabled and disabled installations without loading Manager."""
  catalog_ids: set[str] = set()
  repositories: dict[str, str] = {}
  for node in catalog_nodes or []:
    node_id = node.get("id")
    if isinstance(node_id, str) and node_id.strip():
      node_id = node_id.strip().lower()
      catalog_ids.add(node_id)
      repository = _repository_key(node.get("repository"))
      if repository:
        repositories[repository] = node_id

  installed: set[str] = set()
  for root in roots:
    for directory in (root, root / ".disabled"):
      try:
        children = list(directory.iterdir())
      except OSError:
        continue
      for child in children:
        if (
          child.name.startswith(".")
          or child.name == "__pycache__"
          or not child.is_dir()
        ):
          continue
        node_id = _installed_id(child, catalog_ids, repositories)
        if node_id:
          installed.add(node_id)
  return installed
