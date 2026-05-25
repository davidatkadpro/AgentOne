import { describe, it, expect } from 'vitest'
import { Routes, Route, useLocation } from 'react-router-dom'
import { TestRouter as MemoryRouter } from './helpers/test-router'
import { render, screen, fireEvent } from '@testing-library/react'
import {
  isInvoiceFilter,
  FILTER_TO_STATUS,
  FILTER_TO_SYNC,
  useInvoiceDeepLink,
} from '@/routes/modules/invoicing/hooks/useInvoiceDeepLink'

function Probe() {
  const link = useInvoiceDeepLink()
  const loc = useLocation()
  return (
    <div>
      <div data-testid="filter">{link.filter}</div>
      <div data-testid="project">{link.projectId ?? ''}</div>
      <div data-testid="url">{loc.search}</div>
      <button onClick={() => link.setFilter('drift')}>drift</button>
      <button onClick={() => link.setFilter(null)}>clear</button>
    </div>
  )
}

describe('useInvoiceDeepLink', () => {
  it('reads filter and project from URL', () => {
    render(
      <MemoryRouter initialEntries={['/invoicing?filter=overdue&project=p-1']}>
        <Routes>
          <Route path="/invoicing" element={<Probe />} />
        </Routes>
      </MemoryRouter>,
    )
    expect(screen.getByTestId('filter').textContent).toBe('overdue')
    expect(screen.getByTestId('project').textContent).toBe('p-1')
  })

  it('defaults to "all" when filter is missing or unknown', () => {
    render(
      <MemoryRouter initialEntries={['/invoicing?filter=mystery']}>
        <Routes>
          <Route path="/invoicing" element={<Probe />} />
        </Routes>
      </MemoryRouter>,
    )
    expect(screen.getByTestId('filter').textContent).toBe('all')
  })

  it('setFilter writes to the URL', () => {
    render(
      <MemoryRouter initialEntries={['/invoicing']}>
        <Routes>
          <Route path="/invoicing" element={<Probe />} />
        </Routes>
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByText('drift'))
    expect(screen.getByTestId('url').textContent).toContain('filter=drift')
  })

  it('setFilter(null) clears the filter', () => {
    render(
      <MemoryRouter initialEntries={['/invoicing?filter=overdue']}>
        <Routes>
          <Route path="/invoicing" element={<Probe />} />
        </Routes>
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByText('clear'))
    expect(screen.getByTestId('url').textContent).not.toContain('filter=')
  })

  it('isInvoiceFilter narrows known values', () => {
    expect(isInvoiceFilter('draft')).toBe(true)
    expect(isInvoiceFilter('drift')).toBe(true)
    expect(isInvoiceFilter('sync_failed')).toBe(true)
    expect(isInvoiceFilter('mystery')).toBe(false)
    expect(isInvoiceFilter(null)).toBe(false)
  })

  it('FILTER_TO_STATUS / FILTER_TO_SYNC line up correctly', () => {
    expect(FILTER_TO_STATUS.draft).toEqual(['draft'])
    expect(FILTER_TO_STATUS.paid).toEqual(['paid'])
    expect(FILTER_TO_SYNC.drift).toEqual(['drift'])
    expect(FILTER_TO_SYNC.sync_failed).toEqual(['failed'])
  })
})
