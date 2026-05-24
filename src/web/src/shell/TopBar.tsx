import { Link } from 'react-router-dom'
import { AlertTriangle, Bell, Sun, Moon } from 'lucide-react'
import { useHealth } from '@/api/health'
import { useUiStore } from '@/stores/ui'
import { useNotificationsStore } from '@/stores/notifications'
import { useWsStore } from '@/stores/ws'
import { cn } from '@/lib/cn'

function resolveEffective(theme: 'light' | 'dark' | 'system'): 'light' | 'dark' {
  if (theme !== 'system') return theme
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function TopBar() {
  const health = useHealth()
  const { theme, setTheme, setTrayOpen } = useUiStore()
  const badge = useNotificationsStore((s) => s.unresolvedAttentionCount)
  const wsStatus = useWsStore((s) => s.status)

  const effective = resolveEffective(theme)
  const themeIcon = effective === 'dark' ? <Moon size={14} /> : <Sun size={14} />
  const nextTheme = effective === 'dark' ? 'light' : 'dark'
  const themeTitle = `Theme: ${effective}${theme === 'system' ? ' (auto)' : ''} — click for ${nextTheme}`

  return (
    <header className="h-12 border-b border-border flex items-center px-4 gap-2 bg-bg">
      <Link to="/chat" className="text-sm font-semibold text-fg hover:opacity-80">
        AgentOne
      </Link>
      <div className="flex-1" />
      {health.data?.emailSource?.configured && !health.data.emailSource.ok ? (
        <span
          className="inline-flex items-center gap-1 text-[11px] text-warn bg-warn/10 border border-warn/30 rounded-full px-2 py-0.5"
          title="Email source is unreachable"
          data-testid="email-source-warning"
        >
          <AlertTriangle size={11} /> Email offline
        </span>
      ) : null}
      {health.data ? (
        <span
          className="inline-flex items-center gap-1.5 text-[11px] text-muted bg-surface border border-border rounded-full px-2 py-0.5"
          title={wsStatus === 'open' ? 'Connection live' : `WebSocket: ${wsStatus}`}
        >
          <span
            className={cn(
              'inline-block w-1.5 h-1.5 rounded-full',
              wsStatus === 'open' ? 'bg-emerald-500' : 'bg-warn',
            )}
          />
          {health.data.model}
        </span>
      ) : null}
      <button
        onClick={() => setTheme(nextTheme)}
        aria-label={`Switch to ${nextTheme} theme`}
        title={themeTitle}
        className="inline-flex items-center justify-center w-7 h-7 rounded-full border border-border bg-surface text-muted hover:text-fg hover:border-accent/40"
      >
        {themeIcon}
      </button>
      <button
        onClick={() => setTrayOpen(true)}
        aria-label="Open notifications"
        className="relative inline-flex items-center justify-center w-7 h-7 rounded-full border border-border bg-surface text-muted hover:text-fg hover:border-accent/40"
      >
        <Bell size={14} />
        {badge > 0 ? (
          <span className="absolute -top-1 -right-1 bg-danger text-white text-[10px] rounded-full px-1 min-w-[16px] h-4 flex items-center justify-center">
            {badge > 99 ? '99+' : badge}
          </span>
        ) : null}
      </button>
    </header>
  )
}
