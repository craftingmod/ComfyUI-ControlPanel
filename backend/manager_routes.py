from __future__ import annotations

from functools import wraps
from typing import Any


def register_routes(api: Any) -> bool:
    try:
        from server import PromptServer
    except Exception:
        return False

    routes = PromptServer.instance.routes

    def control_route(handler=None, *, manager_policy=None):
        if handler is None:
            return lambda decorated: control_route(decorated, manager_policy=manager_policy)

        @wraps(handler)
        async def wrapper(request):
            denied = api.control_request_denied_response(request, manager_policy)
            if denied is not None:
                return denied
            return await handler(request)

        return wrapper

    @routes.get(f"{api.API_PREFIX}/status")
    @control_route
    async def status(_request):
        repos = [{"name": repo.name, "path": str(repo)} for repo in api.discover_git_repositories()]
        return api._json_response(
            {
                "ok": True,
                "paths": {
                    "extension": str(api.EXTENSION_ROOT),
                    "custom_nodes": str(api.CUSTOM_NODES_DIR),
                    "comfyui": str(api.COMFYUI_ROOT),
                    "user": str(api.COMFYUI_USER_DIR),
                },
                "tools": {"git": api._command_available("git"), "uv": api._command_available("uv")},
                "latest_job": api.latest_job().to_dict() if api.latest_job() else None,
                "repositories": repos,
                "settings": {
                    "manager_repository_data_override": api.is_manager_repository_override_enabled(),
                    "manager_repository_data_channel": api.read_manager_repository_data_channel(),
                    "manager_network_mode": api.read_manager_network_mode(api.manager_user_dir()),
                    "manager_channel_url": api.read_manager_channel_url(api.manager_user_dir()),
                },
            }
        )

    @routes.get(f"{api.API_PREFIX}/settings")
    @control_route
    async def get_settings(_request):
        manager_dir = api.manager_user_dir()
        return api._json_response(
            {
                "ok": True,
                "manager_repository_data_override": api.is_manager_repository_override_enabled(),
                "manager_repository_data_channel": api.read_manager_repository_data_channel(),
                "manager_network_mode": api.read_manager_network_mode(manager_dir),
                "manager_channel_url": api.read_manager_channel_url(manager_dir),
            }
        )

    @routes.post(f"{api.API_PREFIX}/settings/manager-repository-data-override")
    @control_route
    async def set_manager_repository_data_override(request):
        data = await api._read_json(request)
        try:
            result = api.set_manager_repository_override(data.get("enabled") is True)
            return api._json_response({"ok": True, **result})
        except Exception as error:  # noqa: BLE001 - settings errors should surface to the UI.
            return api._error_response(str(error), status=500)

    @routes.post(f"{api.API_PREFIX}/settings/manager-repository-data-channel")
    @control_route
    async def set_manager_repository_data_channel_route(request):
        data = await api._read_json(request)
        try:
            result = api.set_manager_repository_data_channel(data.get("channel"))
            return api._json_response({"ok": True, **result})
        except Exception as error:  # noqa: BLE001 - settings errors should surface to the UI.
            return api._error_response(str(error), status=500)

    @routes.post(f"{api.API_PREFIX}/install-git-url")
    @control_route(manager_policy=api._MANAGER_POLICY_GIT_URL)
    async def install(request):
        data = await api._read_json(request)
        return await api._with_operation_lock(
            lambda: api._operation_install_git_url(
                str(data.get("url", "")),
                str(data["name"]) if data.get("name") else None,
            )
        )

    @routes.post(f"{api.API_PREFIX}/open/custom-nodes")
    @control_route
    async def open_custom_nodes(_request):
        return await api._with_operation_lock(api._operation_open_custom_nodes)

    @routes.post(f"{api.API_PREFIX}/open/snapshots")
    @control_route
    async def open_snapshots(_request):
        return await api._with_operation_lock(api._operation_open_snapshots)

    @routes.post(f"{api.API_PREFIX}/environment")
    @control_route
    async def environment(_request):
        return await api._with_operation_lock(api._operation_show_environment)

    @routes.get(f"{api.API_PREFIX}/snapshot/list")
    @control_route
    async def list_snapshots(_request):
        return api._json_response({"ok": True, **api.list_manager_snapshots()})

    @routes.post(f"{api.API_PREFIX}/snapshot/save")
    @control_route
    async def save_snapshot(_request):
        return await api._start_job_response("snapshot", "Save Snapshot", api._job_save_snapshot)

    @routes.post(f"{api.API_PREFIX}/snapshot/restore")
    @control_route(manager_policy=api._MANAGER_POLICY_MIDDLE)
    async def restore_snapshot(request):
        data = await api._read_json(request)
        target = str(data.get("target", ""))
        return await api._start_job_response(
            "snapshot",
            "Restore Snapshot",
            lambda job: api._job_restore_snapshot(job, target),
        )

    @routes.get(f"{api.API_PREFIX}/node-restore/inventory")
    @control_route
    async def node_restore_inventory(_request):
        return await api._with_operation_lock(api.node_restore_inventory)

    @routes.post(f"{api.API_PREFIX}/node-restore/restore")
    @control_route(manager_policy=api._MANAGER_POLICY_MIDDLE)
    async def restore_nodes(request):
        data = await api._read_json(request)
        manifest = data.get("manifest")
        if api.manifest_requires_git_url_install(manifest):
            denied = api.control_request_denied_response(request, api._MANAGER_POLICY_GIT_URL)
            if denied is not None:
                return denied
        return await api._start_job_response(
            "node-restore",
            "Restore Custom Nodes",
            lambda job: api._job_restore_nodes(job, manifest),
        )

    @routes.post(f"{api.API_PREFIX}/update-all")
    @control_route(manager_policy=api._MANAGER_POLICY_MIDDLE)
    async def update_all(_request):
        return await api._start_job_response("git-nodes", "Update Git Nodes", api._job_update_git_nodes)

    @routes.post(f"{api.API_PREFIX}/update/custom-nodes")
    @control_route(manager_policy=api._MANAGER_POLICY_MIDDLE)
    async def update_custom_nodes(_request):
        return await api._start_job_response("git-nodes", "Update Git Nodes", api._job_update_git_nodes)

    @routes.post(f"{api.API_PREFIX}/updates/check")
    @control_route
    async def check_for_updates(_request):
        return await api._start_job_response("check-updates", "Check for Updates", api._job_check_for_updates)

    @routes.post(f"{api.API_PREFIX}/manager-cache/refresh")
    @control_route
    async def refresh_manager_cache(_request):
        return await api._start_job_response("manager-cache", "Update Manager Cache", api._job_refresh_manager_cache)

    @routes.post(f"{api.API_PREFIX}/manager-cache/rebuild")
    @control_route
    async def rebuild_manager_cache(_request):
        return await api._start_job_response("manager-cache", "Rebuild Manager Cache", api._job_rebuild_manager_cache)

    @routes.post(f"{api.API_PREFIX}/update-comfyui")
    @control_route(manager_policy=api._MANAGER_POLICY_LOW)
    async def update_core(_request):
        return await api._start_job_response("comfyui", "Update ComfyUI", api._job_update_comfyui)

    @routes.post(f"{api.API_PREFIX}/update/comfyui")
    @control_route(manager_policy=api._MANAGER_POLICY_LOW)
    async def update_comfyui_route(_request):
        return await api._start_job_response("comfyui", "Update ComfyUI", api._job_update_comfyui)

    @routes.get(f"{api.API_PREFIX}/update/status")
    @control_route
    async def update_status(_request):
        job = api.latest_job()
        return api._json_response({"ok": True, "job": job.to_dict() if job else None})

    @routes.get(f"{api.API_PREFIX}/update/jobs/{{job_id}}")
    @control_route
    async def update_job_status(request):
        job = api._JOBS.get(str(request.match_info["job_id"]))
        if job is None:
            return api._error_response("Update job was not found.", status=404)
        return api._json_response({"ok": True, "job": job.to_dict()})

    @routes.post(f"{api.API_PREFIX}/restart")
    @control_route(manager_policy=api._MANAGER_POLICY_MIDDLE)
    async def restart(request):
        data = await api._read_json(request)
        if data.get("confirm") is not True:
            return api._error_response("Restart requires confirm=true.", status=400)
        try:
            result = await api.restart_comfyui(request)
            return api._json_response({"ok": True, **result})
        except Exception as error:  # noqa: BLE001 - surface restart failures to the UI.
            return api._error_response(str(error), status=500)

    return True
