import { useEffect } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { TopBar } from './TopBar'
import { SidebarNav } from './SidebarNav'
import { SessionList } from './SessionList'
import { NotificationTray } from './NotificationTray'
import { NewChatDialog } from './NewChatDialog'
import { RouteErrorBoundary } from '@/components/shared/RouteErrorBoundary'
import { useUiStore } from '@/stores/ui'
import { cn } from '@/lib/cn'

export function AppShell() {
  const sidebarOpen = useUiStore((s) => s.sidebarOpen)
  const setSidebarOpen = useUiStore((s) => s.setSidebarOpen)
  const location = useLocation()

  // Auto-close the mobile drawer on navigation so picking a session swaps to the chat surface.
  useEffect(() => {
    setSidebarOpen(false)
  }, [location.pathname, setSidebarOpen])

  return (
    <div className="h-full grid grid-rows-[48px_1fr] bg-bg text-fg">
      <TopBar />
      <div className="grid grid-cols-1 md:grid-cols-[240px_1fr] overflow-hidden min-h-0">
        <aside
          className={cn(
            'border-r border-border flex flex-col bg-bg min-h-0',
            // Below md: drawer that slides in from the left, sits below the 48px topbar.
            'fixed top-12 bottom-0 left-0 w-64 z-40 transform transition-transform',
            'md:static md:translate-x-0 md:w-auto md:z-auto md:transition-none',
            sidebarOpen ? 'translate-x-0 shadow-xl md:shadow-none' : '-translate-x-full',
          )}
          aria-hidden={!sidebarOpen}
        >
          <SidebarNav />
          <div className="flex-1 border-t border-border min-h-0">
            <SessionList />
          </div>
        </aside>
        {sidebarOpen ? (
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setSidebarOpen(false)}
            className="md:hidden fixed inset-0 top-12 z-30 bg-black/40"
          />
        ) : null}
        <main className="overflow-hidden min-h-0">
          <RouteErrorBoundary>
            <Outlet />
          </RouteErrorBoundary>
        </main>
      </div>
      <NotificationTray />
      <NewChatDialog />
    </div>
  )
}
