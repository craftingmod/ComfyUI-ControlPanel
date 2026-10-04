import type { Locale } from "./messages.ts"

const LOCALE_CHANGE_EVENT = "Comfy.Locale.change"

export function createLocaleStore(target: EventTarget, readLocale: () => Locale) {
  const listeners = new Set<() => void>()
  let subscribed = false
  let lastLocale = readLocale()

  function onLocaleChange(): void {
    const nextLocale = readLocale()
    if (nextLocale === lastLocale) return
    lastLocale = nextLocale
    for (const listener of listeners) listener()
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener)
    if (!subscribed) {
      lastLocale = readLocale()
      target.addEventListener(LOCALE_CHANGE_EVENT, onLocaleChange)
      subscribed = true
    }

    return () => {
      listeners.delete(listener)
      if (listeners.size === 0 && subscribed) {
        target.removeEventListener(LOCALE_CHANGE_EVENT, onLocaleChange)
        subscribed = false
      }
    }
  }

  return { getSnapshot: readLocale, subscribe }
}
