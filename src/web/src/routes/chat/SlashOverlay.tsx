import { useEffect, useState } from 'react'
import { useCommands } from '@/api/commands'
import { cn } from '@/lib/cn'

export interface SlashOverlayProps {
  open: boolean
  onSelectCommand(name: string): void
  onClose(): void
}

export function SlashOverlay({ open, onSelectCommand, onClose }: SlashOverlayProps) {
  const commands = useCommands()
  const [selected, setSelected] = useState(0)

  useEffect(() => {
    if (!open) setSelected(0)
  }, [open])

  useEffect(() => {
    if (!open) return
    const list = commands.data ?? []
    function onKey(e: KeyboardEvent) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelected((s) => Math.min(list.length - 1, s + 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelected((s) => Math.max(0, s - 1))
      } else if (e.key === 'Enter') {
        const cmd = list[selected]
        if (cmd) {
          e.preventDefault()
          onSelectCommand(cmd.name)
        }
      } else if (e.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, commands.data, selected, onSelectCommand, onClose])

  if (!open) return null
  const list = commands.data ?? []
  return (
    <div className="absolute bottom-full left-6 right-6 mb-2 max-h-72 overflow-auto scrollbar-thin bg-surface border border-border rounded-lg shadow-xl">
      <div className="mx-auto max-w-[760px]">
        {list.length === 0 ? (
          <div className="p-3 text-xs text-muted">No commands available.</div>
        ) : null}
        {list.map((cmd, idx) => (
          <button
            key={cmd.name}
            onClick={() => onSelectCommand(cmd.name)}
            onMouseEnter={() => setSelected(idx)}
            className={cn(
              'w-full text-left px-3 py-2 flex items-baseline gap-2 text-xs',
              idx === selected ? 'bg-bg' : 'hover:bg-bg',
            )}
          >
            <span className="font-mono font-medium text-fg">/{cmd.name}</span>
            <span className="text-muted truncate">{cmd.description}</span>
            <span className="ml-auto text-[10px] uppercase text-muted">{cmd.source}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
