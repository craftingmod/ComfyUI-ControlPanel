export const SETTINGS_PREFIX = "ControlPanel"
export const EXTENSION_NAME = "ComfyUI-ControlPanel"
export const LOGGING_PREFIX = `[${SETTINGS_PREFIX}]`
export const SETTINGS_IDS = {
  VERSION: `${SETTINGS_PREFIX}.Version`,
  DEBUG_LOGGING: `${SETTINGS_PREFIX}.Debug_Logging`,
} as const
export const API_PREFIX = "/control-panel"
export const API_ROUTES = {
  STATUS: `${API_PREFIX}/status`,
  INSTALL_GIT_URL: `${API_PREFIX}/install-git-url`,
  UPDATE_CUSTOM_NODES: `${API_PREFIX}/update/custom-nodes`,
  REFRESH_MANAGER_CACHE: `${API_PREFIX}/manager-cache/refresh`,
  SYNC_DEPENDENCIES: `${API_PREFIX}/deps/uv-sync`,
  UPDATE_COMFYUI: `${API_PREFIX}/update/comfyui`,
  UPDATE_STATUS: `${API_PREFIX}/update/status`,
  RESTART: `${API_PREFIX}/restart`,
} as const
