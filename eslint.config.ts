// @ts-check

import globals from "globals";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint"
import js from "@eslint/js"
import stylistic from '@stylistic/eslint-plugin';

export default defineConfig([
  {
    files: ["**/*.{js,mjs,cjs,ts,mts,cts}"],
    languageOptions: { globals: globals.browser },
    extends: [js.configs.recommended, tseslint.configs.recommended],
  },
  {
    plugins: {
      "@stylistic": stylistic,
    },
    rules: {
      "@stylistic/semi": ["error", "never"],
      "@stylistic/semi-spacing": "error",
      "@stylistic/comma-spacing": "error",
      "@stylistic/indent": ["error", 2],
      "@stylistic/eol-last": "error",
    },
  },
]);
