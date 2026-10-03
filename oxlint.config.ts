import { defineConfig } from "oxlint"

export default defineConfig({
  categories: {
    correctness: "warn",
  },
  options: {
    typeAware: true,
    typeCheck: true,
  },
  ignorePatterns: [".agents/**", "docs/**"],
  plugins: ["import", "typescript", "oxc", "react"],
  // https://oxc.rs/docs/guide/usage/linter/rules.html
  rules: {
    "eslint/no-unused-expressions": [
      "warn",
      {
        allowTaggedTemplates: true,
      },
    ],
    "import/extensions": [
      "error",
      "always",
      {
        ignorePackages: true,
        checkTypeImports: true,
      },
    ],
    "import/consistent-type-specifier-style": ["warn", "prefer-top-level-if-only-type-imports"],
    /* Too much effort on react */
    "typescript/unbound-method": "off",
  },
})
