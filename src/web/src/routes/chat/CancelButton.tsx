import { useCancelTurn } from '@/api/sessions'
import { Button } from '@/components/ui/Button'
import { useSessionStreamStore } from '@/stores/session-stream'

export interface CancelButtonProps {
  sessionId: string
  visible: boolean
}

export function CancelButton({ sessionId, visible }: CancelButtonProps) {
  const mutation = useCancelTurn(sessionId)
  const cancelRequested = useSessionStreamStore(
    (s) => s.byId[sessionId]?.cancelRequested ?? false,
  )
  if (!visible) return null
  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={() => mutation.mutate()}
      disabled={mutation.isPending || cancelRequested}
    >
      {cancelRequested ? 'Cancelling…' : 'Cancel'}
    </Button>
  )
}
