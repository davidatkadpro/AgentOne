import { useEffect, useRef, useState } from 'react'
import { Send } from 'lucide-react'
import { toast } from 'sonner'
import { Textarea } from '@/components/ui/Input'
import { useSendMessage } from '@/api/sessions'
import { useRunCommand } from '@/api/commands'
import { SlashOverlay } from './SlashOverlay'
import { parseSlashInput } from '@/lib/slash-parser'
import { ApiError } from '@/lib/api'
import { useSessionStreamStore } from '@/stores/session-stream'
import { useComposerDraftStore } from '@/stores/composer-draft'
import { cn } from '@/lib/cn'

export interface ComposerProps {
  sessionId: string
  disabled: boolean
}

export function Composer({ sessionId, disabled }: ComposerProps) {
  const send = useSendMessage(sessionId)
  const run = useRunCommand(sessionId)
  const [text, setText] = useState('')
  const [slashOpen, setSlashOpen] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    // Auto-grow
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 200) + 'px'
  }, [text])

  // Consume any draft set by the starter card (or other surfaces) for this session.
  const draft = useComposerDraftStore((s) => s.drafts[sessionId])
  useEffect(() => {
    if (draft === undefined) return
    setText(draft)
    useComposerDraftStore.getState().consume(sessionId)
    // Focus so the user can edit or just press Enter.
    requestAnimationFrame(() => ref.current?.focus())
  }, [draft, sessionId])

  function dispatch() {
    const value = text.trim()
    if (!value) return
    if (value.startsWith('/')) {
      const parsed = parseSlashInput(value)
      run.mutate(
        { name: parsed.name, args: parsed.args, text: parsed.text },
        { onError: (err) => handleError(err) },
      )
      setText('')
      return
    }
    send.mutate(
      { text: value },
      {
        onError: (err) => handleError(err),
      },
    )
    setText('')
  }

  function handleError(err: unknown) {
    if (err instanceof ApiError && err.code === 'PROFILE_MISMATCH') {
      const requiredProfile =
        (err.details as { profile?: string } | null)?.profile ?? 'unknown'
      useSessionStreamStore.getState().setProfileMismatch(sessionId, {
        requiredProfile,
        message: err.message,
      })
      return
    }
    const message = err instanceof Error ? err.message : String(err)
    toast.error('Send failed', { description: message })
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === '/' && text === '') {
      setSlashOpen(true)
      return
    }
    if (e.key === 'Escape' && slashOpen) {
      setSlashOpen(false)
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      dispatch()
    }
  }

  const busy = send.isPending || run.isPending
  const inputDisabled = disabled || busy
  const sendDisabled = inputDisabled || !text.trim()

  return (
    <div className="px-3 md:px-6 pb-3 md:pb-4 pt-2 border-t border-border relative">
      <div className="mx-auto max-w-[760px]">
        <div
          className={cn(
            'flex items-end gap-1 rounded-xl border bg-surface px-2 py-1.5 transition-colors',
            'focus-within:border-accent focus-within:ring-1 focus-within:ring-accent/40',
            inputDisabled ? 'border-border opacity-80' : 'border-border',
          )}
        >
          <Textarea
            ref={ref}
            value={text}
            disabled={inputDisabled}
            onChange={(e) => {
              setText(e.target.value)
              if (slashOpen && !e.target.value.startsWith('/')) setSlashOpen(false)
            }}
            onKeyDown={onKeyDown}
            placeholder={disabled ? 'Restart server to message this session' : 'Type a message — Enter to send, Shift+Enter for newline'}
            rows={1}
            className="flex-1 bg-transparent border-0 focus:ring-0 px-1 py-1"
          />
          <button
            type="button"
            onClick={dispatch}
            disabled={sendDisabled}
            aria-label="Send message"
            className={cn(
              'inline-flex items-center justify-center w-10 h-10 md:w-8 md:h-8 rounded-md transition-colors shrink-0',
              sendDisabled
                ? 'bg-transparent text-muted/60 cursor-not-allowed'
                : 'bg-accent text-white hover:bg-accent/90',
            )}
          >
            <Send size={14} />
          </button>
        </div>
        <SlashOverlay
          open={slashOpen}
          query={text.startsWith('/') ? text.slice(1).split(/\s/, 1)[0] ?? '' : ''}
          onSelectCommand={(name) => {
            setText(`/${name} `)
            setSlashOpen(false)
            ref.current?.focus()
          }}
          onClose={() => setSlashOpen(false)}
        />
      </div>
    </div>
  )
}
