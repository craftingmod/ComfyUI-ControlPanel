from .backend import (
    NODE_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS,
    register_routes,
)


WEB_DIRECTORY = "./dist"

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "register_routes",
    "WEB_DIRECTORY",
]
