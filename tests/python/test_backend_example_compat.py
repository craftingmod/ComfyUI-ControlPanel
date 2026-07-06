from backend import manager_api


def test_python_lane_can_exercise_control_panel_api_helpers():
    assert manager_api.API_PREFIX == "/control-panel"
    assert manager_api.repo_name_from_git_url("https://github.com/user/ComfyUI-Foo.git") == "ComfyUI-Foo"
