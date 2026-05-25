import { MemoryRouter, type MemoryRouterProps } from 'react-router-dom'
import type { ReactNode } from 'react'

/**
 * MemoryRouter pre-configured with the v7 future flags we set in the
 * production router (see `src/main.tsx`). Without these, every test that
 * mounts MemoryRouter triggers the same React Router future-flag warnings.
 */
export function TestRouter({
  children,
  ...rest
}: Omit<MemoryRouterProps, 'future'> & { children?: ReactNode }) {
  return (
    <MemoryRouter
      {...rest}
      future={{
        v7_relativeSplatPath: true,
        v7_startTransition: true,
      }}
    >
      {children}
    </MemoryRouter>
  )
}
