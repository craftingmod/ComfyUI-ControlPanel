from pathlib import Path

from conftest import load_package_from_path

REPO_ROOT = Path(__file__).resolve().parents[2]


def test_entrypoint_loads_control_panel_backend():
  module = load_package_from_path(
    "control_panel_entrypoint", REPO_ROOT / "__init__.py", repo_root=REPO_ROOT
  )
  assert module.WEB_DIRECTORY == "./web"
  assert module.NODE_CLASS_MAPPINGS == {}
  assert module.NODE_DISPLAY_NAME_MAPPINGS == {}
  assert callable(module.register_routes)
  assert not hasattr(module, "ExampleNormalizeTextNode")
