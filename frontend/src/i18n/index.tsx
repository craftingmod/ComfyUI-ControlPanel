import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react"

import { createLocaleStore } from "./localeStore.ts"
import {
  resolveLocale,
  translate,
  type Locale,
  type TranslationKey,
  type TranslationValues,
} from "./messages.ts"

export type { Locale, TranslationKey, TranslationValues } from "./messages.ts"

type Translator = {
  locale: Locale
  t: (key: TranslationKey, values?: TranslationValues) => string
}

const defaultTranslator: Translator = {
  locale: "en",
  t: (key, values) => translate(key, "en", values),
}

const TranslatorContext = createContext(defaultTranslator)

export function I18nProvider({
  children,
  settings,
  readLocale,
}: {
  children?: ReactNode
  settings: EventTarget
  readLocale: () => unknown
}) {
  const localeStore = useMemo(
    () => createLocaleStore(settings, () => resolveLocale(readLocale())),
    [readLocale, settings],
  )
  const locale = useSyncExternalStore(
    localeStore.subscribe,
    localeStore.getSnapshot,
    (): Locale => "en",
  )
  const translator = useMemo<Translator>(
    () => ({ locale, t: (key, values) => translate(key, locale, values) }),
    [locale],
  )
  return <TranslatorContext.Provider value={translator}>{children}</TranslatorContext.Provider>
}

export function useI18n(): Translator {
  return useContext(TranslatorContext)
}
