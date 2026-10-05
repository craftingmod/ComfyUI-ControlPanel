import asyncio
import json
import os
import sys
import time
from types import SimpleNamespace

import pytest

from backend import manager_api, manager_jobs


def test_corrupt_registry_db_startup_deployment_keeps_existing_manager_cache(tmp_path):
  source_dir = tmp_path / "sources"
  source_dir.mkdir()
  manager_cache_dir = tmp_path / "manager-cache"
  manager_cache_dir.mkdir()
  manager_api.registry_cache_path(source_dir).write_bytes(b"invalid sqlite")
  manager_path = manager_cache_dir / manager_api.manager_url_cache_filename(
    manager_api._COMFY_REGISTRY_NODES_URL
  )
  manager_path.write_text('{"nodes":[{"id":"keep"}]}', encoding="utf-8")
  result = manager_api.deploy_registry_nodes_cache_to_manager(
    source_dir, manager_cache_dir
  )
  assert result["action"] == "missing"
  assert json.loads(manager_path.read_text(encoding="utf-8"))["nodes"] == [
    {"id": "keep"}
  ]


@pytest.mark.parametrize("disable_after_first", [False, True])
def test_startup_refresh_runs_hourly_and_checks_override_setting(
  tmp_path, monkeypatch, disable_after_first
):
  manager_api.write_controlpanel_settings(
    {"manager_repository_data_override_enabled": True}, tmp_path
  )
  calls, waits = [], []
  original_sleep = asyncio.sleep

  async def scenario():
    completed = asyncio.Event()

    async def refresh(on_line=None, *, user_dir=None, max_age_seconds=0):
      calls.append(user_dir)
      if disable_after_first:
        manager_api.write_controlpanel_settings(
          {"manager_repository_data_override_enabled": False}, tmp_path
        )
      return {"provider": "fake"}

    async def sleep(seconds):
      waits.append(seconds)
      if len(waits) == 2:
        completed.set()
        raise asyncio.CancelledError
      await original_sleep(0)

    monkeypatch.setattr(manager_api, "refresh_manager_cache_from_cdn", refresh)
    monkeypatch.setattr(manager_api.asyncio, "sleep", sleep)
    manager_api.schedule_startup_manager_cache_refresh(user_dir=tmp_path)
    await completed.wait()

  asyncio.run(scenario())
  assert calls == [tmp_path] * (1 if disable_after_first else 2)
  assert waits == [3600, 3600]


def test_resolve_comfyui_root_prefers_comfyui_path_env(monkeypatch, tmp_path):
  configured_root = tmp_path / "ConfiguredComfyUI"
  monkeypatch.setenv("COMFYUI_PATH", str(configured_root))

  assert manager_api.resolve_comfyui_root() == configured_root.resolve()


def test_resolve_comfyui_root_uses_folder_paths_when_env_is_missing(
  monkeypatch, tmp_path
):
  comfyui_root = tmp_path / "RuntimeComfyUI"
  fake_folder_paths = SimpleNamespace(
    base_path=str(comfyui_root),
  )
  monkeypatch.delenv("COMFYUI_PATH", raising=False)
  monkeypatch.setitem(sys.modules, "folder_paths", fake_folder_paths)

  assert manager_api.resolve_comfyui_root() == comfyui_root.resolve()


def test_resolve_custom_nodes_dir_uses_comfyui_root_child(tmp_path):
  comfyui_root = tmp_path / "RuntimeComfyUI"

  assert (
    manager_api.resolve_custom_nodes_dir(comfyui_root)
    == (comfyui_root / "custom_nodes").resolve()
  )


def test_control_request_allows_loopback_clients(monkeypatch):
  monkeypatch.setattr(
    manager_api, "read_controlpanel_settings", lambda user_dir=None: {}
  )

  assert (
    manager_api.is_control_request_allowed(
      SimpleNamespace(remote="127.0.0.1", host="127.0.0.1:8188")
    )
    is True
  )
  assert (
    manager_api.is_control_request_allowed(
      SimpleNamespace(remote="::1", host="[::1]:8188")
    )
    is True
  )
  assert (
    manager_api.is_control_request_allowed(
      SimpleNamespace(remote="localhost", host="localhost:8188")
    )
    is True
  )


@pytest.mark.parametrize(
  "host",
  [
    "example.com",
    "127.0.0.1.example.com",
    "",
    "localhost:invalid",
    "localhost/path",
    "localhost?x",
    "localhost#x",
  ],
)
def test_control_request_rejects_non_loopback_or_invalid_host(monkeypatch, host):
  monkeypatch.setattr(
    manager_api, "read_controlpanel_settings", lambda user_dir=None: {}
  )

  assert (
    manager_api.is_control_request_allowed(
      SimpleNamespace(remote="127.0.0.1", host=host)
    )
    is False
  )


def test_control_request_rejects_remote_clients_by_default(monkeypatch):
  monkeypatch.setattr(
    manager_api, "read_controlpanel_settings", lambda user_dir=None: {}
  )

  assert (
    manager_api.is_control_request_allowed(
      SimpleNamespace(remote="192.168.0.10", host="localhost:8188")
    )
    is False
  )


def test_control_request_allows_remote_clients_when_configured(monkeypatch):
  monkeypatch.setattr(
    manager_api,
    "read_controlpanel_settings",
    lambda user_dir=None: {"allow_remote_control": True},
  )

  assert (
    manager_api.is_control_request_allowed(SimpleNamespace(remote="192.168.0.10"))
    is True
  )


def test_same_origin_allows_local_post_and_local_tools_without_origin():
  browser_request = SimpleNamespace(
    method="POST",
    remote="127.0.0.1",
    scheme="http",
    host="localhost:8188",
    headers={"Origin": "http://localhost:8188"},
  )
  cli_request = SimpleNamespace(method="POST", remote="127.0.0.1", headers={})

  assert manager_api.is_same_origin_request(browser_request) is True
  assert manager_api.is_same_origin_request(cli_request) is True


def test_same_origin_rejects_cross_origin_and_remote_requests_without_origin():
  cross_origin = SimpleNamespace(
    method="POST",
    remote="127.0.0.1",
    scheme="http",
    host="localhost:8188",
    headers={"Origin": "https://example.com"},
  )
  remote_without_origin = SimpleNamespace(
    method="POST", remote="192.168.0.10", headers={}
  )

  assert manager_api.is_same_origin_request(cross_origin) is False
  assert manager_api.is_same_origin_request(remote_without_origin) is False


def test_same_origin_allows_remote_browser_when_origin_matches():
  request = SimpleNamespace(
    method="POST",
    remote="192.168.0.10",
    scheme="https",
    host="comfy.example.com",
    headers={"Origin": "https://comfy.example.com"},
  )

  assert manager_api.is_same_origin_request(request) is True


@pytest.mark.parametrize(
  ("level", "middle_allowed", "high_local_allowed", "high_remote_allowed"),
  [
    ("strong", False, False, False),
    ("normal", True, False, False),
    ("normal-", True, True, False),
    ("weak", True, True, True),
  ],
)
def test_manager_security_level_policy(
  monkeypatch, level, middle_allowed, high_local_allowed, high_remote_allowed
):
  monkeypatch.setattr(
    manager_api, "manager_security_config_available", lambda user_dir=None: True
  )
  monkeypatch.setattr(
    manager_api, "read_manager_security_level", lambda user_dir=None: level
  )

  assert (
    manager_api.is_manager_operation_allowed(
      SimpleNamespace(remote="127.0.0.1"), "middle"
    )
    is middle_allowed
  )
  assert (
    manager_api.is_manager_operation_allowed(
      SimpleNamespace(remote="127.0.0.1"), "high"
    )
    is high_local_allowed
  )
  assert (
    manager_api.is_manager_operation_allowed(
      SimpleNamespace(remote="192.168.0.10"), "high"
    )
    is high_remote_allowed
  )


def test_manager_security_defaults_apply_when_config_exists(monkeypatch):
  monkeypatch.setattr(
    manager_api.manager_settings,
    "read_manager_config_value",
    lambda manager_dir, option: None,
  )

  assert manager_api.read_manager_security_level() == "normal"
  assert manager_api.read_manager_boolean("allow_git_url_install") is False


@pytest.mark.parametrize("policy", ["middle", "high", "git-url"])
def test_manager_policy_is_skipped_when_config_is_absent(monkeypatch, policy):
  monkeypatch.setattr(
    manager_api, "manager_security_config_available", lambda user_dir=None: False
  )

  assert (
    manager_api.is_manager_operation_allowed(
      SimpleNamespace(remote="192.168.0.10"), policy
    )
    is True
  )


def test_manager_git_url_policy_requires_explicit_true(monkeypatch):
  monkeypatch.setattr(
    manager_api, "manager_security_config_available", lambda user_dir=None: True
  )
  monkeypatch.setattr(
    manager_api,
    "read_manager_boolean",
    lambda option, user_dir=None: option == "allowed",
  )

  assert manager_api.is_manager_operation_allowed(SimpleNamespace(), "git-url") is False

  monkeypatch.setattr(
    manager_api,
    "read_manager_boolean",
    lambda option, user_dir=None: option == "allow_git_url_install",
  )

  assert manager_api.is_manager_operation_allowed(SimpleNamespace(), "git-url") is True


def test_manifest_requires_git_url_install_only_for_nonempty_git_nodes():
  assert manager_api.manifest_requires_git_url_install(
    {"git_nodes": [{"url": "https://example.com/node.git"}]}
  )
  assert not manager_api.manifest_requires_git_url_install({"git_nodes": []})
  assert not manager_api.manifest_requires_git_url_install(
    {"registry_nodes": [{"id": "example"}]}
  )


def test_warn_if_remote_control_enabled_logs_security_warning(monkeypatch, caplog):
  monkeypatch.setattr(
    manager_api,
    "read_controlpanel_settings",
    lambda user_dir=None: {"allow_remote_control": True},
  )

  with caplog.at_level("WARNING", logger=manager_api.LOGGER.name):
    result = manager_api.warn_if_remote_control_enabled()

  assert result["enabled"] is True
  assert "allow_remote_control is enabled" in caplog.text
  assert "[ControlPanel][SECURITY WARNING]" in caplog.text


def test_control_request_denied_response_logs_blocked_remote(monkeypatch, caplog):
  monkeypatch.setattr(
    manager_api, "read_controlpanel_settings", lambda user_dir=None: {}
  )

  with caplog.at_level("WARNING", logger=manager_api.LOGGER.name):
    response = manager_api.control_request_denied_response(
      SimpleNamespace(
        remote="192.168.0.10", host="localhost:8188", path="/control-panel/status"
      )
    )

  assert response.status == 403
  assert "Blocked remote control request from 192.168.0.10" in caplog.text


def test_control_request_denied_response_reports_non_loopback_host(monkeypatch, caplog):
  monkeypatch.setattr(
    manager_api, "read_controlpanel_settings", lambda user_dir=None: {}
  )

  with caplog.at_level("WARNING", logger=manager_api.LOGGER.name):
    response = manager_api.control_request_denied_response(
      SimpleNamespace(
        remote="127.0.0.1", host="comfy.example.com", path="/control-panel/status"
      )
    )

  assert response.status == 403
  assert "Blocked non-loopback Host" in caplog.text
  assert "loopback Host" in json.loads(response.text)["error"]


def test_control_request_denied_response_blocks_cross_origin_post(monkeypatch):
  monkeypatch.setattr(
    manager_api, "read_controlpanel_settings", lambda user_dir=None: {}
  )
  request = SimpleNamespace(
    method="POST",
    remote="127.0.0.1",
    host="localhost:8188",
    scheme="http",
    headers={"Origin": "https://example.com"},
  )

  response = manager_api.control_request_denied_response(request)

  assert response.status == 403
  assert "same-origin" in json.loads(response.text)["error"]


def test_control_request_denied_response_blocks_manager_policy(monkeypatch):
  monkeypatch.setattr(
    manager_api, "read_controlpanel_settings", lambda user_dir=None: {}
  )
  monkeypatch.setattr(
    manager_api, "is_manager_operation_allowed", lambda request, policy: False
  )
  request = SimpleNamespace(
    method="POST", remote="127.0.0.1", host="localhost:8188", headers={}
  )

  response = manager_api.control_request_denied_response(request, "middle")

  assert response.status == 403
  assert "security_level" in json.loads(response.text)["error"]


def test_open_path_in_file_manager_uses_windows_startfile(monkeypatch, tmp_path):
  calls = []

  monkeypatch.setattr(manager_api.manager_process.platform, "system", lambda: "Windows")
  monkeypatch.setattr(
    manager_api.manager_process.os,
    "startfile",
    lambda path: calls.append(path),
    raising=False,
  )

  result = manager_api.open_path_in_file_manager(tmp_path)

  assert calls == [str(tmp_path.resolve())]
  assert result["provider"] == "local-file-manager"
  assert result["path"] == str(tmp_path.resolve())
  assert result["command"] == ["os.startfile", str(tmp_path.resolve())]


def test_open_path_in_file_manager_uses_xdg_open_on_linux(monkeypatch, tmp_path):
  calls = []

  monkeypatch.setattr(manager_api.manager_process.platform, "system", lambda: "Linux")
  monkeypatch.setattr(
    manager_api.manager_process, "command_args", lambda *args: list(args)
  )
  monkeypatch.setattr(
    manager_api.manager_process.subprocess,
    "Popen",
    lambda command: calls.append(command),
  )

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
  (snapshot_dir / "2026-07-04_08-07-20_autosave.json").write_text(
    "{}", encoding="utf-8"
  )
  (snapshot_dir / "2026-07-05_08-07-20_snapshot.json").write_text(
    "{}", encoding="utf-8"
  )
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
  monkeypatch.setattr(
    manager_api,
    "list_manager_snapshots",
    lambda: {"snapshots": [], "snapshot_dir": "snapshots"},
  )

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

  assert calls == [
    (
      ["comfy", "node", "restore-snapshot", "snapshot-a"],
      manager_api.COMFYUI_ROOT,
      3600,
    )
  ]
  assert result["provider"] == "comfy-cli"
  assert result["restart_required"] is True
  assert result["snapshot"] == "snapshot-a"


def test_same_server_url_uses_current_request_host():
  request = SimpleNamespace(headers={"Host": "127.0.0.1:8188"}, scheme="http")

  assert (
    manager_api._same_server_url(request, "/manager/reboot")
    == "http://127.0.0.1:8188/manager/reboot"
  )


def test_manager_job_append_log_writes_python_log_without_job_label(caplog):
  job = manager_api.ManagerJob(id="job", kind="git-nodes", label="Update Git Nodes")

  with caplog.at_level("INFO", logger=manager_api.LOGGER.name):
    job.append_log("Updated ComfyUI-Test")

  assert job.logs == ["Updated ComfyUI-Test"]
  assert "[ControlPanel] Updated ComfyUI-Test" in caplog.text
  assert "Update Git Nodes: Updated ComfyUI-Test" not in caplog.text


def test_same_server_url_respects_forwarded_proto():
  request = SimpleNamespace(
    headers={"Host": "example.test", "X-Forwarded-Proto": "https"}, scheme="http"
  )

  assert (
    manager_api._same_server_url(request, "/manager/reboot")
    == "https://example.test/manager/reboot"
  )


def test_request_manager_update_comfyui_uses_v2_queue_route(monkeypatch):
  calls = []
  request = SimpleNamespace(headers={"Host": "127.0.0.1:8188"}, scheme="http")

  async def fake_request_manager_no_body_post(url, provider):
    calls.append((url, provider))
    return {"provider": provider, "status": 200, "message": ""}

  monkeypatch.setattr(
    manager_api, "request_manager_no_body_post", fake_request_manager_no_body_post
  )

  result = asyncio.run(manager_api.request_manager_update_comfyui(request))

  assert calls == [
    ("http://127.0.0.1:8188/v2/manager/queue/update_comfyui", "manager-rest")
  ]
  assert result["restart_required"] is True
  assert result["message"] == "ComfyUI update was queued through ComfyUI Manager."


def test_job_update_comfyui_uses_comfy_cli_updater(monkeypatch):
  calls = []
  job = manager_api.ManagerJob(id="job", kind="comfyui", label="Update ComfyUI")

  async def fake_update_comfyui_with_comfy_cli(on_line=None):
    calls.append("comfy-cli")
    if on_line:
      on_line("comfy-cli updater ran")
    return {"provider": "comfy-cli", "restart_required": True}

  async def fail_request_manager_update_comfyui(*_args, **_kwargs):
    raise AssertionError("ComfyUI Manager update route should not be used")

  monkeypatch.setattr(
    manager_api, "update_comfyui_with_comfy_cli", fake_update_comfyui_with_comfy_cli
  )
  monkeypatch.setattr(
    manager_api, "request_manager_update_comfyui", fail_request_manager_update_comfyui
  )

  result = asyncio.run(manager_api._job_update_comfyui(job))

  assert calls == ["comfy-cli"]
  assert result["provider"] == "comfy-cli"
  assert "latest version with Comfy CLI" in job.logs[0]
  assert "comfy-cli updater ran" in job.logs[1]


def test_repo_name_from_git_url_handles_common_url_shapes():
  assert (
    manager_api.repo_name_from_git_url("https://github.com/user/ComfyUI-Foo.git")
    == "ComfyUI-Foo"
  )
  assert (
    manager_api.repo_name_from_git_url("git@github.com:user/comfyui-bar.git")
    == "comfyui-bar"
  )


def test_validate_git_url_allows_https_without_credentials_only():
  for url in (
    "https://github.com/user/comfyui-test.git",
    "https://gitlab.com/group/comfyui-test.git",
    "https://git.example.test/group/comfyui-test",
  ):
    assert manager_api.validate_git_url(url) == url

  for url in (
    "https://x-access-token:ghp_secret@github.com/user/repo.git",
    "https://ghp_secret@github.com/user/repo.git",
    "https://github.com/user/repo.git?token=ghp_secret",
    "https://github.com/user/repo.git#ghp_secret",
    "http://github.com/user/repo.git",
    "ssh://git@github.com/user/repo.git",
    "git@github.com:user/repo.git",
    "file:///tmp/repo",
    "../outside",
  ):
    with pytest.raises(manager_api.ManagerApiError):
      manager_api.validate_git_url(url)


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

  result = asyncio.run(
    manager_api.install_git_url("https://github.com/user/comfyui-test.git")
  )

  assert calls == [
    (
      [
        "git",
        "clone",
        "https://github.com/user/comfyui-test.git",
        str(tmp_path / "comfyui-test"),
      ],
      tmp_path,
      600,
    )
  ]
  assert result["destination"] == str(tmp_path / "comfyui-test")


def test_install_git_url_checks_out_the_recorded_commit(monkeypatch, tmp_path):
  calls = []

  async def fake_run_command(args, cwd, timeout=600):
    calls.append((args, cwd, timeout))
    if args[:2] == ["git", "clone"]:
      os.makedirs(args[-1])
    return {"returncode": 0}

  monkeypatch.setattr(manager_api, "CUSTOM_NODES_DIR", tmp_path)
  monkeypatch.setattr(manager_api, "run_command", fake_run_command)

  result = asyncio.run(
    manager_api.install_git_url(
      "https://github.com/user/comfyui-test.git",
      commit="1111111111111111111111111111111111111111",
    )
  )

  destination = tmp_path / "comfyui-test"
  assert calls == [
    (
      [
        "git",
        "clone",
        "--no-checkout",
        "https://github.com/user/comfyui-test.git",
        str(destination),
      ],
      tmp_path,
      600,
    ),
    (
      ["git", "checkout", "--detach", "1111111111111111111111111111111111111111"],
      destination,
      600,
    ),
  ]
  assert result["destination"] == str(destination)


def test_install_git_url_removes_partial_clone_when_commit_checkout_fails(
  monkeypatch, tmp_path
):
  destination = tmp_path / "comfyui-test"

  async def fake_run_command(args, cwd, timeout=600):
    if args[:2] == ["git", "clone"]:
      destination.mkdir()
      return {"returncode": 0}
    raise manager_api.ManagerApiError("commit not found")

  monkeypatch.setattr(manager_api, "CUSTOM_NODES_DIR", tmp_path)
  monkeypatch.setattr(manager_api, "run_command", fake_run_command)

  with pytest.raises(manager_api.ManagerApiError, match="commit not found"):
    asyncio.run(
      manager_api.install_git_url(
        "https://github.com/user/comfyui-test.git",
        commit="1111111111111111111111111111111111111111",
      )
    )

  assert not destination.exists()


def test_manager_cache_filename_uses_channel_url_hash(monkeypatch):
  calls = []
  filename = "custom-node-list.json"
  channel_url = "https://raw.githubusercontent.com/Comfy-Org/ComfyUI-Manager/main"

  def fake_hash(value):
    calls.append(value)
    return 42

  monkeypatch.setattr(manager_api, "manager_cache_key_hash", fake_hash)

  assert (
    manager_api.manager_cache_filename(channel_url, filename)
    == "42_custom-node-list.json"
  )
  assert calls == [
    "https://raw.githubusercontent.com/Comfy-Org/ComfyUI-Manager/main/custom-node-list.json"
  ]


def test_manager_url_cache_filename_uses_full_url_hash(monkeypatch):
  calls = []

  def fake_hash(value):
    calls.append(value)
    return 99

  monkeypatch.setattr(manager_api, "manager_cache_key_hash", fake_hash)

  assert (
    manager_api.manager_url_cache_filename("https://api.comfy.org/nodes")
    == "99_nodes.json"
  )
  assert calls == ["https://api.comfy.org/nodes"]


def test_read_manager_channel_url_falls_back_to_default(tmp_path):
  manager_dir = tmp_path / "__manager"
  manager_dir.mkdir()

  assert (
    manager_api.read_manager_channel_url(manager_dir)
    == manager_api._DEFAULT_MANAGER_CHANNEL_URL
  )


def test_read_manager_channel_url_reads_config(tmp_path):
  manager_dir = tmp_path / "__manager"
  manager_dir.mkdir()
  (manager_dir / "config.ini").write_text(
    "[default]\nchannel_url = https://cdn.jsdelivr.net/gh/Comfy-Org/ComfyUI-Manager@main\n",
    encoding="utf-8",
  )

  assert (
    manager_api.read_manager_channel_url(manager_dir)
    == "https://cdn.jsdelivr.net/gh/Comfy-Org/ComfyUI-Manager@main"
  )


def test_manager_repository_data_channel_defaults_to_jsdelivr(tmp_path):
  assert manager_api.read_manager_repository_data_channel(tmp_path) == "jsdelivr"
  assert (
    manager_api.manager_repository_data_channel_url("github")
    == manager_api._DEFAULT_MANAGER_CHANNEL_URL
  )
  assert (
    manager_api.manager_repository_data_channel_url("jsdelivr")
    == manager_api._JSDELIVR_MANAGER_CHANNEL_URL
  )


def test_set_manager_repository_data_channel_keeps_manager_channel_url_default(
  tmp_path,
):
  user_dir = tmp_path / "user"
  manager_dir = user_dir / "__manager"
  source_dir = user_dir / "__controlpanel" / "manager-cache" / "sources" / "jsdelivr"
  manager_dir.mkdir(parents=True)
  source_dir.mkdir(parents=True)
  (source_dir / "custom-node-list.json").write_text(
    json.dumps({"custom_nodes": []}), encoding="utf-8"
  )
  manager_api.write_controlpanel_settings(
    {
      "manager_repository_data_override_enabled": True,
      "manager_repository_data_channel": "github",
    },
    user_dir,
  )

  result = manager_api.set_manager_repository_data_channel(
    "jsdelivr", user_dir=user_dir
  )

  assert result["channel"] == "jsdelivr"
  assert result["channel_url"] == manager_api._JSDELIVR_MANAGER_CHANNEL_URL
  assert manager_api.read_manager_repository_data_channel(user_dir) == "jsdelivr"
  assert (
    manager_api.read_manager_channel_url(manager_dir)
    == manager_api._DEFAULT_MANAGER_CHANNEL_URL
  )


def test_set_manager_repository_override_forces_offline_and_records_internal_setting(
  tmp_path, monkeypatch
):
  user_dir = tmp_path / "user"
  manager_dir = user_dir / "__manager"
  source_dir = user_dir / "__controlpanel" / "manager-cache" / "sources" / "jsdelivr"
  manager_dir.mkdir(parents=True)
  source_dir.mkdir(parents=True)
  (manager_dir / "config.ini").write_text(
    "[default]\nchannel_url = https://raw.githubusercontent.com/Comfy-Org/ComfyUI-Manager/main\nnetwork_mode = public\n",
    encoding="utf-8",
  )
  (source_dir / "custom-node-list.json").write_text(
    json.dumps({"custom_nodes": []}), encoding="utf-8"
  )
  monkeypatch.setattr(manager_api, "_MANAGER_CACHE_FILES", ("custom-node-list.json",))
  result = manager_api.set_manager_repository_override(True, user_dir=user_dir)

  settings = manager_api.read_controlpanel_settings(user_dir)
  manager_path = (
    manager_dir
    / "cache"
    / manager_api.manager_cache_filename(
      manager_api._DEFAULT_MANAGER_CHANNEL_URL,
      "custom-node-list.json",
    )
  )

  assert settings["manager_repository_data_override_enabled"] is True
  assert settings["manager_network_mode_before_override"] == "public"
  assert manager_api.read_manager_network_mode(manager_dir) == "offline"
  assert (
    manager_api.read_manager_channel_url(manager_dir)
    == manager_api._DEFAULT_MANAGER_CHANNEL_URL
  )
  assert (manager_dir / "config_org.ini").exists()
  assert manager_path.exists()
  assert result["enabled"] is True


def test_set_manager_repository_override_disable_restores_original_manager_config(
  tmp_path,
):
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
  assert (
    manager_api.read_manager_channel_url(manager_dir)
    == "https://example.test/original-manager"
  )
  assert "other_setting = keep-me" in (manager_dir / "config.ini").read_text(
    encoding="utf-8"
  )
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


def test_manager_repository_override_removes_generated_config_when_original_was_missing(
  tmp_path,
):
  user_dir = tmp_path / "user"
  manager_dir = user_dir / "__manager"
  manager_dir.mkdir(parents=True)

  manager_api.set_manager_repository_override(True, user_dir=user_dir)
  assert (manager_dir / "config.ini").exists()

  manager_api.set_manager_repository_override(False, user_dir=user_dir)

  assert not (manager_dir / "config.ini").exists()


def test_apply_startup_manager_repository_override_deploys_cached_sources(
  tmp_path, monkeypatch
):
  user_dir = tmp_path / "user"
  manager_dir = user_dir / "__manager"
  source_dir = user_dir / "__controlpanel" / "manager-cache" / "sources" / "jsdelivr"
  manager_dir.mkdir(parents=True)
  source_dir.mkdir(parents=True)
  manager_api.write_controlpanel_settings(
    {"manager_repository_data_override_enabled": True}, user_dir
  )
  (source_dir / "custom-node-list.json").write_text(
    json.dumps({"custom_nodes": [{"title": "Cached"}]}), encoding="utf-8"
  )
  (source_dir / manager_api._COMFY_REGISTRY_NODES_CACHE_FILENAME).write_text(
    json.dumps(
      {"nodes": [{"id": "registry-node", "latest_version": {"version": "1.0.0"}}]}
    ),
    encoding="utf-8",
  )
  monkeypatch.setattr(manager_api, "_MANAGER_CACHE_FILES", ("custom-node-list.json",))

  result = manager_api.apply_startup_manager_repository_override(user_dir=user_dir)

  manager_path = (
    manager_dir
    / "cache"
    / manager_api.manager_cache_filename(
      manager_api._DEFAULT_MANAGER_CHANNEL_URL,
      "custom-node-list.json",
    )
  )
  registry_manager_path = (
    manager_dir
    / "cache"
    / manager_api.manager_url_cache_filename(manager_api._COMFY_REGISTRY_NODES_URL)
  )
  assert result["enabled"] is True
  assert manager_api.read_manager_network_mode(manager_dir) == "offline"
  assert (
    manager_api.read_manager_channel_url(manager_dir)
    == manager_api._DEFAULT_MANAGER_CHANNEL_URL
  )
  assert json.loads(manager_path.read_text(encoding="utf-8")) == {
    "custom_nodes": [{"title": "Cached"}]
  }
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


def test_schedule_startup_manager_cache_refresh_uses_running_event_loop(
  tmp_path, monkeypatch
):
  user_dir = tmp_path / "user"
  manager_api.write_controlpanel_settings(
    {"manager_repository_data_override_enabled": True}, user_dir
  )
  calls = []

  async def fake_refresh_manager_cache_from_cdn(
    on_line=None, *, user_dir=None, max_age_seconds=0
  ):
    calls.append(user_dir)
    if on_line:
      on_line("refresh ran")
    return {"provider": "fake"}

  monkeypatch.setattr(
    manager_api, "refresh_manager_cache_from_cdn", fake_refresh_manager_cache_from_cdn
  )

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

  future_time = time.time() + 60
  os.utime(cache_file, (future_time, future_time))
  assert not manager_api.is_cache_file_fresh(cache_file, max_age_seconds=0)

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
    result = asyncio.run(
      manager_api.refresh_manager_cache_from_cdn(logs.append, user_dir=tmp_path)
    )
  finally:
    manager_api._MANAGER_CACHE_REFRESH_LOCK.release()

  assert result["skipped"] == "Manager cache refresh is already running."
  assert result["manager_dir"] == str(tmp_path / "__manager")
  assert logs == ["Manager cache refresh is already running."]


def test_refresh_manager_cache_fetches_jsdelivr_and_writes_manager_cache(
  monkeypatch, tmp_path
):
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
      json.dumps(
        {"nodes": [{"id": "registry-node", "latest_version": {"version": "1.0.0"}}]}
      ),
      encoding="utf-8",
    )
    return {"file": "registry-node-list.json", "action": "skipped"}

  monkeypatch.setattr(
    manager_api, "refresh_comfy_registry_nodes_cache", fake_refresh_registry
  )

  result = asyncio.run(manager_api.refresh_manager_cache_from_cdn(user_dir=user_dir))

  source_path = (
    user_dir
    / "__controlpanel"
    / "manager-cache"
    / "sources"
    / "jsdelivr"
    / "custom-node-list.json"
  )
  manager_path = (
    manager_dir
    / "cache"
    / manager_api.manager_cache_filename(
      "https://raw.githubusercontent.com/Comfy-Org/ComfyUI-Manager/main",
      "custom-node-list.json",
    )
  )

  assert requested_urls == [
    "https://cdn.jsdelivr.net/gh/Comfy-Org/ComfyUI-Manager@main/custom-node-list.json"
  ]
  assert source_path.exists()
  assert manager_path.exists()
  registry_manager_path = (
    manager_dir
    / "cache"
    / manager_api.manager_url_cache_filename(manager_api._COMFY_REGISTRY_NODES_URL)
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


def test_refresh_manager_cache_fetches_github_raw_when_channel_selected(
  monkeypatch, tmp_path
):
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
  manager_api.write_controlpanel_settings(
    {"manager_repository_data_channel": "github"}, user_dir
  )

  monkeypatch.setattr(manager_api, "_MANAGER_CACHE_FILES", ("custom-node-list.json",))
  monkeypatch.setattr(manager_api, "ClientSession", FakeSession)

  async def fake_refresh_registry(session, source_dir, on_line=None, channel=None):
    (source_dir / manager_api._COMFY_REGISTRY_NODES_CACHE_FILENAME).write_text(
      json.dumps({"nodes": []}),
      encoding="utf-8",
    )
    return {"file": "registry-node-list.json", "action": "skipped"}

  monkeypatch.setattr(
    manager_api, "refresh_comfy_registry_nodes_cache", fake_refresh_registry
  )

  result = asyncio.run(manager_api.refresh_manager_cache_from_cdn(user_dir=user_dir))

  assert requested_urls == [
    f"{manager_api._DEFAULT_MANAGER_CHANNEL_URL}/custom-node-list.json"
  ]
  assert result["provider"] == "github"
  assert result["repository_data_channel"] == "github"
  assert (
    user_dir
    / "__controlpanel"
    / "manager-cache"
    / "sources"
    / "github"
    / "custom-node-list.json"
  ).exists()


def test_refresh_manager_cache_uses_fresh_source_without_fetching(
  monkeypatch, tmp_path
):
  user_dir = tmp_path / "user"
  manager_dir = user_dir / "__manager"
  source_dir = user_dir / "__controlpanel" / "manager-cache" / "sources" / "jsdelivr"
  manager_dir.mkdir(parents=True)
  source_dir.mkdir(parents=True)
  (source_dir / "custom-node-list.json").write_text(
    json.dumps({"custom_nodes": []}), encoding="utf-8"
  )

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

  monkeypatch.setattr(
    manager_api, "refresh_comfy_registry_nodes_cache", fake_refresh_registry
  )

  result = asyncio.run(manager_api.refresh_manager_cache_from_cdn(user_dir=user_dir))

  assert result["results"][0]["action"] == "deployed"
  manager_path = (
    manager_dir
    / "cache"
    / manager_api.manager_cache_filename(
      manager_api._DEFAULT_MANAGER_CHANNEL_URL,
      "custom-node-list.json",
    )
  )
  assert manager_path.exists()


def test_refresh_manager_cache_hashes_existing_fresh_manager_cache(
  monkeypatch, tmp_path
):
  user_dir = tmp_path / "user"
  manager_dir = user_dir / "__manager"
  source_dir = user_dir / "__controlpanel" / "manager-cache" / "sources" / "jsdelivr"
  manager_cache_dir = manager_dir / "cache"
  source_dir.mkdir(parents=True)
  manager_cache_dir.mkdir(parents=True)
  source_path = source_dir / "custom-node-list.json"
  source_path.write_text(json.dumps({"custom_nodes": []}), encoding="utf-8")
  manager_path = manager_cache_dir / manager_api.manager_cache_filename(
    manager_api._DEFAULT_MANAGER_CHANNEL_URL,
    "custom-node-list.json",
  )
  manager_path.write_text(json.dumps({"custom_nodes": []}), encoding="utf-8")

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

  monkeypatch.setattr(
    manager_api, "refresh_comfy_registry_nodes_cache", fake_refresh_registry
  )

  result = asyncio.run(manager_api.refresh_manager_cache_from_cdn(user_dir=user_dir))

  assert result["results"][0]["action"] == "fresh"
  assert result["results"][0]["sha256"]


def test_rebuild_manager_cache_preserves_existing_source_until_refetched(
  monkeypatch, tmp_path
):
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
  (source_dir / "custom-node-list.json").write_text(
    json.dumps({"custom_nodes": [{"name": "old"}]}), encoding="utf-8"
  )
  (source_dir / "stale-extra.json").write_text("{}", encoding="utf-8")

  monkeypatch.setattr(manager_api, "_MANAGER_CACHE_FILES", ("custom-node-list.json",))
  monkeypatch.setattr(manager_api, "ClientSession", FakeSession)

  async def fake_refresh_registry(
    session, source_dir, on_line=None, channel=None, *, force_rebuild=False
  ):
    assert force_rebuild is True
    (source_dir / manager_api._COMFY_REGISTRY_NODES_CACHE_FILENAME).write_text(
      json.dumps({"nodes": []}),
      encoding="utf-8",
    )
    return {"file": "registry-node-list.json", "action": "rebuilt"}

  monkeypatch.setattr(
    manager_api, "refresh_comfy_registry_nodes_cache", fake_refresh_registry
  )

  result = asyncio.run(manager_api.rebuild_manager_cache_from_cdn(user_dir=user_dir))

  assert requested_urls == [
    "https://cdn.jsdelivr.net/gh/Comfy-Org/ComfyUI-Manager@main/custom-node-list.json"
  ]
  assert result["rebuilt"] is True
  assert result["max_age_seconds"] == 0
  assert (source_dir / "stale-extra.json").exists()
  assert json.loads(
    (source_dir / "custom-node-list.json").read_text(encoding="utf-8")
  ) == {"custom_nodes": [{"name": "fresh"}]}


def test_rebuild_manager_cache_api_failure_preserves_previous_database_and_source(
  monkeypatch, tmp_path
):
  user_dir = tmp_path / "user"
  source_dir = manager_api.controlpanel_manager_cache_source_dir(user_dir, "jsdelivr")
  source_dir.mkdir(parents=True)
  source_path = source_dir / "custom-node-list.json"
  source_path.write_text('{"custom_nodes": [{"name": "cached"}]}', encoding="utf-8")
  database_path = manager_api.registry_cache_path(source_dir)
  database_path.write_bytes(b"existing sqlite cache")

  async def failed_refresh(
    on_line=None, *, user_dir=None, max_age_seconds=None, force_registry_rebuild=False
  ):
    assert max_age_seconds == 0
    assert force_registry_rebuild is True
    raise manager_api.ManagerApiError("Registry unavailable")

  monkeypatch.setattr(
    manager_api, "_refresh_manager_cache_from_cdn_unlocked", failed_refresh
  )

  with pytest.raises(manager_api.ManagerApiError, match="Registry unavailable"):
    asyncio.run(manager_api.rebuild_manager_cache_from_cdn(user_dir=user_dir))

  assert database_path.read_bytes() == b"existing sqlite cache"
  assert json.loads(source_path.read_text(encoding="utf-8")) == {
    "custom_nodes": [{"name": "cached"}]
  }
  assert not manager_api._MANAGER_CACHE_REFRESH_LOCK.locked()


def test_registry_nodes_incremental_timestamp_uses_created_node_date_only():
  timestamp = manager_api.registry_nodes_incremental_timestamp(
    {
      "nodes": [
        {
          "id": "old",
          "created_at": "2026-07-01T00:00:00Z",
          "updated_at": "2026-09-01T00:00:00Z",
          "latest_version": {"createdAt": "2026-10-01T00:00:00Z"},
        },
        {
          "id": "new",
          "createdAt": "2026-07-02T00:00:05Z",
          "updatedAt": "2026-08-01T00:00:00Z",
        },
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

  result = manager_api.deploy_registry_nodes_cache_to_manager(
    source_dir, manager_cache_dir
  )

  manager_path = manager_cache_dir / manager_api.manager_url_cache_filename(
    manager_api._COMFY_REGISTRY_NODES_URL
  )
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


def test_refresh_registry_nodes_cache_delegates_to_sqlite_sync(monkeypatch, tmp_path):
  metadata = {
    "comfyui_version": "0.3.50",
    "platform": "windows",
    "form_factor": "git-windows",
    "channel": "jsdelivr",
  }
  session = SimpleNamespace()
  logs = []
  sync_arguments = {}
  expected_result = {"action": "updated", "total": 2}

  async def fake_sync(**kwargs):
    sync_arguments.update(kwargs)
    return expected_result

  monkeypatch.setattr(manager_api.registry_cache, "sync_registry_cache", fake_sync)
  monkeypatch.setattr(manager_api, "_current_registry_cache_metadata", lambda: metadata)
  monkeypatch.setattr(manager_api.time, "time", lambda: 1000.0)

  result = asyncio.run(
    manager_api.refresh_comfy_registry_nodes_cache(session, tmp_path, logs.append)
  )

  assert result is expected_result
  assert sync_arguments == {
    "session": session,
    "db_path": tmp_path / manager_api.registry_cache.DB_FILENAME,
    "metadata": metadata,
    "installed_node_ids": manager_api.installed_registry_node_ids,
    "fetch_json": manager_api.fetch_json,
    "fetch_nodes": manager_api.fetch_registry_nodes_pages,
    "nodes_url": "https://api.comfy.org/nodes",
    "now": 1000.0,
    "force_rebuild": False,
    "on_line": logs.append,
  }
  assert not (tmp_path / manager_api._COMFY_REGISTRY_NODES_CACHE_FILENAME).exists()


def test_refresh_registry_nodes_cache_shares_database_across_repository_channels(
  monkeypatch, tmp_path
):
  calls = []

  async def fake_sync(**kwargs):
    calls.append(kwargs)
    return {"action": "fresh"}

  monkeypatch.setattr(manager_api.registry_cache, "sync_registry_cache", fake_sync)
  monkeypatch.setattr(
    manager_api,
    "_current_registry_cache_metadata",
    lambda channel: {"channel": channel},
  )
  cache_dir = tmp_path / "__controlpanel" / "manager-cache"

  for channel in ("jsdelivr", "github"):
    asyncio.run(
      manager_api.refresh_comfy_registry_nodes_cache(
        SimpleNamespace(),
        cache_dir / "sources" / channel,
        channel=channel,
      )
    )

  assert [call["db_path"] for call in calls] == [
    cache_dir / manager_api.registry_cache.DB_FILENAME
  ] * 2
  assert [call["metadata"]["channel"] for call in calls] == ["jsdelivr", "github"]
  assert all(call["force_rebuild"] is False for call in calls)


def test_refresh_registry_nodes_cache_forwards_forced_catalog_refresh(
  monkeypatch, tmp_path
):
  calls = []

  async def fake_sync(**kwargs):
    calls.append(kwargs)
    return {"action": "rebuilt"}

  monkeypatch.setattr(manager_api.registry_cache, "sync_registry_cache", fake_sync)
  monkeypatch.setattr(
    manager_api,
    "_current_registry_cache_metadata",
    lambda: {"comfyui_version": "0.3.51"},
  )

  result = asyncio.run(
    manager_api.refresh_comfy_registry_nodes_cache(
      SimpleNamespace(),
      tmp_path,
      force_rebuild=True,
    )
  )

  assert result["action"] == "rebuilt"
  assert calls[0]["force_rebuild"] is True
  assert calls[0]["metadata"] == {"comfyui_version": "0.3.51"}


def test_startup_registry_cache_deploys_sqlite_projection(monkeypatch, tmp_path):
  user_dir = tmp_path / "user"
  manager_dir = manager_api.manager_user_dir(user_dir)
  source_dir = manager_api.controlpanel_manager_cache_source_dir(user_dir, "jsdelivr")
  manager_dir.mkdir(parents=True)
  source_dir.mkdir(parents=True)
  manager_api.write_controlpanel_settings(
    {"manager_repository_data_override_enabled": True}, user_dir
  )
  database_path = manager_api.registry_cache_path(source_dir)
  database_path.touch()
  (source_dir / manager_api._COMFY_REGISTRY_NODES_CACHE_FILENAME).write_text(
    json.dumps(
      {"nodes": [{"id": "legacy-json", "latest_version": {"version": "0.1.0"}}]}
    ),
    encoding="utf-8",
  )
  read_paths = []

  def fake_read_registry_cache(path, *, allow_flagged=False):
    assert allow_flagged is False
    read_paths.append(path)
    return {
      "nodes": [
        {"id": "sqlite-node", "latest_version": {"version": "1.2.0"}},
        {"id": "missing-version"},
      ],
      "installed_node_versions": {"sqlite-node": {"latest_flagged": None}},
    }

  monkeypatch.setattr(
    manager_api.registry_cache, "read_registry_cache", fake_read_registry_cache
  )
  monkeypatch.setattr(manager_api, "_MANAGER_CACHE_FILES", ())

  result = manager_api.apply_startup_manager_repository_override(user_dir=user_dir)

  manager_path = (
    manager_dir
    / "cache"
    / manager_api.manager_url_cache_filename(manager_api._COMFY_REGISTRY_NODES_URL)
  )
  assert result["enabled"] is True
  assert read_paths == [database_path]
  assert json.loads(manager_path.read_text(encoding="utf-8")) == {
    "nodes": [{"id": "sqlite-node", "latest_version": {"version": "1.2.0"}}],
    "page": 1,
    "total": 1,
    "totalPages": 1,
  }


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
    manager_api.fetch_registry_nodes_pages(
      FakeSession(), metadata=metadata, on_line=logs.append
    )
  )

  assert result["totalPages"] == 21
  assert result["total"] == 630
  assert len(requested_urls) == 21
  assert logs == [
    "Updating ComfyRegistry nodes (10/21)",
    "Updating ComfyRegistry nodes (20/21)",
    "Updating ComfyRegistry nodes (21/21)",
  ]


def test_update_git_repository_attempts_fast_forward_with_local_changes(
  monkeypatch, tmp_path
):
  calls = []
  repo = tmp_path / "ComfyUI-Test"
  repo.mkdir()

  async def fake_run_command(args, cwd, timeout=600):
    calls.append((args, cwd, timeout))
    return {"returncode": 0, "stdout": "Already up to date."}

  monkeypatch.setattr(
    manager_api, "_find_executable", lambda command: f"/bin/{command}"
  )
  monkeypatch.setattr(manager_api, "run_command", fake_run_command)

  result = asyncio.run(manager_api.update_git_repository(repo))

  assert calls == [(["/bin/git", "pull", "--ff-only"], repo, 1200)]
  assert result["result"]["stdout"] == "Already up to date."


def test_update_git_repository_skips_when_local_changes_would_be_overwritten(
  monkeypatch, tmp_path
):
  repo = tmp_path / "ComfyUI-Test"
  repo.mkdir()

  async def fake_run_command(_args, _cwd, timeout=600):
    raise manager_api.ManagerApiError(
      "Command failed: git pull --ff-only\n"
      "error: Your local changes to the following files would be overwritten by merge:\n"
      "  config.json\n"
      "Please commit your changes or stash them before you merge."
    )

  monkeypatch.setattr(
    manager_api, "_find_executable", lambda command: f"/bin/{command}"
  )
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

  monkeypatch.setattr(
    manager_api, "_find_executable", lambda command: f"/bin/{command}"
  )
  monkeypatch.setattr(manager_api, "run_command", fake_run_command)

  result = asyncio.run(manager_api.update_git_repository(repo))

  assert calls == [
    (["/bin/git", "pull", "--ff-only"], repo, 1200),
  ]
  assert result["name"] == "ComfyUI-Test"
  assert result["result"]["stdout"] == "Already up to date."


def test_check_for_updates_reports_comfyui_and_git_nodes_on_one_line(
  monkeypatch, tmp_path
):
  calls = []
  node_repo = tmp_path / "custom_nodes" / "ControlPanel"
  node_repo.mkdir(parents=True)

  async def fake_run_command(args, cwd, timeout=600):
    calls.append((args, cwd, timeout))
    command = args[1:]
    if command == ["tag", "--list"]:
      return {"returncode": 0, "stdout": "v0.3.50\nv0.3.52"}
    if command[:2] == ["describe", "--tags"]:
      return {"returncode": 0, "stdout": "v0.3.50"}
    if command == ["branch", "--show-current"]:
      return {"returncode": 0, "stdout": "dev"}
    if command[:2] == ["rev-parse", "--abbrev-ref"]:
      return {"returncode": 0, "stdout": "upstream/release/dev"}
    if command[-2:] == ["--format=%cI%x09%h", "HEAD"]:
      return {"returncode": 0, "stdout": "2026-08-05T14:20:00+00:00\ta1b2c3d"}
    if command[-2:] == ["--format=%cI%x09%h", "FETCH_HEAD"]:
      return {"returncode": 0, "stdout": "2026-08-08T09:10:00+00:00\te4f5g6h"}
    if command[:3] == ["rev-list", "--left-right", "--count"]:
      return {"returncode": 0, "stdout": "0\t3"}
    return {"returncode": 0, "stdout": ""}

  monkeypatch.setattr(manager_api, "COMFYUI_ROOT", tmp_path)
  monkeypatch.setattr(manager_api, "discover_git_repositories", lambda: [node_repo])
  monkeypatch.setattr(
    manager_api, "_find_executable", lambda command: f"/bin/{command}"
  )
  monkeypatch.setattr(manager_api, "run_command", fake_run_command)
  logs = []

  result = asyncio.run(manager_api.check_for_updates(logs.append))

  assert logs[0] == "ComfyUI: Update available (v0.3.50 -> v0.3.52)"
  assert logs[1].startswith("ControlPanel [dev]: 3 commits behind (")
  assert "a1b2c3d ->" in logs[1]
  assert logs[1].endswith("e4f5g6h)")
  assert result["restart_required"] is False
  assert result["comfyui"]["current"] == "v0.3.50"
  assert result["nodes"][0]["behind"] == 3
  assert result["nodes"][0]["upstream"] == "upstream/release/dev"
  assert (
    ["/bin/git", "fetch", "--quiet", "upstream", "release/dev"],
    node_repo,
    1200,
  ) in calls


def test_check_for_updates_handles_missing_fallback_branch_and_detached_head(
  monkeypatch, tmp_path
):
  node_repo = tmp_path / "custom_nodes" / "LegacyNode"
  node_repo.mkdir(parents=True)
  detached_repo = tmp_path / "custom_nodes" / "DetachedNode"
  detached_repo.mkdir(parents=True)

  async def fake_run_command(args, cwd, timeout=600):
    command = args[1:]
    if command == ["tag", "--list"]:
      return {"returncode": 0, "stdout": "v0.3.52"}
    if command[:2] == ["describe", "--tags"]:
      return {"returncode": 0, "stdout": "v0.3.52"}
    if command == ["branch", "--show-current"]:
      branch = "" if cwd == detached_repo else "legacy"
      return {"returncode": 0, "stdout": branch}
    if command[:2] == ["rev-parse", "--abbrev-ref"]:
      raise manager_api.ManagerApiError("fatal: no upstream configured")
    if cwd == node_repo and command[:2] == ["fetch", "--quiet"]:
      raise manager_api.ManagerApiError("fatal: couldn't find remote ref legacy")
    return {"returncode": 0, "stdout": ""}

  monkeypatch.setattr(manager_api, "COMFYUI_ROOT", tmp_path)
  monkeypatch.setattr(
    manager_api, "discover_git_repositories", lambda: [node_repo, detached_repo]
  )
  monkeypatch.setattr(
    manager_api, "_find_executable", lambda command: f"/bin/{command}"
  )
  monkeypatch.setattr(manager_api, "run_command", fake_run_command)
  logs = []

  result = asyncio.run(manager_api.check_for_updates(logs.append))

  assert logs == [
    "ComfyUI: Latest (v0.3.52)",
    "LegacyNode [legacy]: Remote branch not found (origin/legacy)",
    "DetachedNode: Detached HEAD",
  ]
  assert result["nodes"][0]["status"] == "Remote branch not found (origin/legacy)"
  assert result["nodes"][1]["status"] == "Detached HEAD"


def test_update_comfyui_uses_comfy_cli_latest_version(monkeypatch, tmp_path):
  calls = []

  async def fake_run_command_stream(args, cwd, timeout=1800, on_line=None):
    calls.append((args, cwd, timeout, on_line))
    return {"returncode": 0, "stdout": "updated"}

  on_line = lambda _line: None
  monkeypatch.setattr(manager_api, "COMFYUI_ROOT", tmp_path)
  monkeypatch.setattr(
    manager_api, "_find_executable", lambda command: f"/bin/{command}"
  )
  monkeypatch.setattr(manager_api, "run_command_stream", fake_run_command_stream)

  result = asyncio.run(manager_api.update_comfyui_with_comfy_cli(on_line))

  assert calls == [
    (
      [
        "/bin/comfy",
        "--workspace",
        str(tmp_path),
        "update",
        "comfy",
        "--version",
        "latest",
      ],
      tmp_path,
      3600,
      on_line,
    )
  ]
  assert result["provider"] == "comfy-cli"
  assert result["version"] == "latest"
  assert result["restart_required"] is True


def test_latest_version_tag_prefers_highest_semver_tag():
  assert (
    manager_api._latest_version_tag("latest\nv0.3.9\nv0.3.77\nv0.27.0\nrelease/v0.99\n")
    == "v0.27.0"
  )


def test_start_job_rejects_concurrent_running_jobs(monkeypatch):
  manager_jobs.reset_jobs_for_tests()

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

  manager_jobs.reset_jobs_for_tests()
