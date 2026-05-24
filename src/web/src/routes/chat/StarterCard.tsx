import { AgentAvatar } from '@/components/shared/AgentAvatar'
import { useHealth } from '@/api/health'

export interface StarterCardProps {
  /** Prefill the composer with this text. */
  onPick(text: string): void
}

const STARTERS: { label: string; text: string }[] = [
  { label: 'Show available skills', text: '/help' },
  { label: 'Summarise recent emails', text: 'Summarise the most recent emails in my inbox.' },
  { label: 'List active projects', text: 'List my active projects with their current status.' },
  { label: "What's on for today?", text: "What's on my schedule today? Anything I should action first?" },
]

export function StarterCard({ onPick }: StarterCardProps) {
  const health = useHealth()
  const profile = health.data?.agentProfile ?? ''
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-12 text-center">
      <AgentAvatar profile={profile} size="lg" />
      <div>
        <div className="text-base font-semibold text-fg">
          {profile ? `Chat with ${profile}` : 'Start a conversation'}
        </div>
        <div className="text-xs text-muted mt-1">
          Pick a prompt below or type your own — Enter to send.
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2 max-w-md">
        {STARTERS.map((s) => (
          <button
            key={s.label}
            type="button"
            onClick={() => onPick(s.text)}
            className="text-xs px-3 py-1.5 rounded-full bg-surface border border-border text-fg hover:border-accent/40 hover:bg-accent/5 transition-colors"
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  )
}
