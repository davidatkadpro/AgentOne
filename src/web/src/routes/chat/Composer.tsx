import { useEffect, useRef, useState } from 'react'
import { Send } from 'lucide-react'
import { toast } from 'sonner'
import { Textarea } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { useSendMessage } from '@/api/sessions'
import { useRunCommand } from '@/api/commands'
import { SlashOverlay } from './SlashOverlay'
import { parseSlashInput } from '@/lib/slash-parser'
import { ApiError } from '@/lib/api'
import { useSessionStreamStore } from '@/stores/session-stream'

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

  return (
    <div className="px-6 pb-4 pt-2 border-t border-border relative">
      <div className="mx-auto max-w-[760px]">
        <div className="flex items-end gap-2">
          <Textarea
            ref={ref}
            value={text}
            disabled={disabled || send.isPending || run.isPending}
            onChange={(e) => {
              setText(e.target.value)
              if (slashOpen && !e.target.value.startsWith('/')) setSlashOpen(false)
            }}
            onKeyDown={onKeyDown}
            placeholder={disabled ? 'Restart server to message this session' : 'Type a message — Enter to send, Shift+Enter for newline'}
            rows={1}
            className="flex-1"
          />
          <Button
            onClick={dispatch}
            disabled={disabled || !text.trim() || send.isPending || run.isPending}
            aria-label="Send message"
          >
            <Send size={14} />
          </Button>
        </div>
        <SlashOverlay
          open={slashOpen}
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
