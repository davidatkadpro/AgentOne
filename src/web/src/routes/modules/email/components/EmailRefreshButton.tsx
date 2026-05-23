import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { usePollEmail } from '@/api/email'

export function EmailRefreshButton() {
  const poll = usePollEmail()
  return (
    <Button
      size="sm"
      variant="secondary"
      onClick={() => void poll.mutate()}
      disabled={poll.isPending}
      data-testid="email-refresh"
    >
      <RefreshCw size={12} className={poll.isPending ? 'animate-spin' : ''} />
      {poll.isPending ? 'Polling…' : 'Refresh'}
    </Button>
  )
}
