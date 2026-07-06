import asyncio
import io
import json
import os
import sys
import time
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


def test_open_path_in_file_manager_uses_windows_startfile(monkeypatch, tmp_path):
    calls = []

    monkeypatch.setattr(manager_api.platform, "system", lambda: "Windows")
    monkeypatch.setattr(manager_api.os, "startfile", lambda path: calls.append(path), raising=False)

    result = manager_api.open_path_in_file_manager(tmp_path)

    assert calls == [str(tmp_path.resolve())]
    assert result["provider"] == "local-file-manager"
    assert result["path"] == str(tmp_path.resolve())
    assert result["command"] == ["os.startfile", str(tmp_path.resolve())]


def test_open_path_in_file_manager_uses_xdg_open_on_linux(monkeypatch, tmp_path):
    calls = []

    monkeypatch.setattr(manager_api.platform, "system", lambda: "Linux")
    monkeypatch.setattr(manager_api, "_command_args", lambda *args: list(args))
    monkeypatch.setattr(manager_api.subprocess, "Popen", lambda command: calls.append(command))

    result = manager_api.open_path_in_file_manager(tmp_path)

    assert calls == [["xdg-open", str(tmp_path.resolve())]]
    assert result["command"] == ["xdg-open", str(tmp_path.resolve())]


def test_open_path_in_file_manager_rejects_missing_path(tmp_path):
    missing_path = tmp_path / "missing"

    with pytest.raises(manager_api.ManagerApiError, match="Path does not exist"):
        manager_api.open_path_in_file_manager(missing_path)


def test_list_manager_snapshots_returns_sorted_json_files(tmp_path):
    snapshot_dir = tmp_path / "__manager" / "snapshots"
    snapshot_dir.mkdir(parents=True)
    (snapshot_dir / "2026-07-04_08-07-20_autosave.json").write_text("{}", encoding="utf-8")
    (snapshot_dir / "2026-07-05_08-07-20_snapshot.json").write_text("{}", encoding="utf-8")
    (snapshot_dir / "ignored.txt").write_text("", encoding="utf-8")

    result = manager_api.list_manager_snapshots(tmp_path)

    assert result["snapshot_dir"] == str(snapshot_dir)
    assert [snapshot["name"] for snapshot in result["snapshots"]] == [
        "2026-07-05_08-07-20_snapshot",
        "2026-07-04_08-07-20_autosave",
    ]


def test_validate_snapshot_name_rejects_path_traversal():
    with pytest.raises(manager_api.ManagerApiError, match="Snapshot name is invalid"):
        manager_api.validate_snapshot_name("../snapshot")


def test_save_snapshot_with_comfy_cli_uses_comfy_command(monkeypatch):
    calls = []

    monkeypatch.setattr(manager_api, "comfy_cli_command", lambda *args: ["comfy", *args])
    monkeypatch.setattr(manager_api, "list_manager_snapshots", lambda: {"snapshots": [], "snapshot_dir": "snapshots"})

    async def fake_run_command_stream(command, cwd, timeout=1800, on_line=None):
        calls.append((command, cwd, timeout))
        return {"stdout": "saved", "stderr": ""}

    monkeypatch.setattr(manager_api, "run_command_stream", fake_run_command_stream)

    result = asyncio.run(manager_api.save_snapshot_with_comfy_cli())

    assert calls == [(["comfy", "node", "save-snapshot"], manager_api.COMFYUI_ROOT, 1800)]
    assert result["provider"] == "comfy-cli"
    assert result["restart_required"] is False


def test_show_environment_with_comfy_cli_uses_comfy_env(monkeypatch):
    calls = []

    monkeypatch.setattr(manager_api, "comfy_cli_command", lambda *args: ["comfy", *args])

    async def fake_run_command_stream(command, cwd, timeout=1800, on_line=None):
        calls.append((command, cwd, timeout))
        return {
            "stdout": json.dumps(
                {
                    "schema": "envelope/1",
                    "type": "envelope",
                    "ok": True,
                    "command": "env",
                    "version": "1.11.1",
                    "where": None,
                    "data": {"python": {"version": "3.13.12"}},
                    "error": None,
                }
            ),
            "stderr": "",
        }

    monkeypatch.setattr(manager_api, "run_command_stream", fake_run_command_stream)

    result = asyncio.run(manager_api.show_environment_with_comfy_cli())

    assert calls == [(["comfy", "--json", "env"], manager_api.COMFYUI_ROOT, 120)]
    assert result["provider"] == "comfy-cli"
    assert result["cli"]["version"] == "1.11.1"
    assert result["environment"] == {"python": {"version": "3.13.12"}}


def test_restore_snapshot_with_comfy_cli_uses_comfy_command(monkeypatch, tmp_path):
    calls = []
    snapshot_dir = tmp_path / "__manager" / "snapshots"
    snapshot_dir.mkdir(parents=True)
    (snapshot_dir / "snapshot-a.json").write_text("{}", encoding="utf-8")

    monkeypatch.setattr(manager_api, "COMFYUI_USER_DIR", tmp_path)
    monkeypatch.setattr(manager_api, "comfy_cli_command", lambda *args: ["comfy", *args])

    async def fake_run_command_stream(command, cwd, timeout=1800, on_line=None):
        calls.append((command, cwd, timeout))
        return {"stdout": "restored", "stderr": ""}

    monkeypatch.setattr(manager_api, "run_command_stream", fake_run_command_stream)

    result = asyncio.run(manager_api.restore_snapshot_with_comfy_cli("snapshot-a"))

    assert calls == [(["comfy", "node", "restore-snapshot", "snapshot-a"], manager_api.COMFYUI_ROOT, 3600)]
    assert result["provider"] == "comfy-cli"
    assert result["restart_required"] is True
    assert result["snapshot"] == "snapshot-a"


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


def test_restart_comfyui_schedules_local_restart(monkeypatch):
    calls = []

    def fake_schedule_restart():
        calls.append("scheduled")

    monkeypatch.setattr(manager_api, "schedule_restart", fake_schedule_restart)
    monkeypatch.setattr(manager_api, "clear_terminal_for_restart", lambda: calls.append("cleared"))
    monkeypatch.delenv("__COMFY_CLI_SESSION__", raising=False)

    result = asyncio.run(manager_api.restart_comfyui(SimpleNamespace()))

    assert calls == ["cleared", "scheduled"]
    assert result["provider"] == "local-restart"
    assert result["message"] == "Local ComfyUI restart was scheduled."


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


def test_manager_cache_filename_uses_channel_url_hash(monkeypatch):
    calls = []
    filename = "custom-node-list.json"
    channel_url = "https://raw.githubusercontent.com/Comfy-Org/ComfyUI-Manager/main"

    def fake_hash(value):
        calls.append(value)
        return 42

    monkeypatch.setattr(manager_api, "manager_cache_key_hash", fake_hash)

    assert manager_api.manager_cache_filename(channel_url, filename) == "42_custom-node-list.json"
    assert calls == ["https://raw.githubusercontent.com/Comfy-Org/ComfyUI-Manager/main/custom-node-list.json"]


def test_manager_url_cache_filename_uses_full_url_hash(monkeypatch):
    calls = []

    def fake_hash(value):
        calls.append(value)
        return 99

    monkeypatch.setattr(manager_api, "manager_cache_key_hash", fake_hash)

    assert manager_api.manager_url_cache_filename("https://api.comfy.org/nodes") == "99_nodes.json"
    assert calls == ["https://api.comfy.org/nodes"]


def test_read_manager_channel_url_falls_back_to_default(tmp_path):
    manager_dir = tmp_path / "__manager"
    manager_dir.mkdir()

    assert manager_api.read_manager_channel_url(manager_dir) == manager_api._DEFAULT_MANAGER_CHANNEL_URL


def test_read_manager_channel_url_reads_config(tmp_path):
    manager_dir = tmp_path / "__manager"
    manager_dir.mkdir()
    (manager_dir / "config.ini").write_text(
        "[default]\nchannel_url = https://cdn.jsdelivr.net/gh/Comfy-Org/ComfyUI-Manager@main\n",
        encoding="utf-8",
    )

    assert manager_api.read_manager_channel_url(manager_dir) == "https://cdn.jsdelivr.net/gh/Comfy-Org/ComfyUI-Manager@main"


def test_manager_repository_data_channel_defaults_to_jsdelivr(tmp_path):
    assert manager_api.read_manager_repository_data_channel(tmp_path) == "jsdelivr"
    assert manager_api.manager_repository_data_channel_url("github") == manager_api._DEFAULT_MANAGER_CHANNEL_URL
    assert manager_api.manager_repository_data_channel_url("jsdelivr") == manager_api._JSDELIVR_MANAGER_CHANNEL_URL


def test_set_manager_repository_data_channel_updates_override_channel_url(tmp_path):
    user_dir = tmp_path / "user"
    manager_dir = user_dir / "__manager"
    source_dir = user_dir / "__controlpanel" / "manager-cache" / "sources" / "github"
    manager_dir.mkdir(parents=True)
    source_dir.mkdir(parents=True)
    (source_dir / "custom-node-list.json").write_text(json.dumps({"custom_nodes": []}), encoding="utf-8")
    manager_api.write_controlpanel_settings({"manager_repository_data_override_enabled": True}, user_dir)

    result = manager_api.set_manager_repository_data_channel("github", user_dir=user_dir)

    assert result["channel"] == "github"
    assert manager_api.read_manager_repository_data_channel(user_dir) == "github"
    assert manager_api.read_manager_channel_url(manager_dir) == manager_api._DEFAULT_MANAGER_CHANNEL_URL


def test_set_manager_repository_override_forces_offline_and_records_internal_setting(tmp_path, monkeypatch):
    user_dir = tmp_path / "user"
    manager_dir = user_dir / "__manager"
    source_dir = user_dir / "__controlpanel" / "manager-cache" / "sources" / "jsdelivr"
    manager_dir.mkdir(parents=True)
    source_dir.mkdir(parents=True)
    (manager_dir / "config.ini").write_text(
        "[default]\nchannel_url = https://raw.githubusercontent.com/Comfy-Org/ComfyUI-Manager/main\nnetwork_mode = public\n",
        encoding="utf-8",
    )
    (source_dir / "custom-node-list.json").write_text(json.dumps({"custom_nodes": []}), encoding="utf-8")
    monkeypatch.setattr(manager_api, "_MANAGER_CACHE_FILES", ("custom-node-list.json",))
    result = manager_api.set_manager_repository_override(True, user_dir=user_dir)

    settings = manager_api.read_controlpanel_settings(user_dir)
    manager_path = manager_dir / "cache" / manager_api.manager_cache_filename(
        manager_api._JSDELIVR_MANAGER_CHANNEL_URL,
        "custom-node-list.json",
    )

    assert settings["manager_repository_data_override_enabled"] is True
    assert settings["manager_network_mode_before_override"] == "public"
    assert manager_api.read_manager_network_mode(manager_dir) == "offline"
    assert manager_api.read_manager_channel_url(manager_dir) == manager_api._JSDELIVR_MANAGER_CHANNEL_URL
    assert (manager_dir / "config_org.ini").exists()
    assert manager_path.exists()
    assert result["enabled"] is True


def test_set_manager_repository_override_disable_restores_original_manager_config(tmp_path):
    user_dir = tmp_path / "user"
    manager_dir = user_dir / "__manager"
    manager_dir.mkdir(parents=True)
    original_config = (
        "[default]\n"
        "channel_url = https://example.test/original-manager\n"
        "network_mode = public\n"
        "other_setting = keep-me\n"
    )
    (manager_dir / "config.ini").write_text(original_config, encoding="utf-8")

    manager_api.set_manager_repository_override(True, user_dir=user_dir)

    result = manager_api.set_manager_repository_override(False, user_dir=user_dir)

    settings = manager_api.read_controlpanel_settings(user_dir)
    assert settings["manager_repository_data_override_enabled"] is False
    assert "manager_network_mode_before_override" not in settings
    assert "manager_config_was_missing_before_override" not in settings
    assert manager_api.read_manager_network_mode(manager_dir) == "public"
    assert manager_api.read_manager_channel_url(manager_dir) == "https://example.test/original-manager"
    assert "other_setting = keep-me" in (manager_dir / "config.ini").read_text(encoding="utf-8")
    assert not (manager_dir / "config_org.ini").exists()
    assert result["enabled"] is False


def test_manager_repository_override_preserves_preexisting_offline_mode(tmp_path):
    user_dir = tmp_path / "user"
    manager_dir = user_dir / "__manager"
    manager_dir.mkdir(parents=True)
    manager_api.write_manager_network_mode(manager_dir, "offline")

    result = manager_api.set_manager_repository_override(True, user_dir=user_dir)
    disabled = manager_api.set_manager_repository_override(False, user_dir=user_dir)

    assert result["enabled"] is True
    assert disabled["enabled"] is False
    assert manager_api.read_manager_network_mode(manager_dir) == "offline"


def test_manager_repository_override_removes_generated_config_when_original_was_missing(tmp_path):
    user_dir = tmp_path / "user"
    manager_dir = user_dir / "__manager"
    manager_dir.mkdir(parents=True)

    manager_api.set_manager_repository_override(True, user_dir=user_dir)
    assert (manager_dir / "config.ini").exists()

    manager_api.set_manager_repository_override(False, user_dir=user_dir)

    assert not (manager_dir / "config.ini").exists()


def test_apply_startup_manager_repository_override_deploys_cached_sources(tmp_path, monkeypatch):
    user_dir = tmp_path / "user"
    manager_dir = user_dir / "__manager"
    source_dir = user_dir / "__controlpanel" / "manager-cache" / "sources" / "jsdelivr"
    manager_dir.mkdir(parents=True)
    source_dir.mkdir(parents=True)
    manager_api.write_controlpanel_settings({"manager_repository_data_override_enabled": True}, user_dir)
    (source_dir / "custom-node-list.json").write_text(json.dumps({"custom_nodes": [{"title": "Cached"}]}), encoding="utf-8")
    (source_dir / manager_api._COMFY_REGISTRY_NODES_CACHE_FILENAME).write_text(
        json.dumps({"nodes": [{"id": "registry-node", "latest_version": {"version": "1.0.0"}}]}),
        encoding="utf-8",
    )
    monkeypatch.setattr(manager_api, "_MANAGER_CACHE_FILES", ("custom-node-list.json",))

    result = manager_api.apply_startup_manager_repository_override(user_dir=user_dir)

    manager_path = manager_dir / "cache" / manager_api.manager_cache_filename(
        manager_api._JSDELIVR_MANAGER_CHANNEL_URL,
        "custom-node-list.json",
    )
    registry_manager_path = manager_dir / "cache" / manager_api.manager_url_cache_filename(
        manager_api._COMFY_REGISTRY_NODES_URL
    )
    assert result["enabled"] is True
    assert manager_api.read_manager_network_mode(manager_dir) == "offline"
    assert manager_api.read_manager_channel_url(manager_dir) == manager_api._JSDELIVR_MANAGER_CHANNEL_URL
    assert json.loads(manager_path.read_text(encoding="utf-8")) == {"custom_nodes": [{"title": "Cached"}]}
    assert json.loads(registry_manager_path.read_text(encoding="utf-8")) == {
        "nodes": [{"id": "registry-node", "latest_version": {"version": "1.0.0"}}],
        "page": 1,
        "total": 1,
        "totalPages": 1,
    }


def test_schedule_startup_manager_cache_refresh_skips_when_override_disabled(tmp_path):
    result = manager_api.schedule_startup_manager_cache_refresh(user_dir=tmp_path)

    assert result["scheduled"] is False
    assert result["skipped"] == "Manager repository data override is disabled."


def test_schedule_startup_manager_cache_refresh_uses_running_event_loop(tmp_path, monkeypatch):
    user_dir = tmp_path / "user"
    manager_api.write_controlpanel_settings({"manager_repository_data_override_enabled": True}, user_dir)
    calls = []

    async def fake_refresh_manager_cache_from_cdn(on_line=None, *, user_dir=None, max_age_seconds=0):
        calls.append(user_dir)
        if on_line:
            on_line("refresh ran")
        return {"provider": "fake"}

    monkeypatch.setattr(manager_api, "refresh_manager_cache_from_cdn", fake_refresh_manager_cache_from_cdn)

    async def run_scenario():
        result = manager_api.schedule_startup_manager_cache_refresh(user_dir=user_dir)
        await asyncio.sleep(0)
        return result

    result = asyncio.run(run_scenario())

    assert result["scheduled"] is True
    assert result["runner"] == "event-loop"
    assert calls == [user_dir]


def test_is_cache_file_fresh_uses_mtime(tmp_path):
    cache_file = tmp_path / "custom-node-list.json"
    cache_file.write_text("{}", encoding="utf-8")

    assert manager_api.is_cache_file_fresh(cache_file, max_age_seconds=86400)

    old_time = time.time() - 90000
    os.utime(cache_file, (old_time, old_time))

    assert not manager_api.is_cache_file_fresh(cache_file, max_age_seconds=86400)


def test_refresh_manager_cache_skips_when_manager_dir_is_missing(tmp_path):
    result = asyncio.run(manager_api.refresh_manager_cache_from_cdn(user_dir=tmp_path))

    assert result["skipped"] == "ComfyUI Manager user directory was not found."
    assert result["manager_dir"] == str(tmp_path / "__manager")


def test_refresh_manager_cache_skips_when_refresh_is_already_running(tmp_path):
    logs = []
    acquired = manager_api._MANAGER_CACHE_REFRESH_LOCK.acquire(blocking=False)
    assert acquired
    try:
        result = asyncio.run(manager_api.refresh_manager_cache_from_cdn(logs.append, user_dir=tmp_path))
    finally:
        manager_api._MANAGER_CACHE_REFRESH_LOCK.release()

    assert result["skipped"] == "Manager cache refresh is already running."
    assert result["manager_dir"] == str(tmp_path / "__manager")
    assert logs == ["Manager cache refresh is already running."]


def test_refresh_manager_cache_fetches_jsdelivr_and_writes_manager_cache(monkeypatch, tmp_path):
    requested_urls = []

    class FakeResponse:
        status = 200

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def text(self):
            return json.dumps({"custom_nodes": []})

    class FakeSession:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        def get(self, url):
            requested_urls.append(url)
            return FakeResponse()

    user_dir = tmp_path / "user"
    manager_dir = user_dir / "__manager"
    manager_dir.mkdir(parents=True)
    (manager_dir / "config.ini").write_text(
        "[default]\nchannel_url = https://raw.githubusercontent.com/Comfy-Org/ComfyUI-Manager/main\n",
        encoding="utf-8",
    )

    monkeypatch.setattr(manager_api, "_MANAGER_CACHE_FILES", ("custom-node-list.json",))
    monkeypatch.setattr(manager_api, "ClientSession", FakeSession)

    async def fake_refresh_registry(session, source_dir, on_line=None, channel=None):
        (source_dir / manager_api._COMFY_REGISTRY_NODES_CACHE_FILENAME).write_text(
            json.dumps({"nodes": [{"id": "registry-node", "latest_version": {"version": "1.0.0"}}]}),
            encoding="utf-8",
        )
        return {"file": "registry-node-list.json", "action": "skipped"}

    monkeypatch.setattr(manager_api, "refresh_comfy_registry_nodes_cache", fake_refresh_registry)

    result = asyncio.run(manager_api.refresh_manager_cache_from_cdn(user_dir=user_dir))

    source_path = user_dir / "__controlpanel" / "manager-cache" / "sources" / "jsdelivr" / "custom-node-list.json"
    manager_path = manager_dir / "cache" / manager_api.manager_cache_filename(
        "https://raw.githubusercontent.com/Comfy-Org/ComfyUI-Manager/main",
        "custom-node-list.json",
    )

    assert requested_urls == [
        "https://cdn.jsdelivr.net/gh/Comfy-Org/ComfyUI-Manager@main/custom-node-list.json"
    ]
    assert source_path.exists()
    assert manager_path.exists()
    registry_manager_path = manager_dir / "cache" / manager_api.manager_url_cache_filename(
        manager_api._COMFY_REGISTRY_NODES_URL
    )
    assert json.loads(registry_manager_path.read_text(encoding="utf-8")) == {
        "nodes": [{"id": "registry-node", "latest_version": {"version": "1.0.0"}}],
        "page": 1,
        "total": 1,
        "totalPages": 1,
    }
    assert json.loads(manager_path.read_text(encoding="utf-8")) == {"custom_nodes": []}
    assert result["registry_manager_cache"]["action"] == "deployed"
    assert result["results"][0]["action"] == "updated"


def test_refresh_manager_cache_fetches_github_raw_when_channel_selected(monkeypatch, tmp_path):
    requested_urls = []

    class FakeResponse:
        status = 200

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def text(self):
            return json.dumps({"custom_nodes": []})

    class FakeSession:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        def get(self, url):
            requested_urls.append(url)
            return FakeResponse()

    user_dir = tmp_path / "user"
    manager_dir = user_dir / "__manager"
    manager_dir.mkdir(parents=True)
    manager_api.write_controlpanel_settings({"manager_repository_data_channel": "github"}, user_dir)

    monkeypatch.setattr(manager_api, "_MANAGER_CACHE_FILES", ("custom-node-list.json",))
    monkeypatch.setattr(manager_api, "ClientSession", FakeSession)

    async def fake_refresh_registry(session, source_dir, on_line=None, channel=None):
        (source_dir / manager_api._COMFY_REGISTRY_NODES_CACHE_FILENAME).write_text(
            json.dumps({"nodes": []}),
            encoding="utf-8",
        )
        return {"file": "registry-node-list.json", "action": "skipped"}

    monkeypatch.setattr(manager_api, "refresh_comfy_registry_nodes_cache", fake_refresh_registry)

    result = asyncio.run(manager_api.refresh_manager_cache_from_cdn(user_dir=user_dir))

    assert requested_urls == [
        "https://raw.githubusercontent.com/Comfy-Org/ComfyUI-Manager/main/custom-node-list.json"
    ]
    assert result["provider"] == "github"
    assert result["repository_data_channel"] == "github"
    assert (user_dir / "__controlpanel" / "manager-cache" / "sources" / "github" / "custom-node-list.json").exists()


def test_refresh_manager_cache_uses_fresh_source_without_fetching(monkeypatch, tmp_path):
    user_dir = tmp_path / "user"
    manager_dir = user_dir / "__manager"
    source_dir = user_dir / "__controlpanel" / "manager-cache" / "sources" / "jsdelivr"
    manager_dir.mkdir(parents=True)
    source_dir.mkdir(parents=True)
    (source_dir / "custom-node-list.json").write_text(json.dumps({"custom_nodes": []}), encoding="utf-8")

    class FailSession:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        def get(self, _url):
            raise AssertionError("fresh Manager cache should not fetch")

    monkeypatch.setattr(manager_api, "_MANAGER_CACHE_FILES", ("custom-node-list.json",))
    monkeypatch.setattr(manager_api, "ClientSession", FailSession)

    async def fake_refresh_registry(session, source_dir, on_line=None, channel=None):
        (source_dir / manager_api._COMFY_REGISTRY_NODES_CACHE_FILENAME).write_text(
            json.dumps({"nodes": []}),
            encoding="utf-8",
        )
        return {"file": "registry-node-list.json", "action": "skipped"}

    monkeypatch.setattr(manager_api, "refresh_comfy_registry_nodes_cache", fake_refresh_registry)

    result = asyncio.run(manager_api.refresh_manager_cache_from_cdn(user_dir=user_dir))

    assert result["results"][0]["action"] == "deployed"
    manager_path = manager_dir / "cache" / manager_api.manager_cache_filename(
        manager_api._DEFAULT_MANAGER_CHANNEL_URL,
        "custom-node-list.json",
    )
    assert manager_path.exists()


def test_rebuild_manager_cache_removes_existing_source_and_refetches(monkeypatch, tmp_path):
    requested_urls = []

    class FakeResponse:
        status = 200

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def text(self):
            return json.dumps({"custom_nodes": [{"name": "fresh"}]})

    class FakeSession:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        def get(self, url):
            requested_urls.append(url)
            return FakeResponse()

    user_dir = tmp_path / "user"
    manager_dir = user_dir / "__manager"
    source_dir = user_dir / "__controlpanel" / "manager-cache" / "sources" / "jsdelivr"
    manager_dir.mkdir(parents=True)
    source_dir.mkdir(parents=True)
    (source_dir / "custom-node-list.json").write_text(json.dumps({"custom_nodes": [{"name": "old"}]}), encoding="utf-8")
    (source_dir / "stale-extra.json").write_text("{}", encoding="utf-8")

    monkeypatch.setattr(manager_api, "_MANAGER_CACHE_FILES", ("custom-node-list.json",))
    monkeypatch.setattr(manager_api, "ClientSession", FakeSession)

    async def fake_refresh_registry(session, source_dir, on_line=None, channel=None):
        (source_dir / manager_api._COMFY_REGISTRY_NODES_CACHE_FILENAME).write_text(
            json.dumps({"nodes": []}),
            encoding="utf-8",
        )
        return {"file": "registry-node-list.json", "action": "rebuilt"}

    monkeypatch.setattr(manager_api, "refresh_comfy_registry_nodes_cache", fake_refresh_registry)

    result = asyncio.run(manager_api.rebuild_manager_cache_from_cdn(user_dir=user_dir))

    assert requested_urls == [
        "https://cdn.jsdelivr.net/gh/Comfy-Org/ComfyUI-Manager@main/custom-node-list.json"
    ]
    assert result["rebuilt"] is True
    assert result["max_age_seconds"] == 0
    assert not (source_dir / "stale-extra.json").exists()
    assert json.loads((source_dir / "custom-node-list.json").read_text(encoding="utf-8")) == {
        "custom_nodes": [{"name": "fresh"}]
    }


def test_registry_nodes_incremental_timestamp_uses_latest_node_date():
    timestamp = manager_api.registry_nodes_incremental_timestamp(
        {
            "nodes": [
                {"id": "old", "updated_at": "2026-07-01T00:00:00Z"},
                {"id": "new", "updatedAt": "2026-07-02T00:00:05Z"},
            ]
        }
    )

    assert timestamp == "2026-07-01T23:59:55Z"


def test_merge_registry_nodes_cache_replaces_updated_nodes():
    result = manager_api.merge_registry_nodes_cache(
        {"nodes": [{"id": "a", "name": "Old"}, {"id": "b", "name": "Keep"}]},
        {"nodes": [{"id": "a", "name": "New"}, {"id": "c", "name": "Added"}]},
    )

    assert result["nodes"] == [
        {"id": "a", "name": "New"},
        {"id": "b", "name": "Keep"},
        {"id": "c", "name": "Added"},
    ]
    assert result["total"] == 3


def test_deploy_registry_nodes_cache_to_manager_writes_api_url_cache(tmp_path):
    source_dir = tmp_path / "sources"
    manager_cache_dir = tmp_path / "manager-cache"
    source_dir.mkdir()
    manager_cache_dir.mkdir()
    source_data = {
        "nodes": [
            {"id": "node", "latest_version": {"version": "1.0.0"}},
            {"id": "missing-latest-version"},
            {"id": "missing-version", "latest_version": {}},
        ]
    }
    (source_dir / manager_api._COMFY_REGISTRY_NODES_CACHE_FILENAME).write_text(
        json.dumps(source_data),
        encoding="utf-8",
    )

    result = manager_api.deploy_registry_nodes_cache_to_manager(source_dir, manager_cache_dir)

    manager_path = manager_cache_dir / manager_api.manager_url_cache_filename(manager_api._COMFY_REGISTRY_NODES_URL)
    assert result["action"] == "deployed"
    assert result["source_url"] == "https://api.comfy.org/nodes"
    assert result["manager_cache_path"] == str(manager_path)
    assert result["filtered"] == 2
    assert json.loads(manager_path.read_text(encoding="utf-8")) == {
        "nodes": [{"id": "node", "latest_version": {"version": "1.0.0"}}],
        "page": 1,
        "total": 1,
        "totalPages": 1,
    }


def test_refresh_registry_nodes_cache_full_fetches_all_pages(monkeypatch, tmp_path):
    requested_urls = []
    metadata = {
        "comfyui_version": "0.3.50",
        "platform": "windows",
        "form_factor": "git-windows",
        "channel": "jsdelivr",
    }
    responses = [
        {"nodes": [{"id": "a", "updated_at": "2026-07-01T00:00:00Z"}], "totalPages": 2},
        {"nodes": [{"id": "b", "updated_at": "2026-07-02T00:00:00Z"}], "totalPages": 2},
    ]

    class FakeSession:
        def get(self, url):
            requested_urls.append(url)

            class FakeResponse:
                status = 200

                async def __aenter__(self):
                    return self

                async def __aexit__(self, *_args):
                    return None

                async def text(self):
                    return json.dumps(responses.pop(0))

            return FakeResponse()

    monkeypatch.setattr(manager_api, "_current_registry_cache_metadata", lambda: metadata)
    monkeypatch.setattr(manager_api.time, "time", lambda: 1000.0)

    result = asyncio.run(manager_api.refresh_comfy_registry_nodes_cache(FakeSession(), tmp_path))

    data = json.loads((tmp_path / manager_api._COMFY_REGISTRY_NODES_CACHE_FILENAME).read_text(encoding="utf-8"))
    expected_metadata = {
        **metadata,
        "created_at": "1970-01-01T00:16:40Z",
        "updated_at": "1970-01-01T00:16:40Z",
    }
    assert result["action"] == "updated"
    assert result["cache_metadata"] == expected_metadata
    assert data["cache_metadata"] == expected_metadata
    assert data["nodes"] == [
        {"id": "a", "updated_at": "2026-07-01T00:00:00Z"},
        {"id": "b", "updated_at": "2026-07-02T00:00:00Z"},
    ]
    assert requested_urls == [
        "https://api.comfy.org/nodes?limit=30&form_factor=git-windows&comfyui_version=0.3.50&page=1",
        "https://api.comfy.org/nodes?limit=30&form_factor=git-windows&comfyui_version=0.3.50&page=2",
    ]


def test_refresh_registry_nodes_cache_incremental_merges_timestamped_updates(monkeypatch, tmp_path):
    cache_path = tmp_path / manager_api._COMFY_REGISTRY_NODES_CACHE_FILENAME
    metadata = {
        "comfyui_version": None,
        "platform": "freebsd",
        "form_factor": "git-linux",
        "channel": "github",
    }
    cached_metadata = {
        "comfyui_version": None,
        "platform": "linux",
        "form_factor": "git-linux",
        "channel": "github",
        "created_at": "2026-07-01T00:00:00Z",
        "updated_at": "2026-07-01T01:00:00Z",
    }
    cache_path.write_text(
        json.dumps(
            {
                "cache_metadata": cached_metadata,
                "nodes": [
                    {"id": "a", "name": "Old", "updated_at": "2026-07-01T00:00:00Z"},
                    {"id": "b", "name": "Keep", "updated_at": "2026-07-02T00:00:05Z"},
                ]
            }
        ),
        encoding="utf-8",
    )
    requested_urls = []

    class FakeSession:
        def get(self, url):
            requested_urls.append(url)

            class FakeResponse:
                status = 200

                async def __aenter__(self):
                    return self

                async def __aexit__(self, *_args):
                    return None

                async def text(self):
                    return json.dumps({"nodes": [{"id": "b", "name": "New"}], "totalPages": 1})

            return FakeResponse()

    monkeypatch.setattr(manager_api, "_current_registry_cache_metadata", lambda: metadata)
    monkeypatch.setattr(manager_api.time, "time", lambda: 2000.0)

    result = asyncio.run(manager_api.refresh_comfy_registry_nodes_cache(FakeSession(), tmp_path))

    data = json.loads(cache_path.read_text(encoding="utf-8"))
    expected_metadata = {
        **metadata,
        "created_at": "2026-07-01T00:00:00Z",
        "updated_at": "1970-01-01T00:33:20Z",
    }
    assert result["action"] == "incremental"
    assert result["timestamp"] == "2026-07-01T23:59:55Z"
    assert result["cache_metadata"] == expected_metadata
    assert data["cache_metadata"] == expected_metadata
    assert data["nodes"] == [
        {"id": "a", "name": "Old", "updated_at": "2026-07-01T00:00:00Z"},
        {"id": "b", "name": "New"},
    ]
    assert requested_urls == [
        "https://api.comfy.org/nodes?limit=30&form_factor=git-linux&timestamp=2026-07-01T23%3A59%3A55Z&page=1"
    ]


def test_refresh_registry_nodes_cache_invalidates_when_metadata_changes(monkeypatch, tmp_path):
    cache_path = tmp_path / manager_api._COMFY_REGISTRY_NODES_CACHE_FILENAME
    current_metadata = {
        "comfyui_version": "0.3.51",
        "platform": "windows",
        "form_factor": "git-windows",
        "channel": "jsdelivr",
    }
    cache_path.write_text(
        json.dumps(
            {
                "cache_metadata": {
                    "comfyui_version": "0.3.50",
                    "platform": "windows",
                    "form_factor": "git-windows",
                    "channel": "jsdelivr",
                    "created_at": "2026-07-01T00:00:00Z",
                    "updated_at": "2026-07-01T01:00:00Z",
                },
                "nodes": [{"id": "old", "updated_at": "2026-07-01T00:00:00Z"}],
            }
        ),
        encoding="utf-8",
    )
    requested_urls = []

    class FakeSession:
        def get(self, url):
            requested_urls.append(url)

            class FakeResponse:
                status = 200

                async def __aenter__(self):
                    return self

                async def __aexit__(self, *_args):
                    return None

                async def text(self):
                    return json.dumps({"nodes": [{"id": "new"}], "totalPages": 1})

            return FakeResponse()

    monkeypatch.setattr(manager_api, "_current_registry_cache_metadata", lambda: current_metadata)
    monkeypatch.setattr(manager_api.time, "time", lambda: 3000.0)

    result = asyncio.run(manager_api.refresh_comfy_registry_nodes_cache(FakeSession(), tmp_path))

    data = json.loads(cache_path.read_text(encoding="utf-8"))
    expected_metadata = {
        **current_metadata,
        "created_at": "1970-01-01T00:50:00Z",
        "updated_at": "1970-01-01T00:50:00Z",
    }
    assert result["action"] == "invalidated"
    assert result["timestamp"] is None
    assert result["cache_metadata"] == expected_metadata
    assert data["cache_metadata"] == expected_metadata
    assert data["nodes"] == [{"id": "new"}]
    assert requested_urls == [
        "https://api.comfy.org/nodes?limit=30&form_factor=git-windows&comfyui_version=0.3.51&page=1"
    ]


def test_refresh_registry_nodes_cache_invalidates_when_channel_changes(monkeypatch, tmp_path):
    cache_path = tmp_path / manager_api._COMFY_REGISTRY_NODES_CACHE_FILENAME
    current_metadata = {
        "comfyui_version": None,
        "platform": "windows",
        "form_factor": "git-windows",
        "channel": "github",
    }
    cache_path.write_text(
        json.dumps(
            {
                "cache_metadata": {
                    "comfyui_version": None,
                    "platform": "windows",
                    "form_factor": "git-windows",
                    "channel": "jsdelivr",
                    "created_at": "2026-07-01T00:00:00Z",
                    "updated_at": "2026-07-01T01:00:00Z",
                },
                "nodes": [{"id": "old", "updated_at": "2026-07-01T00:00:00Z"}],
            }
        ),
        encoding="utf-8",
    )

    class FakeSession:
        def get(self, _url):
            class FakeResponse:
                status = 200

                async def __aenter__(self):
                    return self

                async def __aexit__(self, *_args):
                    return None

                async def text(self):
                    return json.dumps({"nodes": [{"id": "new"}], "totalPages": 1})

            return FakeResponse()

    monkeypatch.setattr(manager_api, "_current_registry_cache_metadata", lambda: current_metadata)
    monkeypatch.setattr(manager_api.time, "time", lambda: 4000.0)

    result = asyncio.run(manager_api.refresh_comfy_registry_nodes_cache(FakeSession(), tmp_path))

    data = json.loads(cache_path.read_text(encoding="utf-8"))
    assert result["action"] == "invalidated"
    assert result["timestamp"] is None
    assert data["cache_metadata"]["channel"] == "github"
    assert data["nodes"] == [{"id": "new"}]


def test_fetch_registry_nodes_pages_logs_every_tenth_page_and_completion(monkeypatch):
    requested_urls = []
    logs = []

    class FakeSession:
        def get(self, url):
            requested_urls.append(url)
            page = len(requested_urls)

            class FakeResponse:
                status = 200

                async def __aenter__(self):
                    return self

                async def __aexit__(self, *_args):
                    return None

                async def text(self):
                    return json.dumps(
                        {
                            "nodes": [{"id": f"{page}-{index}"} for index in range(30)],
                            "totalPages": 21,
                        }
                    )

            return FakeResponse()

    metadata = {
        "comfyui_version": None,
        "platform": "linux",
        "form_factor": "git-linux",
    }

    result = asyncio.run(
        manager_api.fetch_registry_nodes_pages(FakeSession(), metadata=metadata, on_line=logs.append)
    )

    assert result["totalPages"] == 21
    assert result["total"] == 630
    assert len(requested_urls) == 21
    assert logs == [
        "Updating ComfyRegistry nodes (10/21)",
        "Updating ComfyRegistry nodes (20/21)",
        "Updating ComfyRegistry nodes (21/21)",
    ]


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


def test_restart_current_process_execs_active_python_command(monkeypatch, capsys):
    calls = []
    original_argv = ["C:/Users/alyac/AppData/Roaming/uv/python/cpython-3.13/python.exe", "main.py", "--listen", "0.0.0.0"]

    def fake_execv(path, args):
        calls.append((path, args))

    monkeypatch.setattr(manager_api.sys, "executable", "V:/ComfyUI/portable_260706/.venv/Scripts/python.exe")
    monkeypatch.setattr(manager_api.sys, "orig_argv", original_argv, raising=False)
    monkeypatch.setattr(manager_api.sys, "argv", ["main.py", "--listen", "0.0.0.0"], raising=False)
    monkeypatch.setattr(manager_api.os, "execv", fake_execv)

    manager_api.restart_current_process()

    assert calls == [
        (
            "V:/ComfyUI/portable_260706/.venv/Scripts/python.exe",
            ["V:/ComfyUI/portable_260706/.venv/Scripts/python.exe", "main.py", "--listen", "0.0.0.0"],
        )
    ]
    assert "Restarting..." in capsys.readouterr().out


def test_restart_exec_args_uses_active_python_and_current_argv(monkeypatch):
    monkeypatch.setattr(manager_api.sys, "executable", "C:/Python/python.exe")
    monkeypatch.setattr(manager_api.sys, "orig_argv", ["C:/Base/python.exe", "main.py"], raising=False)
    monkeypatch.setattr(manager_api.sys, "argv", ["main.py", "--listen"], raising=False)

    assert manager_api.restart_exec_args() == ["C:/Python/python.exe", "main.py", "--listen"]
