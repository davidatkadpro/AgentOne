import { useEffect } from 'react'
import { cn } from '@/lib/cn'
import { X } from 'lucide-react'

export interface SheetProps {
  open: boolean
  onOpenChange(open: boolean): void
  children: React.ReactNode
  title?: string
  width?: 'sm' | 'md'
}

const WIDTHS = { sm: 'w-80', md: 'w-[400px]' } as const

export function Sheet({ open, onOpenChange, children, title, width = 'md' }: SheetProps) {
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onOpenChange])

  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex" role="dialog" aria-modal="true">
      <div
        className="flex-1 bg-black/30 backdrop-blur-sm"
        onClick={() => onOpenChange(false)}
      />
      <div className={cn('h-full bg-surface border-l border-border shadow-xl flex flex-col', WIDTHS[width])}>
        <div className="flex items-center justify-between px-4 h-12 border-b border-border">
          <div className="text-sm font-semibold">{title}</div>
          <button
            onClick={() => onOpenChange(false)}
            className="text-muted hover:text-fg"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>
        <div className="flex-1 overflow-auto p-4 scrollbar-thin">{children}</div>
      </div>
    </div>
  )
}
