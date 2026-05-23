import { Outlet } from 'react-router-dom'
import { TopBar } from './TopBar'
import { SidebarNav } from './SidebarNav'
import { SessionList } from './SessionList'
import { NotificationTray } from './NotificationTray'
import { NewChatDialog } from './NewChatDialog'
import { RouteErrorBoundary } from '@/components/shared/RouteErrorBoundary'

export function AppShell() {
  return (
    <div className="h-full grid grid-rows-[48px_1fr] bg-bg text-fg">
      <TopBar />
      <div className="grid grid-cols-[240px_1fr] overflow-hidden">
        <aside className="border-r border-border flex flex-col bg-bg">
          <SidebarNav />
          <div className="flex-1 border-t border-border min-h-0">
            <SessionList />
          </div>
        </aside>
        <main className="overflow-hidden">
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
