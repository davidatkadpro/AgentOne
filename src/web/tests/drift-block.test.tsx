import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { DriftBlock } from '@/routes/modules/invoicing/components/DriftBlock'
import type { InvoiceDrift } from '@/types/domain'

function withQuery(node: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>
}

const drift: InvoiceDrift = {
  invoiceId: 'inv-1',
  driftFields: ['total', 'dueDate'],
  local: { total: 5000, dueDate: '2026-04-30' },
  qbo: { total: 5500, dueDate: '2026-05-15' },
}

describe('DriftBlock', () => {
  it('renders each diverging field with side-by-side values', () => {
    render(withQuery(<DriftBlock drift={drift} onResolve={() => {}} />))
    expect(screen.getByTestId('drift-block')).toBeInTheDocument()
    // Field labels show as monospace code.
    expect(screen.getByText('total')).toBeInTheDocument()
    expect(screen.getByText('dueDate')).toBeInTheDocument()
  })

  it('Keep local triggers reconcile with strategy=keep_local', () => {
    const onResolve = vi.fn()
    render(withQuery(<DriftBlock drift={drift} onResolve={onResolve} />))
    fireEvent.click(screen.getByTestId('drift-keep-local'))
    expect(onResolve).toHaveBeenCalledWith({ strategy: 'keep_local' })
  })

  it('Accept QBO triggers reconcile with strategy=accept_qbo', () => {
    const onResolve = vi.fn()
    render(withQuery(<DriftBlock drift={drift} onResolve={onResolve} />))
    fireEvent.click(screen.getByTestId('drift-accept-qbo'))
    expect(onResolve).toHaveBeenCalledWith({ strategy: 'accept_qbo' })
  })

  it('Custom merge opens the merge picker', () => {
    render(withQuery(<DriftBlock drift={drift} onResolve={() => {}} />))
    fireEvent.click(screen.getByTestId('drift-custom-merge'))
    expect(screen.getByTestId('merge-picker')).toBeInTheDocument()
  })

  it('Disables resolve buttons when disabled prop is true', () => {
    render(withQuery(<DriftBlock drift={drift} onResolve={() => {}} disabled />))
    expect(screen.getByTestId('drift-keep-local')).toBeDisabled()
    expect(screen.getByTestId('drift-accept-qbo')).toBeDisabled()
  })

  it('mounts a "Use agent ▸" escape that dispatches the reconcile-drift skill', () => {
    render(withQuery(<DriftBlock drift={drift} onResolve={() => {}} />))
    const link = screen.getByTestId('drift-use-agent')
    expect(link).toHaveTextContent(/Use agent/)
  })
})

describe('MergePicker (via DriftBlock)', () => {
  it('commit fires onResolve with a merged map once every field is picked', () => {
    const onResolve = vi.fn()
    render(withQuery(<DriftBlock drift={drift} onResolve={onResolve} />))
    fireEvent.click(screen.getByTestId('drift-custom-merge'))
    fireEvent.click(screen.getByTestId('merge-local-total'))
    // Commit should still be disabled — only one of two fields picked.
    expect(screen.getByTestId('merge-commit')).toBeDisabled()
    fireEvent.click(screen.getByTestId('merge-qbo-dueDate'))
    expect(screen.getByTestId('merge-commit')).not.toBeDisabled()
    fireEvent.click(screen.getByTestId('merge-commit'))
    expect(onResolve).toHaveBeenCalledWith({
      strategy: 'merge',
      merged: { total: 5000, dueDate: '2026-05-15' },
    })
  })
})
