import { useState } from 'react'
import { Bot } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useDispatchAction } from '@/api/module-actions'
import type { InvoiceDrift } from '@/types/domain'
import type { ReconcileRequest } from '@/types/api'
import { MergePicker } from './MergePicker'

export interface DriftBlockProps {
  drift: InvoiceDrift
  onResolve(req: ReconcileRequest): void
  disabled?: boolean
  /** Optional callback fired when the agent escape spawns a session. The
   *  detail route uses this to mount an InlineSessionStream below the block. */
  onAgentDispatched?(sessionId: string): void
}

function fmt(v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'number') return v.toLocaleString()
  if (typeof v === 'string') return v
  return JSON.stringify(v)
}

export function DriftBlock({ drift, onResolve, disabled, onAgentDispatched }: DriftBlockProps) {
  const [mergeOpen, setMergeOpen] = useState(false)
  const askAgent = useDispatchAction('invoicing')
  return (
    <div
      data-testid="drift-block"
      className="mt-3 border border-warn/40 bg-warn/5 rounded-md"
    >
      <div className="px-3 py-2 border-b border-warn/40 text-xs font-medium text-warn">
        ⚠ Drift detected on {drift.driftFields.length} field
        {drift.driftFields.length === 1 ? '' : 's'}
      </div>
      <div className="overflow-x-auto scrollbar-thin">
      <table className="w-full min-w-[420px] text-xs">
        <thead>
          <tr className="border-b border-warn/30 text-left text-muted">
            <th className="py-1 px-3 font-normal">Field</th>
            <th className="py-1 px-3 font-normal">Local</th>
            <th className="py-1 px-3 font-normal">QBO</th>
          </tr>
        </thead>
        <tbody>
          {drift.driftFields.map((field) => (
            <tr key={field} className="border-b border-warn/20">
              <td className="py-1 px-3 font-mono text-[11px]">{field}</td>
              <td className="py-1 px-3 font-mono text-[11px] bg-blue-500/5">
                {fmt(drift.local[field])}
              </td>
              <td className="py-1 px-3 font-mono text-[11px] bg-amber-500/5">
                {fmt(drift.qbo[field])}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      <div className="px-3 py-2 flex items-center gap-2 flex-wrap border-t border-warn/30">
        <Button
          size="sm"
          disabled={disabled}
          onClick={() => onResolve({ strategy: 'keep_local' })}
          data-testid="drift-keep-local"
        >
          Keep local (push)
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={disabled}
          onClick={() => onResolve({ strategy: 'accept_qbo' })}
          data-testid="drift-accept-qbo"
        >
          Accept QBO (pull)
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled}
          onClick={() => setMergeOpen(true)}
          data-testid="drift-custom-merge"
        >
          Custom merge…
        </Button>
        <button
          type="button"
          disabled={disabled || askAgent.isPending}
          onClick={() => {
            askAgent.mutate(
              { action: 'reconcile-drift', contextId: drift.invoiceId },
              {
                onSuccess: (res) => {
                  if (onAgentDispatched) onAgentDispatched(res.sessionId)
                },
              },
            )
          }}
          className="ml-auto inline-flex items-center gap-1 text-xs text-muted hover:text-fg underline"
          data-testid="drift-use-agent"
        >
          <Bot size={12} /> Use agent ▸
        </button>
      </div>
      {mergeOpen ? (
        <MergePicker
          drift={drift}
          onCommit={(merged) => {
            setMergeOpen(false)
            onResolve({ strategy: 'merge', merged })
          }}
          onCancel={() => setMergeOpen(false)}
        />
      ) : null}
    </div>
  )
}
