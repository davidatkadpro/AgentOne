import { describe, it, expect } from 'vitest'
import { Routes, Route, useLocation } from 'react-router-dom'
import { TestRouter as MemoryRouter } from './helpers/test-router'
import { render, screen, fireEvent } from '@testing-library/react'
import {
  isArtifactFilter,
  FILTER_TO_DISPLAY_STATUS,
  useProposalDeepLink,
} from '@/routes/modules/proposals/hooks/useProposalDeepLink'

function Probe() {
  const link = useProposalDeepLink()
  const loc = useLocation()
  return (
    <div>
      <div data-testid="filter">{link.filter}</div>
      <div data-testid="project">{link.projectId ?? ''}</div>
      <div data-testid="url">{loc.search}</div>
      <button onClick={() => link.setFilter('issued')}>set-issued</button>
      <button onClick={() => link.setFilter(null)}>clear</button>
    </div>
  )
}

describe('useProposalDeepLink', () => {
  it('reads filter and project from the URL', () => {
    render(
      <MemoryRouter initialEntries={['/proposals?filter=accepted&project=p-1']}>
        <Routes>
          <Route path="/proposals" element={<Probe />} />
        </Routes>
      </MemoryRouter>,
    )
    expect(screen.getByTestId('filter').textContent).toBe('accepted')
    expect(screen.getByTestId('project').textContent).toBe('p-1')
  })

  it('defaults to "all" when filter is missing or unknown', () => {
    render(
      <MemoryRouter initialEntries={['/proposals']}>
        <Routes>
          <Route path="/proposals" element={<Probe />} />
        </Routes>
      </MemoryRouter>,
    )
    expect(screen.getByTestId('filter').textContent).toBe('all')
  })

  it('setFilter writes the filter to the URL', () => {
    render(
      <MemoryRouter initialEntries={['/proposals']}>
        <Routes>
          <Route path="/proposals" element={<Probe />} />
        </Routes>
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByText('set-issued'))
    expect(screen.getByTestId('url').textContent).toContain('filter=issued')
  })

  it('setFilter(null) clears the filter from the URL', () => {
    render(
      <MemoryRouter initialEntries={['/proposals?filter=accepted']}>
        <Routes>
          <Route path="/proposals" element={<Probe />} />
        </Routes>
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByText('clear'))
    expect(screen.getByTestId('url').textContent).not.toContain('filter=')
  })

  it('isArtifactFilter narrows the filter values', () => {
    expect(isArtifactFilter('drafts')).toBe(true)
    expect(isArtifactFilter('issued')).toBe(true)
    expect(isArtifactFilter('mystery')).toBe(false)
    expect(isArtifactFilter(null)).toBe(false)
  })

  it('FILTER_TO_DISPLAY_STATUS covers all known display statuses', () => {
    expect(FILTER_TO_DISPLAY_STATUS.issued).toEqual(['Proposal · issued'])
    expect(FILTER_TO_DISPLAY_STATUS.accepted).toContain('Estimate · accepted')
    expect(FILTER_TO_DISPLAY_STATUS.accepted).toContain('Proposal · accepted')
    expect(FILTER_TO_DISPLAY_STATUS.superseded).toContain('Proposal · superseded')
  })
})
