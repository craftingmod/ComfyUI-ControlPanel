declare module "*.css" {
  const content: string
  export default content
}

declare module "*/scripts/api.js" {
  export const api: import("@comfyorg/comfyui-frontend-types").ComfyApi
}

declare module "*/scripts/app.js" {
  export const app: import("@comfyorg/comfyui-frontend-types").ComfyApp
}
