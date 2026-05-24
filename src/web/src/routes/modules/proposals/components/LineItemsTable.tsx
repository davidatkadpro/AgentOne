import { Trash2 } from 'lucide-react'
import type { EstimateKind, EstimateLine } from '@/types/domain'

const KIND_LABELS: Record<EstimateKind, string> = {
  fixed: 'Fixed',
  time_and_materials: 'T&M',
  unit: 'Unit',
}

export interface LineItemsTableProps {
  lines: EstimateLine[]
  readOnly: boolean
  onLineChange(index: number, update: Partial<EstimateLine>): void
  onLineAdd(): void
  onLineRemove(index: number): void
}

function moneyFmt(n: number): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
  }).format(n)
}

export function LineItemsTable({
  lines,
  readOnly,
  onLineChange,
  onLineAdd,
  onLineRemove,
}: LineItemsTableProps) {
  return (
    <div className="border border-border rounded overflow-x-auto scrollbar-thin" data-testid="line-items-table">
      <table className="w-full min-w-[560px] text-xs">
        <thead className="bg-bg/40 border-b border-border text-muted">
          <tr>
            <th className="text-left px-2 py-1 w-16">Kind</th>
            <th className="text-left px-2 py-1">Description</th>
            <th className="text-right px-2 py-1 w-16">Qty</th>
            <th className="text-left px-2 py-1 w-16">Unit</th>
            <th className="text-right px-2 py-1 w-24">Unit price</th>
            <th className="text-right px-2 py-1 w-24">Line total</th>
            {readOnly ? null : <th className="px-2 py-1 w-8" />}
          </tr>
        </thead>
        <tbody>
          {lines.length === 0 ? (
            <tr>
              <td
                colSpan={readOnly ? 6 : 7}
                className="text-center text-muted italic py-3"
              >
                No line items
              </td>
            </tr>
          ) : (
            lines.map((line, i) => (
              <tr
                key={line.id}
                data-testid="line-row"
                className="border-b border-border last:border-b-0"
              >
                <td className="px-2 py-1">
                  {readOnly ? (
                    <span className="text-muted">{KIND_LABELS[line.kind]}</span>
                  ) : (
                    <select
                      value={line.kind}
                      onChange={(e) =>
                        onLineChange(i, { kind: e.target.value as EstimateKind })
                      }
                      data-testid={`line-${i}-kind`}
                      className="h-7 bg-bg border border-border rounded px-1 text-xs"
                    >
                      {Object.entries(KIND_LABELS).map(([k, v]) => (
                        <option key={k} value={k}>
                          {v}
                        </option>
                      ))}
                    </select>
                  )}
                </td>
                <td className="px-2 py-1">
                  {readOnly ? (
                    <span>{line.description}</span>
                  ) : (
                    <input
                      type="text"
                      value={line.description}
                      onChange={(e) => onLineChange(i, { description: e.target.value })}
                      data-testid={`line-${i}-description`}
                      className="w-full h-7 bg-bg border border-border rounded px-1 text-xs"
                    />
                  )}
                </td>
                <td className="px-2 py-1 text-right">
                  {readOnly ? (
                    <span>{line.qty}</span>
                  ) : (
                    <input
                      type="number"
                      min={0}
                      step="0.5"
                      value={line.qty}
                      onChange={(e) =>
                        onLineChange(i, { qty: Number.parseFloat(e.target.value) || 0 })
                      }
                      data-testid={`line-${i}-qty`}
                      className="w-16 h-7 bg-bg border border-border rounded px-1 text-xs text-right"
                    />
                  )}
                </td>
                <td className="px-2 py-1">
                  {readOnly ? (
                    <span className="text-muted">{line.unit ?? ''}</span>
                  ) : (
                    <input
                      type="text"
                      value={line.unit ?? ''}
                      onChange={(e) => onLineChange(i, { unit: e.target.value || null })}
                      placeholder="hr / sf"
                      data-testid={`line-${i}-unit`}
                      className="w-16 h-7 bg-bg border border-border rounded px-1 text-xs"
                    />
                  )}
                </td>
                <td className="px-2 py-1 text-right">
                  {readOnly ? (
                    <span>{moneyFmt(line.unitPrice)}</span>
                  ) : (
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      value={line.unitPrice}
                      onChange={(e) =>
                        onLineChange(i, { unitPrice: Number.parseFloat(e.target.value) || 0 })
                      }
                      data-testid={`line-${i}-price`}
                      className="w-24 h-7 bg-bg border border-border rounded px-1 text-xs text-right"
                    />
                  )}
                </td>
                <td
                  className="px-2 py-1 text-right font-mono"
                  data-testid={`line-${i}-total`}
                >
                  {moneyFmt(line.qty * line.unitPrice)}
                </td>
                {readOnly ? null : (
                  <td className="px-1 py-1 text-center">
                    <button
                      type="button"
                      onClick={() => onLineRemove(i)}
                      aria-label="Remove line"
                      data-testid={`line-${i}-remove`}
                      className="text-muted hover:text-danger"
                    >
                      <Trash2 size={12} />
                    </button>
                  </td>
                )}
              </tr>
            ))
          )}
        </tbody>
      </table>
      {readOnly ? null : (
        <div className="p-2 border-t border-border">
          <button
            type="button"
            onClick={onLineAdd}
            data-testid="line-add"
            className="text-xs text-accent hover:underline"
          >
            + Line
          </button>
        </div>
      )}
    </div>
  )
}
