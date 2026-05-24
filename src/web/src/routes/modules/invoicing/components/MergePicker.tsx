import { useState } from 'react'
import { Button } from '@/components/ui/Button'
import type { InvoiceDrift } from '@/types/domain'

export interface MergePickerProps {
  drift: InvoiceDrift
  onCommit(merged: Record<string, unknown>): void
  onCancel(): void
}

type Side = 'local' | 'qbo'

function fmt(v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'number') return v.toLocaleString()
  if (typeof v === 'string') return v
  return JSON.stringify(v)
}

/** Per-field local/qbo selector. Commit is enabled only when every field has
 *  a side chosen — partial merges produce confusing reconciles. */
export function MergePicker({ drift, onCommit, onCancel }: MergePickerProps) {
  const [picks, setPicks] = useState<Record<string, Side | null>>(() =>
    Object.fromEntries(drift.driftFields.map((f) => [f, null])),
  )
  const ready = Object.values(picks).every((v) => v !== null)
  function commit() {
    const merged: Record<string, unknown> = {}
    for (const field of drift.driftFields) {
      const side = picks[field]
      if (!side) continue
      merged[field] = side === 'local' ? drift.local[field] : drift.qbo[field]
    }
    onCommit(merged)
  }
  return (
    <div
      data-testid="merge-picker"
      className="px-3 py-3 border-t border-warn/30 bg-surface"
    >
      <div className="text-xs font-medium mb-2">Pick a side for each field</div>
      <div className="space-y-1">
        {drift.driftFields.map((field) => (
          <div key={field} className="flex items-center gap-2 text-xs">
            <div className="font-mono w-40 truncate">{field}</div>
            <label className="flex items-center gap-1 cursor-pointer">
              <input
                type="radio"
                name={`merge-${field}`}
                checked={picks[field] === 'local'}
                onChange={() => setPicks((p) => ({ ...p, [field]: 'local' }))}
                data-testid={`merge-local-${field}`}
              />
              <span className="font-mono text-[11px]">{fmt(drift.local[field])}</span>
            </label>
            <label className="flex items-center gap-1 cursor-pointer">
              <input
                type="radio"
                name={`merge-${field}`}
                checked={picks[field] === 'qbo'}
                onChange={() => setPicks((p) => ({ ...p, [field]: 'qbo' }))}
                data-testid={`merge-qbo-${field}`}
              />
              <span className="font-mono text-[11px]">{fmt(drift.qbo[field])}</span>
            </label>
          </div>
        ))}
      </div>
      <div className="pt-3 flex items-center gap-2">
        <Button
          size="sm"
          disabled={!ready}
          onClick={commit}
          data-testid="merge-commit"
        >
          Commit merge
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
