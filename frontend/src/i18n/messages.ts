import english from "../../../locales/en/main.json" with { type: "json" }
import korean from "../../../locales/ko/main.json" with { type: "json" }

const en = english["ComfyUI-ControlPanel"]
const ko = korean["ComfyUI-ControlPanel"]

export type Locale = "en" | "ko"
export type TranslationKey = keyof typeof en
export type TranslationValues = Record<string, string | number>

export function resolveLocale(value: unknown): Locale {
  if (typeof value !== "string") return "en"
  return value.trim().toLowerCase().split(/[-_]/u)[0] === "ko" ? "ko" : "en"
}

export function translate(key: TranslationKey, locale: Locale, values?: TranslationValues): string {
  const message = (locale === "ko" ? ko[key] : undefined) ?? en[key] ?? key
  return message.replace(/\{([^{}]+)\}/gu, (placeholder, name: string) => {
    const value = values?.[name]
    return value === undefined ? placeholder : String(value)
  })
}

export function createTranslator(readLocale: () => unknown) {
  return (key: TranslationKey, values?: TranslationValues): string =>
    translate(key, resolveLocale(readLocale()), values)
}
