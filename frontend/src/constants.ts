export const SETTINGS_PREFIX = "Manager_Extension"
export const EXTENSION_NAME = "ComfyUI Manager Extension"
export const LOGGING_PREFIX = `[${SETTINGS_PREFIX}]`
export const SETTINGS_IDS = {
  VERSION: `${SETTINGS_PREFIX}.Version`,
  DEBUG_LOGGING: `${SETTINGS_PREFIX}.Debug_Logging`,
}
export const API_PREFIX = "/manager-extension"
export const API_ROUTES = {
  STATUS: `${API_PREFIX}/status`,
  INSTALL_GIT_URL: `${API_PREFIX}/install-git-url`,
  UPDATE_ALL: `${API_PREFIX}/update-all`,
  UPDATE_COMFYUI: `${API_PREFIX}/update-comfyui`,
  RESTART: `${API_PREFIX}/restart`,
}
