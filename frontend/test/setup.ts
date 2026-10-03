import { GlobalRegistrator } from "@happy-dom/global-registrator"

GlobalRegistrator.register()

// React's act() uses this flag to recognize the DOM test environment.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
