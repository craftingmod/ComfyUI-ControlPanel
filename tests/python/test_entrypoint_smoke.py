import json
import tomllib
from pathlib import Path

from conftest import load_package_from_path


REPO_ROOT = Path(__file__).resolve().parents[2]
ENTRYPOINT_PATH = REPO_ROOT / "__init__.py"
PACKAGE_JSON_PATH = REPO_ROOT / "package.json"
PYPROJECT_PATH = REPO_ROOT / "pyproject.toml"
GITIGNORE_PATH = REPO_ROOT / ".gitignore"
PNPM_WORKSPACE_PATH = REPO_ROOT / "pnpm-workspace.yaml"
CI_WORKFLOW_PATH = REPO_ROOT / ".github" / "workflows" / "ci.yaml"
RELEASE_WORKFLOW_PATH = REPO_ROOT / ".github" / "workflows" / "release.yaml"
README_PATH = REPO_ROOT / "README.md"
AGENTS_PATH = REPO_ROOT / "AGENTS.md"
TESTING_DOC_PATH = REPO_ROOT / "docs" / "TESTING.md"
E2E_CONFIG_PATH = REPO_ROOT / "e2e.config.mjs"
SETUP_E2E_SCRIPT_PATH = REPO_ROOT / "scripts" / "setup-e2e-comfy.mjs"
PLAYWRIGHT_CONFIG_PATH = REPO_ROOT / "playwright.config.ts"
E2E_SETUP_PATH = REPO_ROOT / "tests" / "e2e" / "global.setup.ts"
E2E_TEARDOWN_PATH = REPO_ROOT / "tests" / "e2e" / "global.teardown.ts"
E2E_SMOKE_SPEC_PATH = REPO_ROOT / "tests" / "e2e" / "smoke.spec.ts"


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

    assert scripts["dev"] == (
        "tsc --noEmit -p frontend/tsconfig.json && "
        "vite build --watch --config frontend/vite.config.ts"
    )
    assert scripts["build"] == (
        "tsc --noEmit -p frontend/tsconfig.json && "
        "vite build --config frontend/vite.config.ts"
    )
    assert scripts["typecheck"] == "tsc --noEmit -p frontend/tsconfig.json"
    assert scripts["test"] == "pnpm test:unit && pnpm test:e2e"
    assert scripts["test:frontend"] == "vitest run --config frontend/vitest.config.ts"
    assert scripts["test:backend"] == "uv run pytest tests/python tests/backend -q"
    assert scripts["test:unit"] == "pnpm test:frontend && pnpm test:backend"
    assert scripts["setup:e2e"] == (
        "playwright install --with-deps chromium && node scripts/setup-e2e-comfy.mjs"
    )
    assert scripts["test:e2e"] == "pnpm build && pnpm setup:e2e && playwright test"


def test_root_packaging_metadata_matches_layout():
    pyproject = tomllib.loads(PYPROJECT_PATH.read_text(encoding="utf-8"))
    tool_comfy = pyproject["tool"]["comfy"]
    bump_files = pyproject["tool"]["bumpversion"]["files"]

    assert pyproject["project"]["name"] == "comfyui-controlpanel"
    assert pyproject["project"]["description"] == "A ComfyUI custom node for restoring control panel workflows."
    assert pyproject["project"]["dependencies"] == ["aiohttp>=3.9"]
    assert tool_comfy["DisplayName"] == "ComfyUI-ControlPanel"
    assert tool_comfy["includes"] == ["dist"]
    assert any(file_config["filename"] == "frontend/src/index.ts" for file_config in bump_files)


def test_root_gitignore_and_workspace_surface_match_harness_expectations():
    gitignore = GITIGNORE_PATH.read_text(encoding="utf-8")
    pnpm_workspace = PNPM_WORKSPACE_PATH.read_text(encoding="utf-8")

    assert ".e2e/" in gitignore
    assert "test-results/" in gitignore
    assert "playwright-report/" in gitignore
    assert PNPM_WORKSPACE_PATH.exists()
    assert "packages:\n  - ." in pnpm_workspace
    assert 'verifyDepsBeforeRun: "warn"' in pnpm_workspace


def test_e2e_harness_files_exist():
    assert E2E_CONFIG_PATH.is_file()
    assert SETUP_E2E_SCRIPT_PATH.is_file()
    assert PLAYWRIGHT_CONFIG_PATH.is_file()
    assert E2E_SETUP_PATH.is_file()
    assert E2E_TEARDOWN_PATH.is_file()
    assert E2E_SMOKE_SPEC_PATH.is_file()


def test_ci_workflows_use_repo_command_surface():
    ci_workflow = CI_WORKFLOW_PATH.read_text(encoding="utf-8")
    release_workflow = RELEASE_WORKFLOW_PATH.read_text(encoding="utf-8")

    assert "pnpm install --frozen-lockfile" in ci_workflow
    assert "uv sync --locked --group dev" in ci_workflow
    assert "pnpm typecheck" in ci_workflow
    assert "pnpm test:unit" in ci_workflow
    assert "pnpm test:e2e" in ci_workflow

    assert "v*.*.*" in release_workflow
    assert "node-version: 24" in release_workflow
    assert "pnpm install --frozen-lockfile" in release_workflow
    assert "uv sync --locked --group dev" in release_workflow
    assert "pnpm typecheck" in release_workflow
    assert "pnpm test:unit" in release_workflow
    assert "pnpm build" in release_workflow
    assert "test -f dist/index.js" in release_workflow
    assert "softprops/action-gh-release@v2" in release_workflow
    assert "Comfy-Org/publish-node-action" not in release_workflow


def test_docs_explain_the_slim_command_surface():
    readme = README_PATH.read_text(encoding="utf-8")
    agents = AGENTS_PATH.read_text(encoding="utf-8")
    testing_doc = TESTING_DOC_PATH.read_text(encoding="utf-8")

    assert "pnpm install" in readme
    assert "uv sync --locked --group dev" in readme
    assert "pnpm test:e2e" in readme
    assert "docs/TESTING.md" in readme
    assert "ComfyUI Custom Node Template" not in readme
    assert "Customize This Template" not in readme

    assert "frontend/" in agents
    assert "backend/" in agents
    assert "pnpm test" in agents
    assert "docs/TESTING.md" in agents

    assert "pnpm setup:e2e" in testing_doc
    assert "pnpm test" in testing_doc
    assert ".e2e/" in testing_doc
    assert "v0.18.1" in testing_doc
    assert "COMFYUI_E2E_PORT" in testing_doc
