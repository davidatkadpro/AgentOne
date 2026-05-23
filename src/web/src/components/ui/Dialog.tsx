import { useEffect } from 'react'
import { X } from 'lucide-react'

export interface DialogProps {
  open: boolean
  onOpenChange(open: boolean): void
  children: React.ReactNode
  title?: string
}

export function Dialog({ open, onOpenChange, children, title }: DialogProps) {
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
    <div className="fixed inset-0 z-50 flex items-center justify-center" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/40" onClick={() => onOpenChange(false)} />
      <div className="relative w-[440px] max-w-[90vw] bg-surface border border-border rounded-lg shadow-xl flex flex-col">
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
        <div className="p-4">{children}</div>
      </div>
    </div>
  )
}

export interface AlertDialogProps {
  open: boolean
  onOpenChange(open: boolean): void
  title: string
  body: string
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
  onConfirm(): void
}

export function AlertDialog({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive,
  onConfirm,
}: AlertDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title}>
      <p className="text-sm text-muted mb-4">{body}</p>
      <div className="flex gap-2 justify-end">
        <button
          onClick={() => onOpenChange(false)}
          className="h-9 px-3 text-sm rounded-md bg-surface border border-border hover:bg-bg"
        >
          {cancelLabel}
        </button>
        <button
          onClick={() => {
            onConfirm()
            onOpenChange(false)
          }}
          className={
            destructive
              ? 'h-9 px-3 text-sm rounded-md bg-danger text-white hover:opacity-90'
              : 'h-9 px-3 text-sm rounded-md bg-accent text-white hover:opacity-90'
          }
        >
          {confirmLabel}
        </button>
      </div>
    </Dialog>
  )
}
