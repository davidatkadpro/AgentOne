import { Link } from 'react-router-dom'
import { EmptyState } from '@/components/shared/EmptyState'

export function NotFound() {
  return (
    <EmptyState
      title="Not found"
      body="That route doesn't exist."
      action={
        <Link to="/chat" className="text-accent text-xs hover:underline">
          Back to chat
        </Link>
      }
    />
  )
}
