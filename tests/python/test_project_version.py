import subprocess
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


def test_dynamic_versioning_preserves_named_tags_and_prereleases():
  with tempfile.TemporaryDirectory() as directory:
    project = Path(directory)
    (project / "pyproject.toml").write_text(
      (REPO_ROOT / "pyproject.toml").read_text(encoding="utf-8"), encoding="utf-8"
    )

    def run(*command):
      return subprocess.run(
        command, cwd=project, check=True, capture_output=True, text=True
      ).stdout.strip()

    run("git", "init")
    run("git", "add", "pyproject.toml")
    run(
      "git",
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "Version test",
    )
    for tag, version in [
      ("v1.2.0-react", "1.2.0+react"),
      ("v1.2.1-rc.1", "1.2.1rc1"),
      ("v1.2.2", "1.2.2"),
    ]:
      run("git", "-c", "tag.gpgsign=false", "tag", tag)
      assert run("uvx", "uv-dynamic-versioning") == version
      run("git", "tag", "--delete", tag)
