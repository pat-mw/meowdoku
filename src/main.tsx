import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider, createRouter } from '@tanstack/react-router'

import './ui/global.css'
import { routeTree } from './routeTree.gen'
import { captureInstallPrompt } from './pwa/install'

// Chromium fires `beforeinstallprompt` early, often before React has mounted,
// so the listener goes on before anything else.
captureInstallPrompt()

const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  scrollRestoration: false,
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Missing #root element')

createRoot(rootEl).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
