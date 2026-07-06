from .manager_api import (
    apply_startup_manager_repository_override,
    register_routes,
    schedule_startup_manager_cache_refresh,
    warn_if_remote_control_enabled,
)


NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

register_routes()
warn_if_remote_control_enabled()
apply_startup_manager_repository_override()
schedule_startup_manager_cache_refresh()

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "apply_startup_manager_repository_override",
    "register_routes",
]
