import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { InvoiceStatusBadge } from '@/routes/modules/invoicing/components/InvoiceStatusBadge'
import { SyncStatusBadge } from '@/routes/modules/invoicing/components/SyncStatusBadge'

describe('InvoiceStatusBadge', () => {
  it('renders Draft with the muted tone', () => {
    render(<InvoiceStatusBadge status="draft" />)
    const node = screen.getByTestId('invoice-status-badge')
    expect(node).toHaveTextContent('Draft')
    expect(node.className).toMatch(/zinc/)
  })

  it('renders Partially paid for partial status', () => {
    render(<InvoiceStatusBadge status="partial" />)
    const node = screen.getByTestId('invoice-status-badge')
    expect(node).toHaveTextContent('Partially paid')
    expect(node.className).toMatch(/warn/)
  })

  it('renders Paid with the emerald tone', () => {
    render(<InvoiceStatusBadge status="paid" />)
    const node = screen.getByTestId('invoice-status-badge')
    expect(node.className).toMatch(/emerald/)
  })

  it('strikes through void', () => {
    render(<InvoiceStatusBadge status="void" />)
    expect(screen.getByTestId('invoice-status-badge').className).toMatch(/line-through/)
  })
})

describe('SyncStatusBadge', () => {
  it('renders Local only for an unpushed invoice', () => {
    render(<SyncStatusBadge status="local" hasQboId={false} />)
    const node = screen.getByTestId('sync-status-badge')
    expect(node).toHaveTextContent('Local only')
  })

  it('renders Synced with emerald', () => {
    render(<SyncStatusBadge status="synced" />)
    const node = screen.getByTestId('sync-status-badge')
    expect(node).toHaveTextContent(/Synced/)
    expect(node.className).toMatch(/emerald/)
  })

  it('renders Drift with the warn tone', () => {
    render(<SyncStatusBadge status="drift" />)
    const node = screen.getByTestId('sync-status-badge')
    expect(node).toHaveTextContent(/Drift/)
    expect(node.className).toMatch(/warn/)
  })

  it('renders Sync failed in danger tone', () => {
    render(<SyncStatusBadge status="failed" />)
    expect(screen.getByTestId('sync-status-badge').className).toMatch(/danger/)
  })
})
