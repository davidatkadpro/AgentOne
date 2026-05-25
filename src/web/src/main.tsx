import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from 'react-router-dom'
import { Toaster } from 'sonner'
import { ThemeProvider } from './shell/ThemeProvider'
import { queryClient } from './lib/query-client'
import { router } from './router'
import { connectWebSocket } from './lib/ws'
import { readTokenFromHash } from './lib/auth-token'
import './styles/globals.css'

// Harvest `?token=` or `#token=` from the URL before any API calls run, so
// the very first request carries the bearer.
readTokenFromHash()
connectWebSocket()

const root = document.getElementById('root')
if (!root) throw new Error('Root element missing')

createRoot(root).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} future={{ v7_startTransition: true }} />
        <Toaster position="bottom-right" />
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
)
