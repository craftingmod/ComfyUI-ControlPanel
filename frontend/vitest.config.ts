import { defineConfig } from "vitest/config"

export default defineConfig({
  cacheDir: "./.ci-cache/vite",
  test: {
    globals: true,
    include: ["frontend/test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["frontend/src/**/*.ts"],
      exclude: ["frontend/src/index.ts"],
      thresholds: {
        lines: 70,
      },
    },
  },
})
