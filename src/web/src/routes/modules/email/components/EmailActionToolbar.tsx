import { ActionToolbar } from '@/components/module/ActionToolbar'
import { useModuleActions } from '@/api/module-actions'

export interface EmailActionToolbarProps {
  emailId: string
  onSessionSpawned(sessionId: string): void
}

export function EmailActionToolbar({ emailId, onSessionSpawned }: EmailActionToolbarProps) {
  const actions = useModuleActions('email')
  return (
    <div className="border-b border-border px-3 py-2 flex items-center gap-2">
      <ActionToolbar
        module="email"
        contextId={emailId}
        actions={actions.data?.actions ?? []}
        errors={actions.data?.errors ?? []}
        onDispatched={(_action, sessionId) => onSessionSpawned(sessionId)}
      />
    </div>
  )
}
