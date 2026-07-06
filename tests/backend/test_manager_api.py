import asyncio
import io
import sys
from types import SimpleNamespace

import pytest

from backend import manager_api


def test_resolve_comfyui_root_prefers_comfyui_path_env(monkeypatch, tmp_path):
    configured_root = tmp_path / "ConfiguredComfyUI"
    monkeypatch.setenv("COMFYUI_PATH", str(configured_root))

    assert manager_api.resolve_comfyui_root() == configured_root.resolve()


def test_resolve_comfyui_root_uses_folder_paths_when_env_is_missing(monkeypatch, tmp_path):
    comfyui_root = tmp_path / "RuntimeComfyUI"
    fake_folder_paths = SimpleNamespace(
        base_path=str(comfyui_root),
    )
    monkeypatch.delenv("COMFYUI_PATH", raising=False)
    monkeypatch.setitem(sys.modules, "folder_paths", fake_folder_paths)

    assert manager_api.resolve_comfyui_root() == comfyui_root.resolve()


def test_resolve_custom_nodes_dir_uses_comfyui_root_child(tmp_path):
    comfyui_root = tmp_path / "RuntimeComfyUI"

    assert manager_api.resolve_custom_nodes_dir(comfyui_root) == (comfyui_root / "custom_nodes").resolve()


def test_same_server_url_uses_current_request_host():
    request = SimpleNamespace(headers={"Host": "127.0.0.1:8188"}, scheme="http")

    assert manager_api._same_server_url(request, "/manager/reboot") == "http://127.0.0.1:8188/manager/reboot"


def test_manager_job_append_log_writes_python_log_without_job_label(caplog):
    job = manager_api.ManagerJob(id="job", kind="git-nodes", label="Update Git Nodes")

    with caplog.at_level("INFO", logger=manager_api.LOGGER.name):
        job.append_log("Updated ComfyUI-Test")

    assert job.logs == ["Updated ComfyUI-Test"]
    assert "[ControlPanel] Updated ComfyUI-Test" in caplog.text
    assert "Update Git Nodes: Updated ComfyUI-Test" not in caplog.text


def test_same_server_url_respects_forwarded_proto():
    request = SimpleNamespace(headers={"Host": "example.test", "X-Forwarded-Proto": "https"}, scheme="http")

    assert manager_api._same_server_url(request, "/manager/reboot") == "https://example.test/manager/reboot"


def test_restart_comfyui_falls_back_when_manager_route_fails(monkeypatch):
    calls = []

    async def fake_request_manager_reboot(_request):
        raise manager_api.ManagerApiError("manager route unavailable")

    def fake_schedule_restart():
        calls.append("scheduled")

    monkeypatch.setattr(manager_api, "request_manager_reboot", fake_request_manager_reboot)
    monkeypatch.setattr(manager_api, "schedule_restart", fake_schedule_restart)
    monkeypatch.setattr(manager_api, "clear_terminal_for_restart", lambda: calls.append("cleared"))

    result = asyncio.run(manager_api.restart_comfyui(SimpleNamespace()))

    assert calls == ["cleared", "scheduled"]
    assert result["provider"] == "execv-fallback"
    assert result["manager_error"] == "manager route unavailable"


def test_clear_terminal_for_restart_writes_csi(monkeypatch):
    stdout = io.StringIO()

    monkeypatch.setattr(manager_api.sys, "stdout", stdout)

    manager_api.clear_terminal_for_restart()

    assert stdout.getvalue() == manager_api._CLEAR_TERMINAL_CSI


def test_request_manager_update_comfyui_uses_v2_queue_route(monkeypatch):
    calls = []
    request = SimpleNamespace(headers={"Host": "127.0.0.1:8188"}, scheme="http")

    async def fake_request_manager_no_body_post(url, provider):
        calls.append((url, provider))
        return {"provider": provider, "status": 200, "message": ""}

    monkeypatch.setattr(manager_api, "request_manager_no_body_post", fake_request_manager_no_body_post)

    result = asyncio.run(manager_api.request_manager_update_comfyui(request))

    assert calls == [("http://127.0.0.1:8188/v2/manager/queue/update_comfyui", "manager-rest")]
    assert result["restart_required"] is True
    assert result["message"] == "ComfyUI update was queued through ComfyUI Manager."


def test_job_update_comfyui_uses_builtin_git_updater(monkeypatch):
    calls = []
    job = manager_api.ManagerJob(id="job", kind="comfyui", label="Update ComfyUI")

    async def fake_update_comfyui_with_git(on_line=None):
        calls.append("git")
        if on_line:
            on_line("git updater ran")
        return {"provider": "git", "restart_required": True}

    async def fail_request_manager_update_comfyui(*_args, **_kwargs):
        raise AssertionError("ComfyUI Manager update route should not be used")

    monkeypatch.setattr(manager_api, "update_comfyui_with_git", fake_update_comfyui_with_git)
    monkeypatch.setattr(manager_api, "request_manager_update_comfyui", fail_request_manager_update_comfyui)

    result = asyncio.run(manager_api._job_update_comfyui(job))

    assert calls == ["git"]
    assert result["provider"] == "git"
    assert "Using built-in ComfyUI updater" in job.logs[0]
    assert "git updater ran" in job.logs[1]


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


def test_update_git_repository_attempts_fast_forward_with_local_changes(monkeypatch, tmp_path):
    calls = []
    repo = tmp_path / "ComfyUI-Test"
    repo.mkdir()

    async def fake_run_command(args, cwd, timeout=600):
        calls.append((args, cwd, timeout))
        return {"returncode": 0, "stdout": "Already up to date."}

    monkeypatch.setattr(manager_api, "_find_executable", lambda command: f"/bin/{command}")
    monkeypatch.setattr(manager_api, "run_command", fake_run_command)

    result = asyncio.run(manager_api.update_git_repository(repo))

    assert calls == [(["/bin/git", "pull", "--ff-only"], repo, 1200)]
    assert result["result"]["stdout"] == "Already up to date."


def test_update_git_repository_skips_when_local_changes_would_be_overwritten(monkeypatch, tmp_path):
    repo = tmp_path / "ComfyUI-Test"
    repo.mkdir()

    async def fake_run_command(_args, _cwd, timeout=600):
        raise manager_api.ManagerApiError(
            "Command failed: git pull --ff-only\n"
            "error: Your local changes to the following files would be overwritten by merge:\n"
            "  config.json\n"
            "Please commit your changes or stash them before you merge."
        )

    monkeypatch.setattr(manager_api, "_find_executable", lambda command: f"/bin/{command}")
    monkeypatch.setattr(manager_api, "run_command", fake_run_command)

    result = asyncio.run(manager_api.update_git_repository(repo))

    assert result["name"] == "ComfyUI-Test"
    assert result["skipped"] == "Git stopped because local changes would be overwritten."
    assert "config.json" in result["detail"]


def test_update_git_repository_uses_fast_forward_only(monkeypatch, tmp_path):
    calls = []
    repo = tmp_path / "ComfyUI-Test"
    repo.mkdir()

    async def fake_run_command(args, cwd, timeout=600):
        calls.append((args, cwd, timeout))
        return {"returncode": 0, "stdout": "Already up to date."}

    monkeypatch.setattr(manager_api, "_find_executable", lambda command: f"/bin/{command}")
    monkeypatch.setattr(manager_api, "run_command", fake_run_command)

    result = asyncio.run(manager_api.update_git_repository(repo))

    assert calls == [
        (["/bin/git", "pull", "--ff-only"], repo, 1200),
    ]
    assert result["name"] == "ComfyUI-Test"
    assert result["result"]["stdout"] == "Already up to date."


def test_dependency_sync_uses_comfy_cli_uv_sync(monkeypatch, tmp_path):
    calls = []

    async def fake_run_command_stream(args, cwd, timeout=1800, on_line=None):
        calls.append((args, cwd, timeout))
        return {"returncode": 0}

    monkeypatch.setattr(manager_api, "COMFYUI_ROOT", tmp_path)
    monkeypatch.setattr(manager_api, "_find_executable", lambda command: f"/bin/{command}")
    monkeypatch.setattr(manager_api, "run_command_stream", fake_run_command_stream)

    result = asyncio.run(manager_api.sync_dependencies_with_comfy_cli())

    assert calls == [
        (
            ["/bin/comfy", "--workspace", str(tmp_path), "node", "uv-sync"],
            tmp_path,
            3600,
        )
    ]
    assert result["protected_packages"] == ["torch", "torchaudio", "torchvision"]


def test_latest_version_tag_prefers_highest_semver_tag():
    assert manager_api._latest_version_tag("latest\nv0.3.9\nv0.3.77\nv0.27.0\nrelease/v0.99\n") == "v0.27.0"


def test_update_comfyui_git_provider_checks_out_latest_tag_and_syncs_requirements(monkeypatch, tmp_path):
    calls = []
    (tmp_path / "requirements.txt").write_text("comfyui-frontend-package\n", encoding="utf-8")

    async def fake_inspect_torch_runtime():
        return {"stdout": '{"available": true}'}

    async def fake_run_command_stream(args, cwd, timeout=1800, on_line=None):
        calls.append((args, cwd, timeout))
        if args == ["/bin/git", "tag", "--list"]:
            return {"returncode": 0, "stdout": "latest\nv0.26.2\nv0.27.0\n", "command": args}
        return {"returncode": 0, "command": args}

    monkeypatch.setattr(manager_api, "COMFYUI_ROOT", tmp_path)
    monkeypatch.setattr(manager_api, "_find_executable", lambda command: f"/bin/{command}")
    monkeypatch.setattr(manager_api, "inspect_torch_runtime", fake_inspect_torch_runtime)
    monkeypatch.setattr(manager_api, "run_command_stream", fake_run_command_stream)
    monkeypatch.setattr(manager_api.sys, "executable", "/venv/python")

    result = asyncio.run(manager_api.update_comfyui_with_git())

    assert calls == [
        (["/bin/git", "fetch", "--tags", "--force"], tmp_path, 1200),
        (["/bin/git", "tag", "--list"], tmp_path, 60),
        (["/bin/git", "-c", "advice.detachedHead=false", "checkout", "v0.27.0"], tmp_path, 1200),
        (["/bin/uv", "pip", "install", "--python", "/venv/python", "-r", str(tmp_path / "requirements.txt")], tmp_path, 1800),
    ]
    assert result["provider"] == "git"
    assert result["version_tag"] == "v0.27.0"
    assert result["restart_required"] is True


def test_start_job_rejects_concurrent_running_jobs(monkeypatch):
    manager_api._JOBS.clear()
    manager_api._LATEST_JOB_ID = None

    async def never_finishes(job):
        await asyncio.sleep(10)
        return {"restart_required": False}

    async def start_two_jobs():
        first = await manager_api.start_job("test", "Test Job", never_finishes)
        with pytest.raises(manager_api.ManagerApiError):
            await manager_api.start_job("test", "Second Job", never_finishes)
        return first

    first_job = asyncio.run(start_two_jobs())
    assert first_job.status in {"queued", "running"}

    manager_api._JOBS.clear()
    manager_api._LATEST_JOB_ID = None


def test_restart_current_process_execs_original_python_command(monkeypatch):
    calls = []
    original_argv = ["python", "-s", "main.py", "--listen", "0.0.0.0"]

    def fake_execv(path, args):
        calls.append((path, args))

    monkeypatch.setattr(manager_api.sys, "executable", "C:/Python/python.exe")
    monkeypatch.setattr(manager_api.sys, "orig_argv", original_argv, raising=False)
    monkeypatch.setattr(manager_api.os, "execv", fake_execv)

    manager_api.restart_current_process()

    assert calls == [("C:/Python/python.exe", original_argv)]
