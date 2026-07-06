from .manager_api import apply_startup_manager_repository_override, register_routes, schedule_startup_manager_cache_refresh


NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

register_routes()
apply_startup_manager_repository_override()
schedule_startup_manager_cache_refresh()

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "apply_startup_manager_repository_override",
    "register_routes",
]
