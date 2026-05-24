import { useEffect, useMemo, useState } from 'react'
import { useCommands } from '@/api/commands'
import { cn } from '@/lib/cn'

export interface SlashOverlayProps {
  open: boolean
  /** Prefix the user has typed after the leading `/`. Used to filter the list
   *  incrementally. Empty string shows everything. */
  query?: string
  onSelectCommand(name: string): void
  onClose(): void
}

export function SlashOverlay({ open, query = '', onSelectCommand, onClose }: SlashOverlayProps) {
  const commands = useCommands()
  const [selected, setSelected] = useState(0)

  const list = useMemo(() => {
    const all = commands.data ?? []
    const q = query.toLowerCase()
    if (!q) return all
    // Prefix match on name first; fall back to substring match in
    // description so `/inv` shows `invoice` and a command described as
    // "invoke X" too.
    return all.filter(
      (c) =>
        c.name.toLowerCase().startsWith(q) ||
        c.description.toLowerCase().includes(q),
    )
  }, [commands.data, query])

  // Reset cursor whenever the visible set shrinks beneath it (e.g. typing
  // narrows the list) or the overlay reopens.
  useEffect(() => {
    if (!open) {
      setSelected(0)
      return
    }
    if (selected >= list.length) setSelected(0)
  }, [open, list.length, selected])

  useEffect(() => {
    if (!open) return
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
  }, [open, list, selected, onSelectCommand, onClose])

  if (!open) return null
  return (
    <div
      data-testid="slash-overlay"
      className="absolute bottom-full left-6 right-6 mb-2 max-h-72 overflow-auto scrollbar-thin bg-surface border border-border rounded-lg shadow-xl"
    >
      <div className="mx-auto max-w-[760px]">
        {list.length === 0 ? (
          <div className="p-3 text-xs text-muted">
            {query ? `No commands match "${query}".` : 'No commands available.'}
          </div>
        ) : null}
        {list.map((cmd, idx) => (
          <button
            key={cmd.name}
            onClick={() => onSelectCommand(cmd.name)}
            onMouseEnter={() => setSelected(idx)}
            data-testid="slash-overlay-row"
            data-active={idx === selected ? 'true' : 'false'}
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
