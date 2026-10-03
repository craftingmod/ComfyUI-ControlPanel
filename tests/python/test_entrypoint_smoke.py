import json
import tomllib
from pathlib import Path

from conftest import load_package_from_path


REPO_ROOT = Path(__file__).resolve().parents[2]
ENTRYPOINT_PATH = REPO_ROOT / "__init__.py"
PACKAGE_JSON_PATH = REPO_ROOT / "package.json"
PYPROJECT_PATH = REPO_ROOT / "pyproject.toml"
PNPM_WORKSPACE_PATH = REPO_ROOT / "pnpm-workspace.yaml"
CI_WORKFLOW_PATH = REPO_ROOT / ".github" / "workflows" / "ci.yaml"
RELEASE_WORKFLOW_PATH = REPO_ROOT / ".github" / "workflows" / "release.yaml"
README_PATH = REPO_ROOT / "README.md"
AGENTS_PATH = REPO_ROOT / "AGENTS.md"
TESTING_DOC_PATH = REPO_ROOT / "docs" / "TESTING.md"
PACKAGE_ZIP_SCRIPT_PATH = REPO_ROOT / "scripts" / "New-CustomNodesZip.ps1"


def test_control_panel_entrypoint_exports_expected_symbols_via_package_loader():
    module = load_package_from_path(
        "control_panel_entrypoint",
        ENTRYPOINT_PATH,
        repo_root=REPO_ROOT,
    )

    assert module.WEB_DIRECTORY == "./dist"
    assert module.NODE_CLASS_MAPPINGS == {}
    assert module.NODE_DISPLAY_NAME_MAPPINGS == {}
    assert module.__all__ == [
        "NODE_CLASS_MAPPINGS",
        "NODE_DISPLAY_NAME_MAPPINGS",
        "apply_startup_manager_repository_override",
        "register_routes",
        "WEB_DIRECTORY",
    ]


def test_root_package_surface_matches_frontend_backend_split():
    package_json = json.loads(PACKAGE_JSON_PATH.read_text(encoding="utf-8"))
    scripts = package_json["scripts"]

    assert scripts["dev"] == "pnpm typecheck && bun frontend/dev.ts"
    assert scripts["build"] == "pnpm typecheck && bun frontend/build.ts"
    assert "frontend/src/tsconfig.json" in scripts["typecheck"]
    assert "frontend/test/tsconfig.json" in scripts["typecheck"]
    assert scripts["test"] == "pnpm test:unit"
    assert (
        scripts["test:frontend"]
        == "vitest run --config frontend/vitest.config.ts --configLoader runner"
    )
    assert (
        scripts["test:backend"]
        == "uv run pytest -p no:cacheprovider tests/python tests/backend -q"
    )
    assert scripts["test:unit"] == "bun scripts/ci-test.ts"


def test_root_packaging_metadata_matches_layout():
    pyproject = tomllib.loads(PYPROJECT_PATH.read_text(encoding="utf-8"))
    package_json = json.loads(PACKAGE_JSON_PATH.read_text(encoding="utf-8"))
    tool_comfy = pyproject["tool"]["comfy"]

    assert pyproject["project"]["name"] == "comfyui-controlpanel"
    assert pyproject["project"]["description"] == (
        "A lightweight ComfyUI control panel that restores legacy local administration "
        "features no longer available in ComfyUI Manager."
    )
    assert package_json["description"] == pyproject["project"]["description"]
    assert pyproject["project"]["dependencies"] == []
    assert tool_comfy["DisplayName"] == "ComfyUI-ControlPanel"
    assert tool_comfy["includes"] == ["dist", "backend/_version.py"]
    assert pyproject["project"]["dynamic"] == ["version"]
    assert tool_comfy["version"]["path"] == "backend/_version.py"
    assert tool_comfy["requires-comfyui"] == ">=0.28.0"


def test_root_workspace_surface_matches_expectations():
    pnpm_workspace = PNPM_WORKSPACE_PATH.read_text(encoding="utf-8")

    assert PNPM_WORKSPACE_PATH.exists()
    assert "packages:\n  - ." in pnpm_workspace
    assert "verifyDepsBeforeRun: false" in pnpm_workspace


def test_release_packaging_script_defines_installable_custom_nodes_archive():
    assert PACKAGE_ZIP_SCRIPT_PATH.is_file()
    package_script = PACKAGE_ZIP_SCRIPT_PATH.read_text(encoding="utf-8")

    assert '$packageName = "ComfyUI-ControlPanel"' in package_script
    assert '"dist"' in package_script
    assert '"pyproject.toml"' in package_script
    assert "Compress-Archive" in package_script
    assert '$_.Name -eq "__pycache__"' in package_script
    assert '$_.Extension -in ".pyc", ".pyo"' in package_script


def test_ci_workflows_use_repo_command_surface():
    ci_workflow = CI_WORKFLOW_PATH.read_text(encoding="utf-8")
    release_workflow = RELEASE_WORKFLOW_PATH.read_text(encoding="utf-8")

    assert "pnpm install --frozen-lockfile" in ci_workflow
    assert "uv sync --locked --group dev" in ci_workflow
    assert "pnpm validate:ci" in ci_workflow
    assert "pnpm build:custom-node" in ci_workflow
    assert "fetch-depth: 0" in ci_workflow
    assert '"v*"' in release_workflow
    assert "pnpm install --frozen-lockfile" in release_workflow
    assert "pnpm release:github" in release_workflow
    assert "gh release create" in release_workflow
    assert "needs: validate" in release_workflow
    assert "Comfy-Org/publish-node-action" in release_workflow
    assert "REGISTRY_ACCESS_TOKEN" in release_workflow


def test_docs_explain_the_slim_command_surface():
    readme = README_PATH.read_text(encoding="utf-8")
    agents = AGENTS_PATH.read_text(encoding="utf-8")
    testing_doc = TESTING_DOC_PATH.read_text(encoding="utf-8")

    assert "pnpm install" in readme
    assert "uv sync --locked --group dev" in readme
    assert "pnpm test:unit" in readme
    assert "docs/TESTING.md" in readme
    assert "ComfyUI Custom Node Template" not in readme
    assert "Customize This Template" not in readme

    assert "frontend/" in agents
    assert "backend/" in agents
    assert "pnpm test" in agents
    assert "docs/TESTING.md" in agents

    assert "pnpm test" in testing_doc
    assert "pnpm test:frontend" in testing_doc
    assert "pnpm test:backend" in testing_doc
