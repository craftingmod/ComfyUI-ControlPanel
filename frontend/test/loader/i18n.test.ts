import { expect, it } from "bun:test"

import { act, createElement } from "react"
import { createRoot } from "react-dom/client"

import englishCommands from "../../../locales/en/commands.json" with { type: "json" }
import english from "../../../locales/en/main.json" with { type: "json" }
import englishSettings from "../../../locales/en/settings.json" with { type: "json" }
import koreanCommands from "../../../locales/ko/commands.json" with { type: "json" }
import korean from "../../../locales/ko/main.json" with { type: "json" }
import koreanSettings from "../../../locales/ko/settings.json" with { type: "json" }
import { SETTINGS_IDS } from "../../src/constants.ts"
import { I18nProvider, useI18n } from "../../src/i18n/index.tsx"
import { createLocaleStore } from "../../src/i18n/localeStore.ts"
import {
  createTranslator,
  resolveLocale,
  translate,
  type TranslationKey,
} from "../../src/i18n/messages.ts"

const englishMessages = english["ComfyUI-ControlPanel"]
const koreanMessages = korean["ComfyUI-ControlPanel"]

function placeholders(message: string): string[] {
  return [...message.matchAll(/\{([^{}]+)\}/gu)].map((match) => match[1]!).sort()
}

function stringEntries(value: unknown, prefix = ""): Array<[string, string]> {
  if (typeof value === "string") return [[prefix, value]]
  if (!value || typeof value !== "object" || Array.isArray(value)) return []
  return Object.entries(value).flatMap(([key, child]) =>
    stringEntries(child, prefix ? `${prefix}.${key}` : key),
  )
}

it("keeps English and Korean keys and interpolation placeholders aligned", () => {
  expect(Object.keys(koreanMessages).sort()).toEqual(Object.keys(englishMessages).sort())
  for (const key of Object.keys(englishMessages) as Array<keyof typeof englishMessages>) {
    expect(placeholders(koreanMessages[key])).toEqual(placeholders(englishMessages[key]))
  }
  expect(Object.values(koreanMessages).join("\n")).not.toContain("·")
})

it("keeps standard settings and command translation keys aligned with their host IDs", () => {
  const settingIds = Object.values(SETTINGS_IDS)
    .filter((id) => id !== SETTINGS_IDS.VERSION)
    .map((id) => id.replaceAll(".", "_"))
    .sort()
  const commandKeys = ["control-panel_open", "control-panel_fix-cnr-id"].sort()
  expect(Object.keys(englishSettings).sort()).toEqual(settingIds)
  expect(Object.keys(koreanSettings).sort()).toEqual(settingIds)
  expect(Object.keys(englishCommands).sort()).toEqual(commandKeys)
  expect(Object.keys(koreanCommands).sort()).toEqual(commandKeys)

  for (const [englishLocale, koreanLocale] of [
    [englishSettings, koreanSettings],
    [englishCommands, koreanCommands],
  ]) {
    const englishStrings = stringEntries(englishLocale).sort(([left], [right]) =>
      left.localeCompare(right),
    )
    const koreanStrings = stringEntries(koreanLocale).sort(([left], [right]) =>
      left.localeCompare(right),
    )
    expect(koreanStrings.map(([key]) => key)).toEqual(englishStrings.map(([key]) => key))
    for (const [[, englishText], [, koreanText]] of englishStrings.map(
      (entry, index) => [entry, koreanStrings[index]!] as const,
    )) {
      expect(placeholders(koreanText)).toEqual(placeholders(englishText))
    }
  }
})

it("resolves Korean variants and falls back to English for unsupported locales or missing keys", () => {
  expect(resolveLocale("ko-KR")).toBe("ko")
  expect(resolveLocale("ko_KR")).toBe("ko")
  expect(resolveLocale("fr-FR")).toBe("en")
  expect(resolveLocale(undefined)).toBe("en")
  expect(translate("nodes.catalogSource", "ko", { source: "sqlite" })).toBe("카탈로그 출처: sqlite")
  expect(translate("not.a.real.key" as TranslationKey, "ko")).toBe("not.a.real.key")
  let locale: unknown = "en"
  const t = createTranslator(() => locale)
  expect(t("command.open")).toBe("Open ControlPanel")
  locale = "ko"
  expect(t("command.open")).toBe("ControlPanel 열기")
})

it("refreshes the cached locale when host listeners are resubscribed", () => {
  const target = new EventTarget()
  let hostLocale: unknown = "en"
  const store = createLocaleStore(target, () => resolveLocale(hostLocale))
  const received: string[] = []
  const firstDispose = store.subscribe(() => received.push(store.getSnapshot()))

  firstDispose()
  hostLocale = "ko"
  const secondDispose = store.subscribe(() => received.push(store.getSnapshot()))
  hostLocale = "en"
  target.dispatchEvent(new Event("Comfy.Locale.change"))

  expect(received).toEqual(["en"])
  secondDispose()
  hostLocale = "ko"
  target.dispatchEvent(new Event("Comfy.Locale.change"))
  expect(received).toEqual(["en"])
})

it("updates an open React surface when the host locale changes", async () => {
  const settings = new EventTarget()
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  let hostLocale: unknown = "en"
  function Probe() {
    const { t } = useI18n()
    return createElement("button", null, t("command.open"))
  }

  try {
    await act(async () => {
      root.render(
        createElement(
          I18nProvider,
          { settings, readLocale: () => hostLocale },
          createElement(Probe),
        ),
      )
    })
    expect(host.querySelector("button")?.textContent).toBe("Open ControlPanel")

    hostLocale = "ko-KR"
    await act(async () => settings.dispatchEvent(new Event("Comfy.Locale.change")))
    expect(host.querySelector("button")?.textContent).toBe("ControlPanel 열기")

    hostLocale = "en"
    await act(async () => settings.dispatchEvent(new Event("Comfy.Locale.change")))
    expect(host.querySelector("button")?.textContent).toBe("Open ControlPanel")
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})
