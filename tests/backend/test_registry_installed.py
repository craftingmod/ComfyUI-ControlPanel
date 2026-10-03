from pathlib import Path

from backend.registry_installed import discover_installed_registry_nodes


def _archive(path: Path, name: str | None) -> None:
  path.mkdir(parents=True)
  (path / ".tracking").write_text("__init__.py\n", encoding="utf-8")
  (path / "pyproject.toml").write_text(
    "[project]\n" + (f'name = "{name}"\n' if name else 'version = "1.0.0"\n'),
    encoding="utf-8",
  )


def test_discovers_registry_nodes_across_roots_and_disabled_installations(tmp_path):
  first, second = tmp_path / "one", tmp_path / "two"
  _archive(first / "renamed-folder", "REGISTRY-A")
  _archive(second / ".disabled" / "registry-b@1_0_0", "registry-b")
  _archive(second / "registry-c.disabled", "registry-c")
  _archive(second / "missing-name", None)
  _archive(second / ".disabled" / ".trash" / "deleted", "registry-deleted")
  marker = first / "nightly" / ".git"
  marker.mkdir(parents=True)
  (marker / ".cnr-id").write_text("registry-nightly\n", encoding="utf-8")
  assert discover_installed_registry_nodes([first, second, tmp_path / "missing"]) == {
    "registry-a",
    "registry-b",
    "registry-c",
    "registry-nightly",
  }


def test_git_repositories_use_catalog_identity_and_ignore_unrelated_pyproject(tmp_path):
  root = tmp_path / "nodes"
  remote = root / "renamed-repository" / ".git"
  remote.mkdir(parents=True)
  (remote / "config").write_text(
    '[remote "origin"]\nurl = git@github.com:Publisher/My-Node.git\n', encoding="utf-8"
  )
  declared = root / "declared-registry-node"
  (declared / ".git").mkdir(parents=True)
  (declared / "pyproject.toml").write_text(
    '[project]\nname = "declared-node"\n[tool.comfy]\nPublisherId = "publisher"\n',
    encoding="utf-8",
  )
  unrelated = root / "unrelated"
  unrelated.mkdir()
  (unrelated / "pyproject.toml").write_text(
    '[project]\nname = "remote-node"\n', encoding="utf-8"
  )
  invalid = root / "invalid"
  (invalid / ".git").mkdir(parents=True)
  (invalid / "pyproject.toml").write_text("[project]\nname = [", encoding="utf-8")
  (invalid / ".git" / "config").write_text("invalid git config", encoding="utf-8")
  catalog = [
    {"id": "remote-node", "repository": "https://github.com/publisher/my-node/"},
    {"id": "declared-node"},
  ]
  assert discover_installed_registry_nodes([root], catalog) == {
    "remote-node",
    "declared-node",
  }
  assert discover_installed_registry_nodes([root]) == set()


def test_linked_worktree_uses_common_git_directory(tmp_path):
  root = tmp_path / "nodes"
  worktree = root / "linked-node"
  worktree.mkdir(parents=True)
  common = tmp_path / "repo" / ".git"
  git_dir = common / "worktrees" / "linked-node"
  git_dir.mkdir(parents=True)
  (worktree / ".git").write_text(f"gitdir: {git_dir}\n", encoding="utf-8")
  (git_dir / "commondir").write_text("../..\n", encoding="utf-8")
  (common / "config").write_text(
    '[remote "origin"]\nurl = ssh://git@github.com/publisher/linked-node.git\n',
    encoding="utf-8",
  )
  catalog = [
    {"id": "linked-node", "repository": "https://github.com/publisher/linked-node"}
  ]
  assert discover_installed_registry_nodes([root], catalog) == {"linked-node"}
  (common / ".cnr-id").write_text("trusted-node", encoding="utf-8")
  assert discover_installed_registry_nodes([root]) == {"trusted-node"}
