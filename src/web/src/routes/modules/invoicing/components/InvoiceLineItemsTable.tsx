import { Trash2, Plus } from 'lucide-react'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import type { InvoiceLine, InvoiceLineKind } from '@/types/domain'

export interface InvoiceLineItemsTableProps {
  lines: InvoiceLine[]
  readOnly: boolean
  onChange(index: number, update: Partial<InvoiceLine>): void
  onAdd(): void
  onRemove(index: number): void
}

const KINDS: InvoiceLineKind[] = ['fixed', 'time_and_materials', 'unit']

function lineTotal(qty: number, unitPrice: number): number {
  return Math.round(qty * unitPrice * 100) / 100
}

export function InvoiceLineItemsTable({
  lines,
  readOnly,
  onChange,
  onAdd,
  onRemove,
}: InvoiceLineItemsTableProps) {
  return (
    <div data-testid="invoice-line-items" className="overflow-x-auto scrollbar-thin">
      <table className="w-full min-w-[560px] text-xs">
        <thead>
          <tr className="border-b border-border text-left text-muted">
            <th className="py-1 pr-2 font-normal">Kind</th>
            <th className="py-1 pr-2 font-normal">Description</th>
            <th className="py-1 pr-2 font-normal w-16 text-right">Qty</th>
            <th className="py-1 pr-2 font-normal w-16">Unit</th>
            <th className="py-1 pr-2 font-normal w-24 text-right">Unit price</th>
            <th className="py-1 pr-2 font-normal w-24 text-right">Total</th>
            {!readOnly ? <th className="py-1 w-8" /> : null}
          </tr>
        </thead>
        <tbody>
          {lines.length === 0 ? (
            <tr>
              <td colSpan={readOnly ? 6 : 7} className="py-3 text-muted text-center">
                No line items.
              </td>
            </tr>
          ) : (
            lines.map((line, i) => (
              <tr key={line.id || i} className="border-b border-border/50">
                <td className="py-1 pr-2">
                  <select
                    disabled={readOnly}
                    value={line.kind}
                    onChange={(e) =>
                      onChange(i, { kind: e.target.value as InvoiceLineKind })
                    }
                    className="h-7 px-1 text-xs bg-bg border border-border rounded"
                    data-testid="line-kind"
                  >
                    {KINDS.map((k) => (
                      <option key={k} value={k}>
                        {k.replace(/_/g, ' ')}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="py-1 pr-2">
                  <Input
                    disabled={readOnly}
                    value={line.description}
                    onChange={(e) => onChange(i, { description: e.target.value })}
                    className="h-7 text-xs"
                    data-testid="line-desc"
                  />
                </td>
                <td className="py-1 pr-2 text-right">
                  <Input
                    disabled={readOnly}
                    type="number"
                    step="0.01"
                    value={line.qty}
                    onChange={(e) => onChange(i, { qty: Number(e.target.value) })}
                    className="h-7 text-xs text-right"
                    data-testid="line-qty"
                  />
                </td>
                <td className="py-1 pr-2">
                  <Input
                    disabled={readOnly}
                    value={line.unit ?? ''}
                    onChange={(e) =>
                      onChange(i, { unit: e.target.value || null })
                    }
                    className="h-7 text-xs"
                    data-testid="line-unit"
                  />
                </td>
                <td className="py-1 pr-2 text-right">
                  <Input
                    disabled={readOnly}
                    type="number"
                    step="0.01"
                    value={line.unitPrice}
                    onChange={(e) => onChange(i, { unitPrice: Number(e.target.value) })}
                    className="h-7 text-xs text-right"
                    data-testid="line-price"
                  />
                </td>
                <td
                  className="py-1 pr-2 text-right font-mono text-xs"
                  data-testid="line-total"
                >
                  {lineTotal(line.qty, line.unitPrice).toFixed(2)}
                </td>
                {!readOnly ? (
                  <td className="py-1 text-right">
                    <button
                      onClick={() => onRemove(i)}
                      className="text-muted hover:text-danger"
                      aria-label="Remove line"
                      data-testid="line-remove"
                    >
                      <Trash2 size={12} />
                    </button>
                  </td>
                ) : null}
              </tr>
            ))
          )}
        </tbody>
      </table>
      {!readOnly ? (
        <div className="pt-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={onAdd}
            data-testid="line-add"
          >
            <Plus size={12} /> Line
          </Button>
        </div>
      ) : null}
    </div>
  )
}
