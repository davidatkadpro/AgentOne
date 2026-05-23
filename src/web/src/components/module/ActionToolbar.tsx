import { useState } from 'react'
import { Button } from '@/components/ui/Button'
import { AlertDialog } from '@/components/ui/Dialog'
import { useDispatchAction } from '@/api/module-actions'
import type { ModuleAction, ModuleActionsError } from '@/types/domain'

export interface ActionToolbarProps {
  module: string
  contextId: string
  actions: ModuleAction[]
  errors?: ModuleActionsError[]
  onDispatched(action: string, sessionId: string): void
}

export function ActionToolbar({ module, contextId, actions, errors = [], onDispatched }: ActionToolbarProps) {
  const dispatch = useDispatchAction(module)
  const [confirming, setConfirming] = useState<ModuleAction | null>(null)

  const visible = actions.filter((a) => a.surface === 'action' || a.surface === 'both')
  const primary = visible.slice(0, 3)
  const overflow = visible.slice(3)

  function run(action: ModuleAction) {
    dispatch.mutate(
      { action: action.name, contextId },
      { onSuccess: (res) => onDispatched(action.name, res.sessionId) },
    )
  }

  function maybeConfirm(action: ModuleAction) {
    if (action.requiresConfirmation) setConfirming(action)
    else run(action)
  }

  return (
    <div className="flex items-center gap-2">
      {primary.map((a) => (
        <Button key={a.name} size="sm" onClick={() => maybeConfirm(a)} disabled={dispatch.isPending}>
          {a.label}
        </Button>
      ))}
      {overflow.length > 0 ? (
        <details className="relative">
          <summary className="list-none cursor-pointer">
            <span className="inline-flex h-7 px-2 text-xs items-center rounded-md bg-surface border border-border">
              More ▾
            </span>
          </summary>
          <div className="absolute right-0 mt-1 z-10 min-w-48 bg-surface border border-border rounded-md shadow-lg p-1">
            {overflow.map((a) => (
              <button
                key={a.name}
                onClick={() => maybeConfirm(a)}
                disabled={dispatch.isPending}
                className="w-full text-left px-2 py-1 text-xs rounded hover:bg-bg"
              >
                {a.label}
              </button>
            ))}
          </div>
        </details>
      ) : null}
      {errors.length > 0 ? (
        <span className="text-[10px] text-danger" title={errors.map((e) => `${e.skill}: ${e.error}`).join('\n')}>
          {errors.length} broken
        </span>
      ) : null}
      {confirming ? (
        <AlertDialog
          open={!!confirming}
          onOpenChange={(open) => !open && setConfirming(null)}
          title={`${confirming.label}?`}
          body={confirming.description}
          confirmLabel="Run"
          onConfirm={() => {
            run(confirming)
            setConfirming(null)
          }}
        />
      ) : null}
    </div>
  )
}
