import { expect, test } from "@playwright/test";
import { SETTINGS_IDS } from "../../frontend/src/constants";

test("custom node pack loads in ComfyUI", async ({ page, request }) => {
  await page.goto("/");

  await page.waitForFunction((debugLoggingSettingId) => {
    const comfyWindow = window as {
      app?: {
        extensionManager?: {
          setting?: {
            get: (id: string) => boolean | undefined;
          };
        };
      };
    };

    return comfyWindow.app?.extensionManager?.setting?.get(debugLoggingSettingId) === false;
  }, SETTINGS_IDS.DEBUG_LOGGING);

  const statusResponse = await request.get("/control-panel/status");
  expect(statusResponse.ok()).toBe(true);

  const status = (await statusResponse.json()) as {
    ok: boolean;
    paths?: {
      extension?: string;
      custom_nodes?: string;
      comfyui?: string;
    };
  };
  expect(status.ok).toBe(true);
  expect(status.paths?.extension).toContain("ComfyUI-ControlPanel");
});
