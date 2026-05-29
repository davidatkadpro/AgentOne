import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { useM365Status, useDisconnectM365 } from '@/api/m365'
import { formatRelative } from '@/lib/time'

export function M365IntegrationPanel() {
  const { data: m365, isLoading } = useM365Status()
  const disconnect = useDisconnectM365()
  const [search, setSearch] = useSearchParams()
  const [confirmOpen, setConfirmOpen] = useState(false)

  // Read ?m365=connected|error on mount and toast accordingly, then strip.
  useEffect(() => {
    const param = search.get('m365')
    if (!param) return
    if (param === 'connected') {
      toast.success('Microsoft 365 connected')
    } else if (param === 'error') {
      const reason = search.get('reason') ?? 'unknown'
      toast.error(`Microsoft 365 connect failed — ${reason}`)
    }
    const next = new URLSearchParams(search)
    next.delete('m365')
    next.delete('reason')
    setSearch(next, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (isLoading || !m365) {
    return (
      <div className="p-4 bg-surface border border-border rounded-md text-xs text-muted">
        Loading Microsoft 365 status…
      </div>
    )
  }

  const expiresSoon =
    typeof m365.tokenExpiresAt === 'number' && m365.tokenExpiresAt - Date.now() < 10 * 60_000

  return (
    <>
      <div className="bg-surface border border-border rounded-md" data-testid="m365-panel">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div>
            <div className="text-sm font-medium text-fg">Microsoft 365 Email</div>
            <div className="text-xs text-muted">
              {m365.connected
                ? `Connected · ${m365.accountEmail ?? m365.accountName ?? 'account'}`
                : 'Not connected'}
            </div>
          </div>
          {m365.connected ? (
            <Button
              variant="danger"
              size="sm"
              onClick={() => setConfirmOpen(true)}
              data-testid="m365-disconnect"
            >
              Disconnect
            </Button>
          ) : (
            <a
              href="/api/integrations/m365/connect"
              className="h-9 px-3 inline-flex items-center text-sm rounded-md bg-accent text-white hover:bg-accent/90"
              data-testid="m365-connect"
            >
              Connect
            </a>
          )}
        </div>
        {m365.connected ? (
          <div className="px-4 py-3 text-xs space-y-1 text-muted" data-testid="m365-details">
            {m365.accountName ? <div>Account · {m365.accountName}</div> : null}
            {m365.connectedAt ? (
              <div>Connected · {formatRelative(m365.connectedAt)}</div>
            ) : null}
            {m365.tokenExpiresAt ? (
              <div className={expiresSoon ? 'text-warn' : ''}>
                Token expires · {new Date(m365.tokenExpiresAt).toLocaleString()}
              </div>
            ) : null}
            {m365.lastPollAt ? <div>Last poll · {formatRelative(m365.lastPollAt)}</div> : null}
            {m365.lastError ? (
              <div className="text-danger mt-2">Last error · {m365.lastError.message}</div>
            ) : null}
          </div>
        ) : (
          <div className="px-4 py-3 text-xs text-muted">
            Connect your Microsoft 365 mailbox to triage real email into AgentOne.
            Read-only — AgentOne lists, reads, and files messages but never sends
            mail. Requires <span className="font-mono">EMAIL_SOURCE=graph</span> to
            be the active source.
          </div>
        )}
      </div>
      <Dialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Disconnect Microsoft 365?"
      >
        <div className="text-sm space-y-3">
          <p>
            Email polling will stop and stored tokens will be cleared. Emails
            already filed to projects stay where they are; AgentOne keeps its
            local index. Reconnect any time to resume.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                await disconnect.mutateAsync()
                setConfirmOpen(false)
              }}
              data-testid="m365-disconnect-confirm"
            >
              Disconnect
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  )
}
