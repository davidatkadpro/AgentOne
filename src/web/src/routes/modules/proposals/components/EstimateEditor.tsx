import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useUpdateEstimate } from '@/api/proposals'
import type { Estimate, EstimateLine } from '@/types/domain'
import type { UpdateEstimateLineInput } from '@/types/api'
import { LineItemsTable } from './LineItemsTable'

export interface EstimateEditorProps {
  estimate: Estimate
  readOnly: boolean
  /** Required to invalidate the detail cache after a save. */
  detailIdForCache: string
}

interface Totals {
  subtotal: number
  taxPct: number
  discount: number
  total: number
}

function readTotalMetadata(estimate: Estimate): { taxPct: number; discount: number } {
  const m = estimate.metadata
  return {
    taxPct:
      typeof m.taxPct === 'number' && Number.isFinite(m.taxPct)
        ? (m.taxPct as number)
        : 0,
    discount:
      typeof m.discount === 'number' && Number.isFinite(m.discount)
        ? (m.discount as number)
        : 0,
  }
}

function computeTotals(lines: EstimateLine[], taxPct: number, discount: number): Totals {
  const subtotal = lines.reduce((sum, l) => sum + l.qty * l.unitPrice, 0)
  const taxed = subtotal * (1 + (taxPct || 0) / 100)
  const total = Math.max(0, taxed - (discount || 0))
  return { subtotal, taxPct, discount, total }
}

function fmtMoney(n: number): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
  }).format(n)
}

export function EstimateEditor({ estimate, readOnly, detailIdForCache }: EstimateEditorProps) {
  const navigate = useNavigate()
  const update = useUpdateEstimate(estimate.id, detailIdForCache)
  const [lines, setLines] = useState<EstimateLine[]>(estimate.lines)
  const initialTotals = useMemo(() => readTotalMetadata(estimate), [estimate])
  const [taxPct, setTaxPct] = useState(initialTotals.taxPct)
  const [discount, setDiscount] = useState(initialTotals.discount)
  const [dirty, setDirty] = useState(false)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Reset local state when the underlying estimate changes (e.g. after WS
  // invalidation refetches detail).
  useEffect(() => {
    setLines(estimate.lines)
    const t = readTotalMetadata(estimate)
    setTaxPct(t.taxPct)
    setDiscount(t.discount)
    setDirty(false)
  }, [estimate])

  const totals = useMemo(
    () => computeTotals(lines, taxPct, discount),
    [lines, taxPct, discount],
  )

  const scheduleSave = useCallback(
    (linesToSave: EstimateLine[], tax: number, disc: number) => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      saveTimerRef.current = setTimeout(() => {
        const body: UpdateEstimateLineInput[] = linesToSave.map((l) => ({
          id: l.id,
          kind: l.kind,
          description: l.description,
          qty: l.qty,
          unit: l.unit,
          unitPrice: l.unitPrice,
          metadata: l.metadata,
        }))
        update.mutate({
          lines: body,
          metadata: {
            ...estimate.metadata,
            taxPct: tax,
            discount: disc,
          },
        })
        setDirty(false)
      }, 500)
    },
    [estimate.metadata, update],
  )

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [])

  function markDirtyAndSchedule(
    nextLines: EstimateLine[],
    nextTax: number,
    nextDisc: number,
  ): void {
    setDirty(true)
    scheduleSave(nextLines, nextTax, nextDisc)
  }

  function handleLineChange(index: number, update: Partial<EstimateLine>): void {
    setLines((prev) => {
      const next = prev.map((l, i) => (i === index ? { ...l, ...update } : l))
      markDirtyAndSchedule(next, taxPct, discount)
      return next
    })
  }

  function handleLineAdd(): void {
    const newLine: EstimateLine = {
      id: `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      estimateId: estimate.id,
      kind: 'fixed',
      description: '',
      qty: 1,
      unit: null,
      unitPrice: 0,
      lineTotal: 0,
      position: lines.length,
      metadata: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    setLines((prev) => {
      const next = [...prev, newLine]
      markDirtyAndSchedule(next, taxPct, discount)
      return next
    })
  }

  function handleLineRemove(index: number): void {
    setLines((prev) => {
      const next = prev.filter((_, i) => i !== index)
      markDirtyAndSchedule(next, taxPct, discount)
      return next
    })
  }

  const templateName =
    typeof estimate.metadata.templateName === 'string'
      ? (estimate.metadata.templateName as string)
      : 'default'

  return (
    <div className="flex flex-col gap-3 p-3" data-testid="estimate-editor">
      <header className="flex flex-wrap items-center gap-3 text-xs">
        <button
          onClick={() => navigate(`/projects/${estimate.projectId}`)}
          className="text-accent hover:underline"
          data-testid="estimate-project-link"
        >
          Open project
        </button>
        <span className="text-muted">Version {estimate.version}</span>
        {estimate.sourceScopePath ? (
          <span
            className="text-muted truncate"
            title={estimate.sourceScopePath}
            data-testid="estimate-scope-path"
          >
            Scope: {estimate.sourceScopePath}
          </span>
        ) : null}
        <span className="text-muted" data-testid="estimate-template-name">
          Template: {templateName}
        </span>
        <span className="flex-1" />
        <span
          className="text-[11px] text-muted"
          data-testid="estimate-save-state"
          data-state={dirty ? 'saving' : update.isPending ? 'saving' : 'saved'}
        >
          {dirty || update.isPending ? 'Saving…' : 'Saved'}
        </span>
      </header>

      {readOnly ? (
        <div
          className="text-xs p-2 rounded bg-warn/10 border border-warn/40 text-warn"
          data-testid="estimate-readonly-banner"
        >
          This artifact is read-only. Revise to make changes.
        </div>
      ) : null}

      <LineItemsTable
        lines={lines}
        readOnly={readOnly}
        onLineChange={handleLineChange}
        onLineAdd={handleLineAdd}
        onLineRemove={handleLineRemove}
      />

      <footer className="grid grid-cols-2 gap-3 text-xs" data-testid="estimate-totals">
        <div className="flex flex-col gap-2">
          <label className="flex items-center justify-between gap-2">
            <span className="text-muted">Tax %</span>
            <input
              type="number"
              min={0}
              step="0.1"
              disabled={readOnly}
              value={taxPct}
              onChange={(e) => {
                const next = Number.parseFloat(e.target.value) || 0
                setTaxPct(next)
                markDirtyAndSchedule(lines, next, discount)
              }}
              data-testid="estimate-tax-pct"
              className="w-24 h-7 bg-bg border border-border rounded px-1 text-right"
            />
          </label>
          <label className="flex items-center justify-between gap-2">
            <span className="text-muted">Discount</span>
            <input
              type="number"
              min={0}
              step="0.01"
              disabled={readOnly}
              value={discount}
              onChange={(e) => {
                const next = Number.parseFloat(e.target.value) || 0
                setDiscount(next)
                markDirtyAndSchedule(lines, taxPct, next)
              }}
              data-testid="estimate-discount"
              className="w-24 h-7 bg-bg border border-border rounded px-1 text-right"
            />
          </label>
        </div>
        <div className="flex flex-col gap-1 text-right font-mono">
          <div>
            <span className="text-muted">Subtotal: </span>
            <span data-testid="estimate-subtotal">{fmtMoney(totals.subtotal)}</span>
          </div>
          <div>
            <span className="text-muted">Tax: </span>
            <span data-testid="estimate-tax">
              {fmtMoney(totals.subtotal * (taxPct / 100))}
            </span>
          </div>
          <div>
            <span className="text-muted">Discount: </span>
            <span data-testid="estimate-discount-amount">-{fmtMoney(discount)}</span>
          </div>
          <div className="text-sm font-semibold">
            <span className="text-muted">Total: </span>
            <span data-testid="estimate-total">{fmtMoney(totals.total)}</span>
          </div>
        </div>
      </footer>
    </div>
  )
}
