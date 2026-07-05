import asyncio

import pytest

from backend import manager_api


def test_repo_name_from_git_url_handles_common_url_shapes():
    assert manager_api.repo_name_from_git_url("https://github.com/user/ComfyUI-Foo.git") == "ComfyUI-Foo"
    assert manager_api.repo_name_from_git_url("git@github.com:user/comfyui-bar.git") == "comfyui-bar"


def test_validate_git_url_rejects_local_paths_and_unknown_schemes():
    with pytest.raises(manager_api.ManagerApiError):
        manager_api.validate_git_url("../outside")

    with pytest.raises(manager_api.ManagerApiError):
        manager_api.validate_git_url("file:///tmp/repo")


def test_resolve_custom_node_destination_sanitizes_folder_name():
    destination = manager_api.resolve_custom_node_destination("foo/bar baz")

    assert destination.name == "foo-bar-baz"
    assert destination.parent == manager_api.CUSTOM_NODES_DIR


def test_install_git_url_uses_git_clone_without_shell(monkeypatch, tmp_path):
    calls = []

    async def fake_run_command(args, cwd, timeout=600):
        calls.append((args, cwd, timeout))
        return {"returncode": 0}

    monkeypatch.setattr(manager_api, "CUSTOM_NODES_DIR", tmp_path)
    monkeypatch.setattr(manager_api, "run_command", fake_run_command)

    result = asyncio.run(manager_api.install_git_url("https://github.com/user/comfyui-test.git"))

    assert calls == [
        (
            ["git", "clone", "https://github.com/user/comfyui-test.git", str(tmp_path / "comfyui-test")],
            tmp_path,
            600,
        )
    ]
    assert result["destination"] == str(tmp_path / "comfyui-test")
