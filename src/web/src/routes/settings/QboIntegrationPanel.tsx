import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { useQboStatus, useDisconnectQbo } from '@/api/qbo'
import { formatRelative } from '@/lib/time'

export function QboIntegrationPanel() {
  const { data: qbo, isLoading } = useQboStatus()
  const disconnect = useDisconnectQbo()
  const [search, setSearch] = useSearchParams()
  const [confirmOpen, setConfirmOpen] = useState(false)

  // Read ?qbo=connected|error on mount and toast accordingly, then strip.
  useEffect(() => {
    const param = search.get('qbo')
    if (!param) return
    if (param === 'connected') {
      toast.success('QuickBooks connected')
    } else if (param === 'error') {
      const reason = search.get('reason') ?? 'unknown'
      toast.error(`QuickBooks connect failed — ${reason}`)
    }
    const next = new URLSearchParams(search)
    next.delete('qbo')
    next.delete('reason')
    setSearch(next, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (isLoading || !qbo) {
    return (
      <div className="p-6 max-w-xl">
        <h2 className="text-base font-semibold mb-3">Integrations</h2>
        <div className="p-4 bg-surface border border-border rounded-md text-xs text-muted">
          Loading QuickBooks status…
        </div>
      </div>
    )
  }

  const tail = qbo.realmId ? qbo.realmId.slice(-4) : null
  const expiresSoon =
    typeof qbo.tokenExpiresAt === 'number' && qbo.tokenExpiresAt - Date.now() < 10 * 60_000

  return (
    <div className="p-6 max-w-xl">
      <h2 className="text-base font-semibold mb-3">Integrations</h2>
      <div className="bg-surface border border-border rounded-md" data-testid="qbo-panel">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div>
            <div className="text-sm font-medium text-fg">QuickBooks Online</div>
            <div className="text-xs text-muted">
              {qbo.connected ? `Connected · ${qbo.companyName ?? 'no company name'}` : 'Not connected'}
            </div>
          </div>
          {qbo.connected ? (
            <Button
              variant="danger"
              size="sm"
              onClick={() => setConfirmOpen(true)}
              data-testid="qbo-disconnect"
            >
              Disconnect
            </Button>
          ) : (
            <a
              href="/api/integrations/qbo/connect"
              className="h-9 px-3 inline-flex items-center text-sm rounded-md bg-accent text-white hover:bg-accent/90"
              data-testid="qbo-connect"
            >
              Connect
            </a>
          )}
        </div>
        {qbo.connected ? (
          <div className="px-4 py-3 text-xs space-y-1 text-muted" data-testid="qbo-details">
            <div>
              Realm · <span className="font-mono">…{tail}</span>
            </div>
            {qbo.connectedAt ? (
              <div>Connected · {formatRelative(qbo.connectedAt)}</div>
            ) : null}
            {qbo.tokenExpiresAt ? (
              <div className={expiresSoon ? 'text-warn' : ''}>
                Token expires · {new Date(qbo.tokenExpiresAt).toLocaleString()}
              </div>
            ) : null}
            {qbo.lastPushAt ? (
              <div>Last push · {formatRelative(qbo.lastPushAt)}</div>
            ) : null}
            {qbo.lastPullAt ? (
              <div>Last pull · {formatRelative(qbo.lastPullAt)}</div>
            ) : null}
            {qbo.lastError ? (
              <div className="text-danger mt-2">
                Last error · {qbo.lastError.message}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="px-4 py-3 text-xs text-muted">
            Connect to enable pushing draft invoices into QuickBooks and pulling
            payment status back into AgentOne. Push & pull are paused while
            disconnected.
          </div>
        )}
      </div>
      <Dialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Disconnect QuickBooks?"
      >
        <div className="text-sm space-y-3">
          <p>
            All push & pull operations will be paused. Invoices already pushed
            stay in QBO; AgentOne keeps its local copy with the cached QBO id.
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
              data-testid="qbo-disconnect-confirm"
            >
              Disconnect
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  )
}
