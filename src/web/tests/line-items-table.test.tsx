import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { LineItemsTable } from '@/routes/modules/proposals/components/LineItemsTable'
import type { EstimateLine } from '@/types/domain'

function makeLine(overrides: Partial<EstimateLine> = {}): EstimateLine {
  return {
    id: 'l-1',
    estimateId: 'e-1',
    kind: 'fixed',
    description: 'plans',
    qty: 1,
    unit: null,
    unitPrice: 100,
    lineTotal: 100,
    position: 0,
    metadata: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

describe('LineItemsTable', () => {
  it('renders an empty state when there are no lines', () => {
    render(
      <LineItemsTable
        lines={[]}
        readOnly={false}
        onLineChange={() => {}}
        onLineAdd={() => {}}
        onLineRemove={() => {}}
      />,
    )
    expect(screen.getByText('No line items')).toBeInTheDocument()
  })

  it('renders one row per line with computed line total', () => {
    render(
      <LineItemsTable
        lines={[makeLine({ qty: 2, unitPrice: 50 })]}
        readOnly={false}
        onLineChange={() => {}}
        onLineAdd={() => {}}
        onLineRemove={() => {}}
      />,
    )
    // Intl currency formatting may render as "$100.00" or "USD 100.00" depending
    // on the test runtime's locale — assert on the numeric portion.
    expect(screen.getByTestId('line-0-total').textContent).toMatch(/100\.00/)
  })

  it('emits onLineChange when the description changes', () => {
    const onLineChange = vi.fn()
    render(
      <LineItemsTable
        lines={[makeLine()]}
        readOnly={false}
        onLineChange={onLineChange}
        onLineAdd={() => {}}
        onLineRemove={() => {}}
      />,
    )
    const input = screen.getByTestId('line-0-description') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'updated' } })
    expect(onLineChange).toHaveBeenCalledWith(0, { description: 'updated' })
  })

  it('emits onLineAdd when + Line is clicked', () => {
    const onLineAdd = vi.fn()
    render(
      <LineItemsTable
        lines={[]}
        readOnly={false}
        onLineChange={() => {}}
        onLineAdd={onLineAdd}
        onLineRemove={() => {}}
      />,
    )
    fireEvent.click(screen.getByTestId('line-add'))
    expect(onLineAdd).toHaveBeenCalled()
  })

  it('emits onLineRemove when the trash icon is clicked', () => {
    const onLineRemove = vi.fn()
    render(
      <LineItemsTable
        lines={[makeLine()]}
        readOnly={false}
        onLineChange={() => {}}
        onLineAdd={() => {}}
        onLineRemove={onLineRemove}
      />,
    )
    fireEvent.click(screen.getByTestId('line-0-remove'))
    expect(onLineRemove).toHaveBeenCalledWith(0)
  })

  it('hides the + Line button and trash icon in read-only mode', () => {
    render(
      <LineItemsTable
        lines={[makeLine()]}
        readOnly={true}
        onLineChange={() => {}}
        onLineAdd={() => {}}
        onLineRemove={() => {}}
      />,
    )
    expect(screen.queryByTestId('line-add')).not.toBeInTheDocument()
    expect(screen.queryByTestId('line-0-remove')).not.toBeInTheDocument()
  })
})
