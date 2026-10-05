// A second entry makes Bun extract the React runtime shared with the app.
// ComfyUI also imports this facade, so it must never register an extension.
import "react"
import "react-dom"
import "react-dom/client"
import "react/jsx-runtime"
