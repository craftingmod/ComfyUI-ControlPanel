from pathlib import Path

from conftest import load_package_from_path


REPO_ROOT = Path(__file__).resolve().parents[2]
BACKEND_INIT_PATH = REPO_ROOT / "backend" / "__init__.py"


def test_backend_package_exports_control_panel_mappings():
    module = load_package_from_path(
        "backend_package",
        BACKEND_INIT_PATH,
        repo_root=REPO_ROOT,
    )

    assert module.NODE_CLASS_MAPPINGS == {}
    assert module.NODE_DISPLAY_NAME_MAPPINGS == {}
    assert module.__all__ == [
        "NODE_CLASS_MAPPINGS",
        "NODE_DISPLAY_NAME_MAPPINGS",
        "apply_startup_manager_repository_override",
        "register_routes",
    ]
