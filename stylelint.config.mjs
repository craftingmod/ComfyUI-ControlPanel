/** @type {import('stylelint').Config} */
export default {
  extends: ["stylelint-config-standard"],
  rules: {
    "selector-class-pattern": "[a-z]+[A-Za-z0-9_-]*$",
    /* Bun supports composes */
    "property-no-unknown": [true, { ignoreProperties: ["composes"] }],
    "value-keyword-case": ["lower", { ignoreProperties: ["composes"] }],
    "selector-pseudo-class-no-unknown": [true, { ignorePseudoClasses: ["global", "local"] }],
  },
}
