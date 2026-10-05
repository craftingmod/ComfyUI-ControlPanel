import asyncio

import pytest

from backend import manager_restore
from backend.manager_process import ManagerApiError


def test_validate_manifest_keeps_only_explicit_git_folder():
  result = manager_restore.validate_node_restore_manifest(
    {
      "format_version": 1,
      "registry_nodes": [{"id": "registry-node", "version": "1.2.3"}],
      "git_nodes": [
        {
          "url": "https://github.com/example/default-name.git",
          "commit": "1111111111111111111111111111111111111111",
        },
        {
          "url": "https://github.com/example/original.git",
          "folder": "CustomFolder",
          "commit": "2222222222222222222222222222222222222222",
        },
      ],
      "unmanaged_nodes": [{"folder": "로컬 노드"}],
    }
  )

  assert result == {
    "format_version": 1,
    "registry_nodes": [{"id": "registry-node", "version": "1.2.3"}],
    "git_nodes": [
      {
        "url": "https://github.com/example/default-name.git",
        "commit": "1111111111111111111111111111111111111111",
      },
      {
        "url": "https://github.com/example/original.git",
        "folder": "CustomFolder",
        "commit": "2222222222222222222222222222222222222222",
      },
    ],
    "unmanaged_nodes": [{"folder": "로컬 노드"}],
  }


@pytest.mark.parametrize(
  "manifest, message",
  [
    ({"format_version": 2, "registry_nodes": [], "git_nodes": []}, "Unsupported"),
    (
      {"format_version": 1, "registry_nodes": [{"id": "../bad"}], "git_nodes": []},
      "id is invalid",
    ),
    (
      {
        "format_version": 1,
        "registry_nodes": [{"id": "safe-node", "version": "../outside"}],
        "git_nodes": [],
      },
      "version is invalid",
    ),
    (
      {
        "format_version": 1,
        "registry_nodes": [{"id": "safe-node", "version": "..\\outside"}],
        "git_nodes": [],
      },
      "version is invalid",
    ),
    (
      {
        "format_version": 1,
        "registry_nodes": [],
        "git_nodes": [
          {"url": "https://github.com/example/node.git", "folder": "../bad"}
        ],
      },
      "folder is invalid",
    ),
  ],
)
def test_validate_manifest_rejects_invalid_entries(manifest, message):
  with pytest.raises(ManagerApiError, match=message):
    manager_restore.validate_node_restore_manifest(manifest)


def test_collect_inventory_reads_git_origin_and_keeps_unmanaged_folders(tmp_path):
  git_node = tmp_path / "GitNode"
  local_node = tmp_path / "LocalNode"
  git_node.mkdir()
  local_node.mkdir()
  calls = []

  async def fake_run_command(args, cwd, timeout=600):
    calls.append((args, cwd, timeout))
    if args[1:3] == ["config", "--get"]:
      return {"stdout": "https://github.com/example/GitNode.git"}
    return {"stdout": "1234567890abcdef1234567890abcdef12345678"}

  result = asyncio.run(
    manager_restore.collect_node_restore_inventory(
      tmp_path,
      lambda: [git_node],
      lambda *args: list(args),
      fake_run_command,
    )
  )

  assert result == {
    "nodes": [
      {
        "folder": "GitNode",
        "git_url": "https://github.com/example/GitNode.git",
        "git_commit": "1234567890abcdef1234567890abcdef12345678",
      },
      {"folder": "LocalNode"},
    ]
  }
  assert calls == [
    (["git", "config", "--get", "remote.origin.url"], git_node, 60),
    (["git", "rev-parse", "HEAD"], git_node, 60),
  ]


def test_restore_installs_latest_nodes_clones_git_and_requests_stopped_dependency_sync(
  tmp_path,
):
  commands = []
  clones = []
  logs = []

  async def fake_run_command_stream(args, cwd, timeout=1800, on_line=None):
    commands.append((args, cwd, timeout))
    return {"stdout": "ok"}

  async def fake_install_git(url, folder=None, commit=None):
    clones.append((url, folder, commit))
    return {"destination": str(tmp_path / (folder or "GitNode"))}

  result = asyncio.run(
    manager_restore.restore_node_manifest(
      {
        "format_version": 1,
        "registry_nodes": [{"id": "registry-node", "version": "1.2.3"}],
        "git_nodes": [
          {
            "url": "https://github.com/example/GitNode.git",
            "commit": "1111111111111111111111111111111111111111",
          }
        ],
      },
      workspace=tmp_path,
      custom_nodes_dir=tmp_path,
      comfy_command=lambda *args: ["comfy", "--workspace", str(tmp_path), *args],
      install_git=fake_install_git,
      run_command_stream=fake_run_command_stream,
      on_line=logs.append,
    )
  )

  assert commands == [
    (
      [
        "comfy",
        "--workspace",
        str(tmp_path),
        "node",
        "install",
        "registry-node",
        "--no-deps",
      ],
      tmp_path,
      1800,
    ),
  ]
  assert clones == [("https://github.com/example/GitNode.git", None, None)]
  assert result["installed"] == 2
  assert result["failed"] == 0
  assert result["restart_required"] is True
  assert result["dependency_sync_required"] is True
  assert result["dependency_sync_command"] == [
    "comfy",
    "--workspace",
    str(tmp_path),
    "node",
    "uv-sync",
  ]
  assert (
    logs[-1]
    == "Close ComfyUI, then run `comfy node uv-sync` for this workspace to sync dependencies."
  )


def test_restore_uses_registry_versions_and_git_commits_from_manifest(tmp_path):
  commands = []
  clones = []

  async def fake_run_command_stream(args, cwd, timeout=1800, on_line=None):
    commands.append((args, cwd, timeout))
    return {"stdout": "ok"}

  async def fake_install_git(url, folder=None, commit=None):
    clones.append((url, folder, commit))
    return {"destination": str(tmp_path / (folder or "GitNode"))}

  result = asyncio.run(
    manager_restore.restore_node_manifest(
      {
        "format_version": 1,
        "registry_nodes": [{"id": "registry-node", "version": "1.2.3"}],
        "git_nodes": [
          {
            "url": "https://github.com/example/GitNode.git",
            "commit": "1111111111111111111111111111111111111111",
          }
        ],
      },
      workspace=tmp_path,
      custom_nodes_dir=tmp_path,
      comfy_command=lambda *args: ["comfy", "--workspace", str(tmp_path), *args],
      install_git=fake_install_git,
      run_command_stream=fake_run_command_stream,
      version_mode="backup",
    )
  )

  assert commands == [
    (
      [
        "comfy",
        "--workspace",
        str(tmp_path),
        "node",
        "registry-install",
        "registry-node",
        "--version",
        "1.2.3",
      ],
      tmp_path,
      1800,
    )
  ]
  assert clones == [
    (
      "https://github.com/example/GitNode.git",
      None,
      "1111111111111111111111111111111111111111",
    )
  ]
  assert result["failed"] == 0


@pytest.mark.parametrize("version_mode", ["pinned", [], None])
def test_restore_rejects_invalid_version_mode(tmp_path, version_mode):
  async def fake_install_git(*args):
    return {}

  async def fake_run_command_stream(*args, **kwargs):
    return {}

  with pytest.raises(ManagerApiError, match="version mode is invalid"):
    asyncio.run(
      manager_restore.restore_node_manifest(
        {"format_version": 1, "registry_nodes": [], "git_nodes": []},
        workspace=tmp_path,
        custom_nodes_dir=tmp_path,
        comfy_command=lambda *args: list(args),
        install_git=fake_install_git,
        run_command_stream=fake_run_command_stream,
        version_mode=version_mode,
      )
    )
