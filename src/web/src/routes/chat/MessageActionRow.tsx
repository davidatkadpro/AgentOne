import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check, Copy, GitBranch, Info, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { useCreateSession, useSendMessage } from '@/api/sessions'
import { useSessionStreamStore, type RecallSource } from '@/stores/session-stream'
import { cn } from '@/lib/cn'

export interface MessageActionRowProps {
  sessionId: string
  turnId: string
  /** Plain-text content of the assistant turn (for copy). */
  content: string
  recallSources: RecallSource[]
}

export function MessageActionRow({
  sessionId,
  turnId,
  content,
  recallSources,
}: MessageActionRowProps) {
  const [copied, setCopied] = useState(false)
  const [infoOpen, setInfoOpen] = useState(false)
  const send = useSendMessage(sessionId)
  const createSession = useCreateSession()
  const navigate = useNavigate()

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (err) {
      toast.error('Copy failed', {
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }

  function onRetry() {
    // Find the user turn immediately before this assistant turn and resend
    // its text. This appends a new pair rather than rewriting the existing
    // assistant turn — the backend doesn't support in-place regeneration yet.
    const stream = useSessionStreamStore.getState().byId[sessionId]
    if (!stream) return
    const idx = stream.turns.findIndex((t) => t.id === turnId)
    if (idx <= 0) {
      toast.error('No prior user message to retry')
      return
    }
    // Walk backwards to the most recent user turn (skip over any tool/system
    // turns that happen to be interleaved).
    let userTurn: typeof stream.turns[number] | null = null
    for (let i = idx - 1; i >= 0; i--) {
      if (stream.turns[i].role === 'user') {
        userTurn = stream.turns[i]
        break
      }
    }
    if (!userTurn) {
      toast.error('No prior user message to retry')
      return
    }
    send.mutate({ text: userTurn.content })
  }

  function onBranch() {
    const preview = content.slice(0, 120).replace(/\s+/g, ' ').trim()
    createSession.mutate(
      {
        title: null,
        seed: {
          spawnedBy: `chat/${sessionId}/turn/${turnId}`,
          initialMessage: `Continuing from a prior assistant message:\n\n> ${preview}${content.length > 120 ? '…' : ''}`,
        },
      },
      {
        onSuccess: (res) => navigate(`/chat/${res.session.id}`),
        onError: (err) => {
          toast.error('Branch failed', {
            description: err instanceof Error ? err.message : String(err),
          })
        },
      },
    )
  }

  const hasRecall = recallSources.length > 0

  return (
    <div className="pl-3">
      <div className="flex items-center gap-1 text-muted">
        <ActionButton
          icon={copied ? <Check size={12} /> : <Copy size={12} />}
          label={copied ? 'Copied' : 'Copy'}
          onClick={onCopy}
        />
        {hasRecall ? (
          <button
            type="button"
            onClick={() => setInfoOpen((v) => !v)}
            aria-expanded={infoOpen}
            aria-label={`Show ${recallSources.length} context source${recallSources.length === 1 ? '' : 's'}`}
            title="Context sources injected for this turn"
            className={cn(
              'inline-flex items-center gap-1 h-7 px-2 text-[11px] rounded-md transition-colors',
              infoOpen
                ? 'bg-accent/10 text-accent'
                : 'hover:bg-surface hover:text-fg',
            )}
          >
            <Info size={12} />
            <span className="font-mono">({recallSources.length})</span>
          </button>
        ) : null}
        <ActionButton
          icon={<RotateCcw size={12} />}
          label="Retry"
          title="Re-send the previous user message"
          onClick={onRetry}
          disabled={send.isPending}
        />
        <ActionButton
          icon={<GitBranch size={12} />}
          label="Branch"
          title="Start a new session from this message"
          onClick={onBranch}
          disabled={createSession.isPending}
        />
      </div>
      {infoOpen && hasRecall ? (
        <div className="mt-1 text-[11px] text-muted bg-surface border border-border rounded-md p-2 space-y-1">
          <div className="text-[10px] uppercase tracking-wide text-muted/80">
            Context sources
          </div>
          {recallSources.map((s, i) => (
            <div key={`${s.kind}-${s.ref}-${i}`} className="flex items-start gap-2 min-w-0">
              <span className="text-[9px] uppercase shrink-0 text-muted/70 mt-0.5">
                {s.kind}
              </span>
              <span className="flex-1 min-w-0 truncate" title={s.ref}>
                {s.title || s.ref}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

interface ActionButtonProps {
  icon: React.ReactNode
  label: string
  title?: string
  onClick(): void
  disabled?: boolean
}

function ActionButton({ icon, label, title, onClick, disabled }: ActionButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title ?? label}
      aria-label={label}
      className={cn(
        'inline-flex items-center gap-1 h-7 px-2 text-[11px] rounded-md transition-colors',
        disabled
          ? 'text-muted/40 cursor-not-allowed'
          : 'hover:bg-surface hover:text-fg',
      )}
    >
      {icon}
      <span className="hidden md:inline">{label}</span>
    </button>
  )
}
