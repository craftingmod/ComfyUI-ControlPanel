import type { SidebarTabExtension } from "@comfyorg/comfyui-frontend-types"
import { useState } from "react"
import { createRoot, type Root } from "react-dom/client"

import { PROJECT_ID, PROJECT_NAME } from "../constants.ts"

import styles from "./react-sidebar.module.css"

function ReactExample() {
  const [count, setCount] = useState(0)

  return (
    <section className={styles.panel} aria-label={PROJECT_NAME}>
      <h2 className={styles.heading}>{PROJECT_NAME}</h2>
      <div className={styles.actions}>
        <button
          className={styles.counterButton}
          type="button"
          onClick={() => setCount((value) => value + 1)}
        >
          Count: {count}
        </button>
        <button className={styles.resetButton} type="button" onClick={() => setCount(0)}>
          Reset
        </button>
      </div>
    </section>
  )
}

export function createReactSidebar(): SidebarTabExtension {
  let root: Root | undefined
  let shell: HTMLDivElement | undefined

  const destroy = () => {
    root?.unmount()
    root = undefined
    shell?.remove()
    shell = undefined
  }

  return {
    id: `${PROJECT_ID}.react-example`,
    title: PROJECT_NAME,
    icon: "pi pi-code",
    type: "custom",
    render(container) {
      destroy()
      shell = document.createElement("div")
      shell.dataset.templateTheme = ""

      const reactHost = document.createElement("div")
      const nativeNote = document.createElement("p")
      nativeNote.dataset.templateNativeNote = ""
      nativeNote.textContent = "This native DOM note uses global styles and shared tokens."
      shell.append(reactHost, nativeNote)
      container.append(shell)

      root = createRoot(reactHost)
      root.render(<ReactExample />)
    },
    destroy,
  }
}
