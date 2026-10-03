import { defineConfig } from "oxfmt"

export default defineConfig({
  ignorePatterns: [".agents/**"],
  tabWidth: 2,
  semi: false,
  singleQuote: false,
  sortImports: true,
  sortTailwindcss: true,
  sortPackageJson: true,
})
