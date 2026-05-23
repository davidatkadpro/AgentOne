import { useState } from 'react'
import { Bot, ChevronDown } from 'lucide-react'
import { useDispatchAction } from '@/api/module-actions'
import type { ModuleAction } from '@/types/domain'

export interface AskAgentMenuProps {
  module: string
  tab: string
  contextId: string
  skills: ModuleAction[]
  onDispatched(action: string, sessionId: string): void
}

export function AskAgentMenu({ module, tab, contextId, skills, onDispatched }: AskAgentMenuProps) {
  const [open, setOpen] = useState(false)
  const dispatch = useDispatchAction(module)
  const filtered = skills.filter(
    (s) => (s.surface === 'ask_agent' || s.surface === 'both') && (s.tabs.length === 0 || s.tabs.includes(tab)),
  )
  if (filtered.length === 0) return null
  function run(action: ModuleAction) {
    dispatch.mutate(
      { action: action.name, contextId },
      { onSuccess: (res) => onDispatched(action.name, res.sessionId) },
    )
    setOpen(false)
  }
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="h-7 px-2 text-xs rounded-md bg-surface border border-border text-fg hover:bg-bg flex items-center gap-1"
      >
        <Bot size={12} /> Ask agent <ChevronDown size={10} />
      </button>
      {open ? (
        <div className="absolute right-0 mt-1 z-10 min-w-56 bg-surface border border-border rounded-md shadow-lg p-1">
          {filtered.map((a) => (
            <button
              key={a.name}
              onClick={() => run(a)}
              disabled={dispatch.isPending}
              className="w-full text-left px-2 py-1.5 text-xs rounded hover:bg-bg"
            >
              <div className="font-medium">{a.label}</div>
              <div className="text-[10px] text-muted truncate">{a.description}</div>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
