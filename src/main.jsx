import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './ui/App.jsx'
import './ui/theme.css'

/**
 * React's entire footprint in this application is the shell around the canvas:
 * the parts palette, the inspector, the toolbar and the status bar. The
 * simulation itself is a plain ES6 class hierarchy that imports nothing from
 * React, and the render loop is driven by the engine's own
 * `requestAnimationFrame`, not by a React effect.
 *
 * See `src/ui/App.jsx` for the ownership contract.
 */
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
