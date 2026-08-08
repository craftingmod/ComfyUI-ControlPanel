export const SETTINGS_PREFIX = "ControlPanel"
export const EXTENSION_NAME = "ComfyUI-ControlPanel"
export const LOGGING_PREFIX = `[${SETTINGS_PREFIX}]`
export const SETTINGS_IDS = {
  VERSION: `${SETTINGS_PREFIX}.Version`,
  DEBUG_LOGGING: `${SETTINGS_PREFIX}.Debug_Logging`,
  MANAGER_REPOSITORY_DATA_OVERRIDE: `${SETTINGS_PREFIX}.Manager_Repository_Data_Override`,
  MANAGER_REPOSITORY_DATA_CHANNEL: `${SETTINGS_PREFIX}.Manager_Repository_Data_Channel`,
} as const
export const API_PREFIX = "/control-panel"
export const API_ROUTES = {
  STATUS: `${API_PREFIX}/status`,
  SETTINGS: `${API_PREFIX}/settings`,
  MANAGER_REPOSITORY_DATA_OVERRIDE: `${API_PREFIX}/settings/manager-repository-data-override`,
  MANAGER_REPOSITORY_DATA_CHANNEL: `${API_PREFIX}/settings/manager-repository-data-channel`,
  INSTALL_GIT_URL: `${API_PREFIX}/install-git-url`,
  OPEN_CUSTOM_NODES: `${API_PREFIX}/open/custom-nodes`,
  OPEN_SNAPSHOTS: `${API_PREFIX}/open/snapshots`,
  SHOW_ENVIRONMENT: `${API_PREFIX}/environment`,
  SNAPSHOT_LIST: `${API_PREFIX}/snapshot/list`,
  SNAPSHOT_SAVE: `${API_PREFIX}/snapshot/save`,
  SNAPSHOT_RESTORE: `${API_PREFIX}/snapshot/restore`,
  UPDATE_CUSTOM_NODES: `${API_PREFIX}/update/custom-nodes`,
  REFRESH_MANAGER_CACHE: `${API_PREFIX}/manager-cache/refresh`,
  REBUILD_MANAGER_CACHE: `${API_PREFIX}/manager-cache/rebuild`,
  CHECK_UPDATES: `${API_PREFIX}/updates/check`,
  UPDATE_COMFYUI: `${API_PREFIX}/update/comfyui`,
  UPDATE_STATUS: `${API_PREFIX}/update/status`,
  RESTART: `${API_PREFIX}/restart`,
} as const
