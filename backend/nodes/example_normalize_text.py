from comfy_api.latest import io

PROJECT_ID = "comfyui-controlpanel"
PROJECT_NAME = "ComfyUI-ControlPanel"


class ExampleNormalizeTextNode(io.ComfyNode):
  @classmethod
  def define_schema(cls) -> io.Schema:
    return io.Schema(
      node_id=f"{PROJECT_ID}.NormalizeText",
      display_name=f"{PROJECT_NAME} Normalize Text",
      category=f"{PROJECT_NAME}/examples",
      description="Normalize non-empty lines into a single space-separated string.",
      inputs=[io.String.Input("text", default="", multiline=True)],
      outputs=[io.String.Output(display_name="text")],
    )

  @classmethod
  def execute(cls, text: str) -> io.NodeOutput:
    normalized = " ".join(line.strip() for line in text.splitlines() if line.strip())
    return io.NodeOutput(normalized)
