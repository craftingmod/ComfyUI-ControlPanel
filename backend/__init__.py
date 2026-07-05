from .nodes.example_normalize_text import ExampleNormalizeTextNode
from .manager_api import register_routes


NODE_CLASS_MAPPINGS = {"TemplateExampleNormalizeText": ExampleNormalizeTextNode}
NODE_DISPLAY_NAME_MAPPINGS = {
    "TemplateExampleNormalizeText": "Template Example Normalize Text"
}

register_routes()

__all__ = [
    "ExampleNormalizeTextNode",
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "register_routes",
]
