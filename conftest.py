import sys
import types
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

ROOT_INIT_PATH = Path(__file__).resolve().parent / "__init__.py"


def _install_comfy_api_test_stub() -> None:
  try:
    import comfy_api.latest  # noqa: F401

    return
  except ModuleNotFoundError:
    pass

  class ComfyNode:
    pass

  class ComfyExtension:
    pass

  class Input:
    def __init__(self, input_id: str, **kwargs):
      self.id = input_id
      for key, value in kwargs.items():
        setattr(self, key, value)

  class Output:
    def __init__(self, **kwargs):
      for key, value in kwargs.items():
        setattr(self, key, value)

  class String:
    pass

  String.Input = Input
  String.Output = Output

  class Schema:
    def __init__(self, **kwargs):
      for key, value in kwargs.items():
        setattr(self, key, value)

  class NodeOutput:
    def __init__(self, *values):
      self.values = values

  io_module = types.ModuleType("comfy_api.latest.io")
  io_module.ComfyNode = ComfyNode
  io_module.NodeOutput = NodeOutput
  io_module.Schema = Schema
  io_module.String = String

  latest_module = types.ModuleType("comfy_api.latest")
  latest_module.ComfyExtension = ComfyExtension
  latest_module.io = io_module

  comfy_api_module = types.ModuleType("comfy_api")
  comfy_api_module.latest = latest_module

  sys.modules["comfy_api"] = comfy_api_module
  sys.modules["comfy_api.latest"] = latest_module
  sys.modules["comfy_api.latest.io"] = io_module


def _preload_root_entrypoint_for_pytest() -> None:
  # Keep pytest collection on the supported package-style loading path.
  spec = spec_from_file_location(
    "__init__",
    ROOT_INIT_PATH,
    submodule_search_locations=[str(ROOT_INIT_PATH.parent)],
  )
  assert spec is not None
  assert spec.loader is not None

  module = module_from_spec(spec)
  sys.modules["__init__"] = module
  spec.loader.exec_module(module)


_install_comfy_api_test_stub()
_preload_root_entrypoint_for_pytest()
