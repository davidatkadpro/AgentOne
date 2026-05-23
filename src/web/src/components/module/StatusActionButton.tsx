import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/Button'

export interface StatusTransition {
  primary: { label: string; onClick(): void; disabled?: boolean }
  secondary: Array<{ label: string; onClick(): void; disabled?: boolean }>
}

export interface StatusActionButtonProps {
  status: string
  transitions: Record<string, StatusTransition>
}

export function StatusActionButton({ status, transitions }: StatusActionButtonProps) {
  const [open, setOpen] = useState(false)
  const t = transitions[status]
  if (!t) return null
  return (
    <div className="flex items-center">
      <Button onClick={t.primary.onClick} disabled={t.primary.disabled} className="rounded-r-none">
        {t.primary.label}
      </Button>
      {t.secondary.length > 0 ? (
        <div className="relative">
          <Button
            variant="primary"
            onClick={() => setOpen((v) => !v)}
            className="rounded-l-none border-l border-white/20 px-2"
            aria-label="More actions"
          >
            <ChevronDown size={12} />
          </Button>
          {open ? (
            <div className="absolute right-0 mt-1 z-10 min-w-48 bg-surface border border-border rounded-md shadow-lg p-1">
              {t.secondary.map((a) => (
                <button
                  key={a.label}
                  onClick={() => {
                    a.onClick()
                    setOpen(false)
                  }}
                  disabled={a.disabled}
                  className="w-full text-left px-2 py-1.5 text-xs rounded hover:bg-bg disabled:opacity-50"
                >
                  {a.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
