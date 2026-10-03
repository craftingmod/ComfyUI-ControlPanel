from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
NODE_PATH = REPO_ROOT / "backend" / "nodes" / "example_normalize_text.py"


def load_module_from_path(module_name: str, module_path: Path):
  assert module_path.exists(), f"Expected module at {module_path}"

  spec = spec_from_file_location(module_name, module_path)
  assert spec is not None
  assert spec.loader is not None

  module = module_from_spec(spec)
  spec.loader.exec_module(module)
  return module


def test_example_normalize_text_node_normalizes_multiline_input():
  module = load_module_from_path("example_normalize_text_node", NODE_PATH)
  output = module.ExampleNormalizeTextNode.execute("  alpha \n\n beta  \n gamma ")

  assert output.values == ("alpha beta gamma",)


def test_example_normalize_text_node_declares_multiline_text_input():
  module = load_module_from_path("example_normalize_text_node_inputs", NODE_PATH)

  schema = module.ExampleNormalizeTextNode.define_schema()

  assert schema.node_id == f"{module.PROJECT_ID}.NormalizeText"
  assert schema.display_name == f"{module.PROJECT_NAME} Normalize Text"
  assert schema.category == f"{module.PROJECT_NAME}/examples"
  assert len(schema.inputs) == 1
  assert schema.inputs[0].id == "text"
  assert schema.inputs[0].default == ""
  assert schema.inputs[0].multiline is True
  assert len(schema.outputs) == 1
  assert schema.outputs[0].display_name == "text"
