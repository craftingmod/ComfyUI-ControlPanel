import ast
from pathlib import Path

from conftest import load_package_from_path

REPO_ROOT = Path(__file__).resolve().parents[2]


def test_backend_exports_control_panel_routes():
  module = load_package_from_path(
    "backend_package", REPO_ROOT / "backend/__init__.py", repo_root=REPO_ROOT
  )
  assert module.NODE_CLASS_MAPPINGS == {}
  assert module.NODE_DISPLAY_NAME_MAPPINGS == {}
  assert callable(module.register_routes)
  assert callable(module.apply_startup_manager_repository_override)


def test_route_handlers_have_all_backend_dependencies():
  module = load_package_from_path(
    "control_panel_route_backend",
    REPO_ROOT / "backend/__init__.py",
    repo_root=REPO_ROOT,
  )
  from importlib import import_module

  api = import_module(f"{module.__name__}.manager_api")
  routes = ast.parse(
    (REPO_ROOT / "backend/manager_routes.py").read_text(encoding="utf-8")
  )
  referenced = {
    node.attr
    for node in ast.walk(routes)
    if isinstance(node, ast.Attribute)
    and isinstance(node.value, ast.Name)
    and node.value.id == "api"
  }
  assert referenced
  assert sorted(name for name in referenced if not hasattr(api, name)) == []
