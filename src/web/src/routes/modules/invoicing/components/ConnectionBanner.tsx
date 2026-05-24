import { Link } from 'react-router-dom'
import { AlertTriangle } from 'lucide-react'
import type { QboConnection } from '@/types/domain'

export interface ConnectionBannerProps {
  qbo: QboConnection
}

/** Renders only when QBO is unconfigured/disconnected/expired. Otherwise null. */
export function ConnectionBanner({ qbo }: ConnectionBannerProps) {
  const expired =
    qbo.connected && typeof qbo.tokenExpiresAt === 'number' && qbo.tokenExpiresAt < Date.now()
  if (qbo.connected && !expired) return null
  const body = expired
    ? 'Your QuickBooks session has expired. Push & pull are paused.'
    : 'QuickBooks is disconnected. Push & pull are paused.'
  return (
    <div
      data-testid="connection-banner"
      className="px-3 py-2 flex items-center gap-2 bg-warn/10 text-warn border-b border-warn/40 text-xs"
    >
      <AlertTriangle size={14} />
      <span>{body}</span>
      <Link
        to="/settings?tab=integrations"
        className="ml-auto underline hover:text-fg"
        data-testid="connection-banner-reconnect"
      >
        {expired ? 'Reconnect' : 'Connect'} in Settings →
      </Link>
    </div>
  )
}
