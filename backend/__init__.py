from .manager_api import apply_startup_manager_repository_override, register_routes


NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

register_routes()
apply_startup_manager_repository_override()

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "apply_startup_manager_repository_override",
    "register_routes",
]
