import { Link } from 'react-router-dom'
import { Bell, Sun, Moon, Monitor } from 'lucide-react'
import { useHealth } from '@/api/health'
import { useUiStore } from '@/stores/ui'
import { useNotificationsStore } from '@/stores/notifications'
import { useWsStore } from '@/stores/ws'
import { cn } from '@/lib/cn'

export function TopBar() {
  const health = useHealth()
  const { theme, setTheme, setTrayOpen } = useUiStore()
  const badge = useNotificationsStore((s) => s.unresolvedAttentionCount)
  const wsStatus = useWsStore((s) => s.status)

  const themeIcon = theme === 'dark' ? <Moon size={16} /> : theme === 'light' ? <Sun size={16} /> : <Monitor size={16} />
  const nextTheme = theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light'

  return (
    <header className="h-12 border-b border-border flex items-center px-4 gap-3 bg-bg">
      <Link to="/chat" className="text-sm font-semibold text-fg hover:opacity-80">
        AgentOne
      </Link>
      <div className="flex-1" />
      {health.data ? (
        <span className="text-xs text-muted flex items-center gap-2">
          <span
            className={cn(
              'inline-block w-2 h-2 rounded-full',
              wsStatus === 'open' ? 'bg-emerald-500' : 'bg-warn',
            )}
            title={wsStatus === 'open' ? 'Live' : `WS ${wsStatus}`}
          />
          {health.data.model}
        </span>
      ) : null}
      <button
        onClick={() => setTheme(nextTheme)}
        aria-label="Toggle theme"
        className="p-2 rounded hover:bg-surface text-muted hover:text-fg"
      >
        {themeIcon}
      </button>
      <button
        onClick={() => setTrayOpen(true)}
        aria-label="Open notifications"
        className="relative p-2 rounded hover:bg-surface text-muted hover:text-fg"
      >
        <Bell size={16} />
        {badge > 0 ? (
          <span className="absolute -top-1 -right-1 bg-danger text-white text-[10px] rounded-full px-1 min-w-[16px] h-4 flex items-center justify-center">
            {badge > 99 ? '99+' : badge}
          </span>
        ) : null}
      </button>
    </header>
  )
}
