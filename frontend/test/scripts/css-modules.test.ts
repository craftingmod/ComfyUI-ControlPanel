import { expect, it } from "bun:test"

import { collectClassNames, renderDeclaration } from "@scripts/create-modulecss-types.ts"

import { installStylesheet } from "@/stylesheet.ts"

it("generates sorted declarations from nested CSS selectors, excluding declaration strings", async () => {
  const classes = await collectClassNames(`
    .panel {
      content: ".notAClass";
      .child { color: red; }
    }
    @media (width > 600px) {
      .counter-button, .panel { padding: 1rem; }
    }
  `)
  expect(classes).toEqual(["child", "counter-button", "panel"])
  expect(renderDeclaration(classes)).toContain('readonly "counter-button": string')
})

it("loads the bundle stylesheet relative to the extension URL without duplicate links", () => {
  const firstUrl = "https://example.test/comfy/extensions/template/index.js"
  const link = installStylesheet(firstUrl)
  try {
    expect(link.rel).toBe("stylesheet")
    expect(link.href).toBe("https://example.test/comfy/extensions/template/index.css")
    expect(link.parentElement).toBe(document.head)
    expect(installStylesheet(firstUrl)).toBe(link)
    expect(document.querySelectorAll(`#${link.id}`).length).toBe(1)
    expect(installStylesheet("https://example.test/extensions/renamed/index.js")).toBe(link)
    expect(link.href).toBe("https://example.test/extensions/renamed/index.css")
  } finally {
    link.remove()
  }
})
