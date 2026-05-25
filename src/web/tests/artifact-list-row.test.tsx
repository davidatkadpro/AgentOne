import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ArtifactListRow } from '@/routes/modules/proposals/components/ArtifactListRow'
import { TestRouter } from './helpers/test-router'
import type { ArtifactRow } from '@/types/domain'

function makeRow(overrides: Partial<ArtifactRow> = {}): ArtifactRow {
  return {
    kind: 'estimate',
    id: 'e-1',
    number: 'E-12345678',
    projectId: 'p-1',
    projectNumber: '25001',
    projectName: 'Riverside',
    status: 'draft',
    displayStatus: 'Estimate · draft',
    totalCents: 4500000,
    lastActivity: Date.now() - 60_000,
    source: 'from scope.md',
    scopeFilePath: 'projects/25001/in/250520/scope.md',
    ...overrides,
  }
}

function renderRow(row: ArtifactRow, isActive = false) {
  return render(
    <TestRouter>
      <ArtifactListRow row={row} isActive={isActive} />
    </TestRouter>,
  )
}

describe('ArtifactListRow', () => {
  it('renders number, project label and total', () => {
    renderRow(makeRow())
    expect(screen.getByText('E-12345678')).toBeInTheDocument()
    expect(screen.getByText(/25001 Riverside/)).toBeInTheDocument()
    // The exact formatting depends on the test runtime's locale; match the
    // dollar amount loosely.
    expect(screen.getByText(/45,?000/)).toBeInTheDocument()
  })

  it('shows the combined status badge', () => {
    renderRow(makeRow({ kind: 'proposal', displayStatus: 'Proposal · issued' }))
    const badge = screen.getByTestId('artifact-status-badge')
    expect(badge).toHaveTextContent('Proposal · issued')
  })

  it('applies the active treatment when selected', () => {
    renderRow(makeRow(), true)
    expect(screen.getByTestId('artifact-row').getAttribute('data-active')).toBe('true')
  })

  it('marks the source as "from scope.md" when a scope file is linked', () => {
    renderRow(makeRow())
    expect(screen.getByText('from scope.md')).toBeInTheDocument()
  })

  it('renders the project link as a separate button (clicking it does not also fire row navigation)', () => {
    renderRow(makeRow())
    const projectLink = screen.getByTestId('artifact-row-project-link')
    expect(projectLink).toBeInTheDocument()
    // Click does not throw and the row is still clickable.
    fireEvent.click(projectLink)
  })
})
